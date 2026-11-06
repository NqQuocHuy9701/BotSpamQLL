// Bee AI (Groq) - cho phép nói chuyện tự nhiên thay vì gõ lệnh /.
//
// NGUYÊN TẮC (bot đang chạy thật):
//  - Mặc định TẮT: thiếu AI_ENABLED=true hoặc GROQ_API_KEY thì loadAiConfig trả
//    undefined và mọi hàm ở đây không làm gì (bot y hệt cũ).
//  - Chỉ ĐỌC dữ liệu (check-in, báo cáo, case treo). Không có lệnh ghi/sửa.
//  - AI chỉ PHÂN LOẠI ý định (+ 1 câu xã giao). Số liệu luôn do hàm có sẵn dựng,
//    AI không tự viết số liệu.
//  - Tiết kiệm hạn mức: quy tắc từ khóa + câu xã giao có sẵn xử lý trước, chỉ câu
//    còn lại mới gọi Groq; có trần lượt/ngày và cooldown theo người dùng.
//  - Mọi lỗi (mạng, 429, JSON hỏng, DB) đều nuốt: không bao giờ làm hỏng webhook.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "./telegram.js";
import type { TelegramMessage } from "./types.js";
import { isSensitive } from "./detector.js";
import { pickIndex } from "./messages.js";
import {
  buildCheckinList,
  buildHelpText,
  buildShiftReport,
  getCurrentShiftCheckins,
  htktCaseKey,
  loadMonitorConfig,
} from "./monitor.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const DEFAULT_BOT_USERNAME = "vh_messenger_bot";
const DEFAULT_DAILY_CAP = 300;
const MAX_DAILY_CAP = 900; // Groq free ~1.000 request/ngày -> chừa dư
const COOLDOWN_MS = 5000; // cách nhau tối thiểu giữa 2 lượt của 1 người (không áp cho admin)
const MAX_QUESTION_CHARS = 300;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const QLL_LINK_ID = "2273179613"; // id nhóm QLL bỏ tiền tố -100 (link t.me/c/...)
const HTKT_LINK_ID = "2458492731"; // id nhóm HTKT bỏ tiền tố -100

export type Intent =
  | "checkin"
  | "baocao"
  | "casetreo"
  | "help"
  | "chat"
  | "checkout"
  | "hentag"
  | "nhacnhom"
  | "daynho"
  | "xemnho"
  | "quennho"
  | "hanmuc";
const INTENTS: readonly Intent[] = [
  "checkin",
  "baocao",
  "casetreo",
  "help",
  "chat",
  "checkout",
  "hentag",
  "nhacnhom",
  "daynho",
  "xemnho",
  "quennho",
  "hanmuc",
];

// Câu dẫn trước số liệu (có sẵn, không tốn lượt AI).
const LEAD: readonly string[] = [
  "Có ngay đây ạ 😊",
  "Em gửi {title} nè 😊",
  "Đây ạ, {title} xem giúp em nhé 😊",
  "Của {title} đây 😊",
];
const CHECKOUT_REPLY: readonly string[] = [
  "Dạ Bee chưa theo dõi được check-out ạ, {title} xem trong nhóm check-in giúp em nhé 🥺",
  "Dạ phần check-out em chưa có dữ liệu ạ, em chỉ xem được ai đã check-in thôi ạ 🥺",
];
function lead(title: string, rng: () => number = Math.random): string {
  return LEAD[pickIndex(LEAD.length, undefined, rng)].replace(/\{title\}/g, title);
}

export interface AiConfig {
  apiKey: string;
  model: string;
  agentModel: string; // model trò chuyện 2 chiều + công cụ (admin)
  maxCompletionTokens: number; // trần output mỗi lần gọi (gồm cả suy luận ngắn)
  botToken?: string; // chỉ để hiện "đang nhập..." (sendChatAction) khi chờ AI
  botUsername: string; // không có @, lowercase
  dailyCap: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch; // chỉ để test
}

// Phần Deps mà module này cần (Deps của handler gán được trực tiếp).
export interface AiDeps {
  telegram: TelegramClient;
  supabase: SupabaseClient;
  checkinSupabase?: SupabaseClient;
  ai?: AiConfig;
}

// Hiện "Tiểu Bee đang nhập..." trong lúc chờ AI. Telegram tự tắt sau ~5s hoặc khi
// bot gửi tin, nên nhắc lại mỗi 4s. Không tốn lượt Groq; lỗi thì bỏ qua (chỉ là
// hiệu ứng). Trả hàm dừng. Không có botToken -> không làm gì.
export function startTyping(ai: AiConfig, message: TelegramMessage): () => void {
  if (!ai.botToken) return () => {};
  const body: Record<string, unknown> = { chat_id: message.chat.id, action: "typing" };
  if (message.message_thread_id !== undefined) body.message_thread_id = message.message_thread_id;
  const url = `https://api.telegram.org/bot${ai.botToken}/sendChatAction`;
  const ping = () => {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  ping();
  const timer = setInterval(ping, 4000);
  return () => clearInterval(timer);
}

function clampInt(v: string | undefined, def: number, lo: number, hi: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
}

export function loadAiConfig(
  env: Record<string, string | undefined> = process.env
): AiConfig | undefined {
  if ((env.AI_ENABLED ?? "").trim().toLowerCase() !== "true") return undefined;
  const apiKey = (env.GROQ_API_KEY ?? "").trim();
  if (apiKey === "") return undefined;
  const cap = Number.parseInt((env.AI_DAILY_CAP ?? "").trim(), 10);
  return {
    apiKey,
    model: (env.GROQ_MODEL ?? "").trim() || DEFAULT_MODEL,
    agentModel: (env.GROQ_AGENT_MODEL ?? "").trim() || "openai/gpt-oss-120b",
    botUsername: ((env.BOT_USERNAME ?? "").trim() || DEFAULT_BOT_USERNAME)
      .replace(/^@/, "")
      .toLowerCase(),
    dailyCap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, MAX_DAILY_CAP) : DEFAULT_DAILY_CAP,
    // webhook Vercel ~10s -> mỗi lần gọi AI tối đa GROQ_TIMEOUT ms (1000-8000)
    timeoutMs: clampInt(env.GROQ_TIMEOUT, 5000, 1000, 8000),
    maxCompletionTokens: clampInt(env.GROQ_MAX_COMPLETION_TOKENS, 300, 100, 800),
    botToken: (env.BOT_TOKEN ?? "").trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// Tiền xử lý văn bản (không tốn lượt AI)
// ---------------------------------------------------------------------------

// Bỏ dấu tiếng Việt, về chữ thường, thay ký tự lạ bằng khoảng trắng.
export function foldVi(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Nhận diện ý định bằng từ khóa. null = không chắc -> mới cần hỏi AI.
// Câu hỏi phân tích/so sánh số liệu: cần AI đọc dữ liệu rồi trả lời bằng lời.
const ANALYTIC_RE =
  /(nhieu nhat|it nhat|cao nhat|thap nhat|bao nhieu|so sanh|tai sao|vi sao|ban nhat|dung dau|\bai\b.*(xu ly|lam|top|tot|cham)|nhan xet|danh gia|the nao|ra sao)/;

// Có cần AI hiểu câu này (thay vì luật từ khóa) không — chỉ áp cho admin.
export function needsAiUnderstanding(intent: Intent, raw: string): boolean {
  if (intent === "nhacnhom" || intent === "hentag") return true; // hành động đăng vào nhóm
  if (intent === "xemnho" || intent === "quennho" || intent === "daynho") return false;
  const s = ` ${raw.normalize("NFC").toLowerCase().replace(/[,.!?;:()"']/g, " ")} `;
  // JS \b không nhận chữ có dấu -> dùng khoảng trắng làm ranh giới từ.
  const has = (words: string) => new RegExp(` (${words}) `).test(s);
  return (
    /@[a-z0-9_]{3,}/i.test(s) || // nhắc tới 1 người cụ thể
    /\d{3,}/.test(s) || // mã case / mã HS
    /[a-z_]+\.\d{4}\.\d{3,4}/i.test(s) || // mã lớp
    has("tag|nhắn|nhắc|đăng|gửi vào|gửi lên") || // ra lệnh hành động
    has("(?:anh|chị|bạn|em|người|case|nhóm|cái|tin|bên) (?:ý|ấy|đó|này|kia|nọ)") || // đại từ
    / (còn|thế còn|vậy còn) .*(thì sao|sao) /.test(s) // câu nối tiếp
  );
}

// Lệnh bộ nhớ: đọc câu CÒN DẤU (vì "nhớ" và "nhờ" bỏ dấu đều thành "nho").
export function classifyMemory(raw: string): Intent | null {
  const s = raw.normalize("NFC").toLowerCase().trim().replace(/^bee[\s,]+/, "");
  if (/(nhớ|học)( được)? (gì|những gì)|^(xem|liệt kê) (ghi nhớ|lời dạy)/.test(s)) {
    return "xemnho";
  }
  if (/^(quên|xóa|xoá) (hết|số|lời dạy|ghi nhớ|\d)|^quên\s*\d/.test(s)) return "quennho";
  const end = "(?=[\\s:：,.!-]|$)"; // \b của JS không nhận chữ có dấu
  if (
    new RegExp(`^(hãy |em )?(nhớ|ghi nhớ|học(?! sinh| viên| bài))${end}`).test(s) ||
    new RegExp(`^(từ giờ|từ nay|lần sau|về sau)${end}`).test(s)
  ) {
    return "daynho";
  }
  return null;
}

export function classifyByRules(folded: string): Intent | null {
  // Hỏi hạn mức/credit hệ thống: TypeScript trả lời, không tốn AI.
  if (
    /\b(credit|credits|quota|han muc|rate limit|token|groq)\b/.test(folded) ||
    /\b(het|con|bao nhieu|so) luot (ai|goi|hoi|cua bee|bee)\b|\bluot ai\b|\bbee het luot\b/.test(folded)
  ) {
    return "hanmuc";
  }
  // Dặn Bee: đến ca chiều thì tag CTV ca chiều xử lý case tồn.
  if (
    /\b(tag|goi|nhac|nho|giao)\b.*\bctv\b.*\bca chieu\b/.test(folded) ||
    /\bca chieu\b.*\b(tag|goi|nhac|nho|giao)\b.*\bctv\b/.test(folded) ||
    /\b(den|khi|vao|luc|sau)\b.*\bca chieu\b.*\b(tag|goi|nhac|giao)\b/.test(folded) ||
    /\bchieu\b.*\b(tag|goi|nhac|giao)\b.*\bctv\b/.test(folded)
  ) {
    return "hentag";
  }
  // Nhắn/nhắc thẳng vào nhóm ("nhắn nhóm HTKT"): đăng case tồn + tag CTV đang trực.
  if (
    /\b(nhan|nhac|tag|goi)\b.*\b(nhom|group)\b.*\b(qll|htkt)\b|\b(nhan|nhac|tag|goi)\b.*\b(qll|htkt)\b/.test(folded) &&
    !/\b(cho|gui)\s+(a|anh|e|em|chi)\b/.test(folded)
  ) {
    return "nhacnhom";
  }
  // "Đổi câu nhắc: ..." -> đăng lại với câu admin đưa.
  if (/\b(doi|sua|thay) cau\b/.test(folded)) return "nhacnhom";
  if (ANALYTIC_RE.test(folded) && !/\b(truc|check ?in|checkin|diem danh)\b/.test(folded)) return null;
  // Bee chưa có dữ liệu check-out: trả lời thẳng thay vì nhả danh sách check-in.
  if (/\b(check ?out|checkout|tan ca|het ca|ve ca)\b/.test(folded)) return "checkout";
  if (/\b(bao cao|thong ke|hieu suat|kpi|xep hang)\b/.test(folded)) return "baocao";
  if (
    /\b(ton|treo)\b.*\b(qll|htkt)\b|\b(qll|htkt)\b.*\b(ton|treo)\b/.test(folded) ||
    /\b(case|ca)\b.*\b(treo|ton|chua xu ly|chua ai|chua rep|chua react|miss)\b/.test(folded) ||
    /\b(chua xu ly|case treo|case ton|con case|bi miss)\b/.test(folded)
  ) {
    return "casetreo";
  }
  if (
    /\b(ai|nhung ai|danh sach|ds)\b.*\b(truc|check ?in|diem danh)\b/.test(folded) ||
    /\b(dang truc|check ?in|checkin|diem danh)\b/.test(folded)
  ) {
    return "checkin";
  }
  if (/\b(lam duoc gi|giup duoc gi|biet lam gi|huong dan|cach dung|lenh|menu|help)\b/.test(folded)) {
    return "help";
  }
  return null;
}

const GREET: readonly string[] = [
  "Em đây, {title} cần gì ạ? 😊",
  "Bee nghe nè, {title} cứ nói nhé 😊",
  "Chào {title}, hôm nay cần em xem gì không ạ? 😊",
];
const THANKS: readonly string[] = [
  "Không có gì ạ, cần gì {title} cứ gọi em 😊",
  "Dạ, có gì {title} cứ nhắn em nhé 😊",
];
const ACK: readonly string[] = [
  "Vâng ạ 😊",
  "Ok ạ, cần gì {title} cứ gọi Bee nhé 😊",
];

// Câu xã giao thường gặp: trả lời có sẵn, KHÔNG tốn lượt AI.
export function cannedChat(
  folded: string,
  title: string,
  rng: () => number = Math.random
): string | null {
  let pool: readonly string[] | null = null;
  if (
    folded === "" ||
    /^(hi|hello|helo|hey|alo|chao|xin chao|bee|bee oi|ong oi|chao bee|hi bee|hello bee)$/.test(folded)
  ) {
    pool = GREET;
  } else if (/^(cam on|thanks|thank you|tks|cam on bee|cam on em|ok cam on)\b/.test(folded)) {
    pool = THANKS;
  } else if (/^(ok|oke|okie|da|vang|duoc roi)$/.test(folded)) {
    pool = ACK;
  }
  if (!pool) return null;
  return pool[pickIndex(pool.length, undefined, rng)].replace(/\{title\}/g, title);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tin có tag bot không; trả về phần câu hỏi đã bỏ @bot.
export function extractMention(
  text: string,
  botUsername: string
): { mentioned: boolean; question: string } {
  const src = `@${escapeRe(botUsername)}(?![A-Za-z0-9_])`;
  if (!new RegExp(src, "i").test(text)) return { mentioned: false, question: "" };
  return {
    mentioned: true,
    question: text.replace(new RegExp(src, "gi"), " ").replace(/\s+/g, " ").trim(),
  };
}

// Làm sạch câu AI trả: bỏ @ (không cho AI tag ai), bỏ link, cắt gọn.
export function sanitizeReply(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

// Đọc JSON AI trả về; chấp nhận có chữ thừa quanh JSON. Sai định dạng -> null.
export function parseGroqJson(
  content: string | null | undefined
): { intent: Intent; reply: string } | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(content.slice(start, end + 1)) as {
      intent?: unknown;
      reply?: unknown;
    };
    const reply = sanitizeReply(typeof obj.reply === "string" ? obj.reply : "");
    const intent = String(obj.intent ?? "").toLowerCase().trim() as Intent;
    if (!INTENTS.includes(intent)) {
      // Intent lạ nhưng có câu trả lời -> coi như trò chuyện, khỏi báo "bận".
      return reply !== "" ? { intent: "chat", reply } : null;
    }
    return { intent, reply };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gọi Groq
// ---------------------------------------------------------------------------

function buildSystemPrompt(title: string, context: string, notes: string[] = []): string {
  return [
    ...(notes.length
      ? [
          "LỜI DẠY CỦA ADMIN (ưu tiên cao nhất, luôn làm theo khi trả lời):",
          ...notes.map((n, i) => `${i + 1}. ${n}`),
          "",
        ]
      : []),
    'Bạn là Bee (Tiểu Bee), trợ lý ong thân thiện của team CTV VHHS. Chỉ trả về MỘT đối tượng JSON: {"intent":"...","reply":"..."}.',
    "intent là một trong:",
    "- chat: mọi câu hỏi/trò chuyện có thể tự trả lời (kể cả hỏi về số liệu bên dưới)",
    "- checkin: chỉ khi người hỏi muốn xem NGUYÊN danh sách check-in",
    "- baocao: chỉ khi muốn xem NGUYÊN bảng báo cáo ca",
    "- casetreo: chỉ khi muốn xem NGUYÊN danh sách case chưa xử lý",
    "- help: hỏi Bee làm được gì",
    "- checkout: hỏi ai đã check-out/tan ca (Bee chưa có dữ liệu này)",
    "- hentag: dặn đến ca chiều thì tag CTV ca chiều xử lý case tồn",
    "- nhacnhom: nhờ nhắn/nhắc vào nhóm QLL hoặc HTKT ngay bây giờ, hoặc nhờ gửi lại/đổi câu tin nhắc vừa gửi",
    "- daynho: admin dạy Bee một quy tắc/cách nói để nhớ lâu dài",
    "Các tin trước đó trong cuộc trò chuyện là ngữ cảnh: hiểu câu ngắn theo mạch đang nói.",
    `reply (khi intent=chat): trả lời tự nhiên như đang trò chuyện, tiếng Việt, xưng "em", gọi người hỏi là "${title}", 1-3 câu ngắn, mở đầu "Dạ", tối đa 1 emoji mặt cười. Chỉ dùng số liệu trong DỮ LIỆU, KHÔNG bịa; nếu DỮ LIỆU không có thì nói thẳng em chưa có thông tin đó. Có thể nêu tên CTV (không gắn @). Việc ghi/sửa dữ liệu (chuyển ca, thêm người...) Bee chưa làm được qua chat: nói rõ và gợi ý gõ lệnh /help. Intent khác thì reply là "".`,
    "DỮ LIỆU (ca hiện tại, chỉ đọc):",
    context.trim() === "" ? "(không có)" : context,
  ].join("\n");
}

// Gom dữ liệu thật để AI đọc. Người thường chỉ được thấy check-in; admin thấy thêm
// báo cáo ca + số case chưa xử lý. Lỗi lấy dữ liệu -> bỏ qua phần đó.
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function buildContext(deps: AiDeps, isAdmin: boolean, now: Date): Promise<string> {
  const parts: string[] = [];
  try {
    if (deps.checkinSupabase) {
      parts.push(stripHtml(await buildCheckinList(deps.checkinSupabase, now)));
    }
  } catch {
    // bỏ qua
  }
  if (isAdmin) {
    const ho = await describeHandoff(deps.supabase, now);
    if (ho) parts.push(ho);
    try {
      parts.push(stripHtml(await buildShiftReport(deps.supabase, deps.checkinSupabase, now)));
    } catch {
      // bỏ qua
    }
    try {
      parts.push(await buildDayCaseStats(deps.supabase, now));
    } catch {
      // bỏ qua
    }
  }
  return parts.join("\n\n").slice(0, 3500);
}

// Thử tối đa 2 lần (lỗi lẻ tẻ của Groq thường qua được ở lần 2).
type ChatTurn = { role: "user" | "assistant"; content: string };

async function callGroq(
  ai: AiConfig,
  question: string,
  title: string,
  context = "",
  notes: string[] = [],
  history: ChatTurn[] = []
): Promise<{ intent: Intent; reply: string } | null> {
  // 1 lần gọi duy nhất cho mỗi yêu cầu (không retry để giữ quota).
  return await callGroqOnce(ai, buildSystemPrompt(title, context, notes), question, history);
}

async function callGroqOnce(
  ai: AiConfig,
  system: string,
  question: string,
  history: ChatTurn[] = []
): Promise<{ intent: Intent; reply: string } | null> {
  const doFetch = ai.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: ai.model,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: question.slice(0, MAX_QUESTION_CHARS) },
      ],
      temperature: 0.3,
      max_completion_tokens: ai.maxCompletionTokens,
      response_format: { type: "json_object" },
    };
    // Model suy luận (gpt-oss, qwen): ép suy luận ít + không trả phần suy luận.
    if (/gpt-oss|qwen/i.test(ai.model)) {
      body.reasoning_effort = "low";
      body.include_reasoning = false;
    }
    const res = await doFetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`Groq HTTP ${res.status} ${detail}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    };
    const content = data.choices?.[0]?.message?.content;
    const parsed = parseGroqJson(content);
    if (!parsed) {
      console.error(
        `Groq trả nội dung không đọc được (finish=${data.choices?.[0]?.finish_reason}): ${String(content).slice(0, 200)}`
      );
    }
    return parsed;
  } catch (e) {
    console.error("Groq lỗi:", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Trần lượt/ngày + cooldown (lưu 1 dòng/ngày trong pending_batches)
// ---------------------------------------------------------------------------

interface QuotaState {
  day: string;
  count: number;
  last: Record<string, number>;
}

function vnDay(now: Date): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}-${String(
    vn.getUTCDate()
  ).padStart(2, "0")}`;
}

// admin_id riêng cho (ngày): -(YYYYMMDD*10 + 4). Báo cáo cuối ca dùng +1..+3.
function quotaRowId(day: string): number {
  return -(Number(day.replace(/-/g, "")) * 10 + 4);
}

// Trần là "mềm" (đọc-rồi-ghi, không nguyên tử): sai lệch vài lượt không sao, vì
// chốt chặn cứng là hạn mức 429 của Groq (đã được xử lý như lỗi bình thường).
async function gate(
  supabase: SupabaseClient,
  userId: number,
  needsAi: boolean,
  useCooldown: boolean,
  cap: number,
  now: Date
): Promise<"ok" | "cooldown" | "cap"> {
  const day = vnDay(now);
  const id = quotaRowId(day);
  let state: QuotaState = { day, count: 0, last: {} };
  try {
    const { data } = await supabase
      .from("pending_batches")
      .select("items")
      .eq("admin_id", id)
      .maybeSingle();
    const it = data?.items as Partial<QuotaState> | undefined;
    if (it && it.day === day) {
      state = {
        day,
        count: typeof it.count === "number" ? it.count : 0,
        last: it.last && typeof it.last === "object" ? it.last : {},
      };
    }
  } catch {
    // đọc lỗi -> coi như trống (fail-soft)
  }

  const nowMs = now.getTime();
  const prev = state.last[String(userId)];
  if (useCooldown && prev !== undefined && nowMs - prev < COOLDOWN_MS) return "cooldown";
  if (needsAi && state.count >= cap) return "cap";

  const last: Record<string, number> = {};
  for (const [k, v] of Object.entries(state.last)) {
    if (nowMs - v < 60_000) last[k] = v; // chỉ giữ 1 phút gần nhất cho nhẹ
  }
  last[String(userId)] = nowMs;
  const next: QuotaState = { day, count: state.count + (needsAi ? 1 : 0), last };
  try {
    await supabase
      .from("pending_batches")
      .upsert({ admin_id: id, items: next }, { onConflict: "admin_id" });
  } catch {
    // ghi lỗi -> bỏ qua
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Case chưa xử lý (admin)
// ---------------------------------------------------------------------------

export type CaseScope = "qll" | "htkt" | "all";

// Nhóm nào được hỏi: có chữ htkt -> HTKT, có chữ qll -> QLL, không nói rõ -> cả hai.
export function detectScope(folded: string): CaseScope {
  const h = /\bhtkt\b|ho tro ky thuat/.test(folded);
  const q = /\bqll\b/.test(folded);
  if (h && !q) return "htkt";
  if (q && !h) return "qll";
  return "all";
}

const MAX_LISTED = 10;

function snip(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
}

// QLL: message_id dương, mỗi dòng 1 case.
async function pendingQll(supabase: SupabaseClient, sinceIso: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("qll_tracking")
    .select("message_id, sender_name, content")
    .eq("handled", false)
    .gt("message_id", 0)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows =
    (data as { message_id: number; sender_name: string | null; content: string | null }[] | null) ??
    [];
  const lines: string[] = [];
  rows.slice(0, MAX_LISTED).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.sender_name ?? "QLL"} — ${snip(r.content)}`);
    lines.push(`   https://t.me/c/${QLL_LINK_ID}/${r.message_id}`);
  });
  if (rows.length > MAX_LISTED) lines.push(`... và ${rows.length - MAX_LISTED} case nữa.`);
  return [String(rows.length), ...lines];
}

// HTKT: message_id âm = -(id*10+1). Gộp theo mã (htktCaseKey); một mã coi là đã xong
// nếu bất kỳ tin nào cùng mã đã xử lý.
async function pendingHtkt(supabase: SupabaseClient, sinceIso: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("qll_tracking")
    .select("message_id, handled, content")
    .lt("message_id", 0)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data as { message_id: number; handled: boolean; content: string | null }[] | null) ?? [];
  const groups = new Map<string, { done: boolean; id: number; content: string | null }>();
  for (const r of rows) {
    const k = htktCaseKey(r.content ?? "");
    const g = groups.get(k);
    if (!g) groups.set(k, { done: r.handled, id: r.message_id, content: r.content });
    else if (r.handled) g.done = true;
  }
  const pending = [...groups.values()].filter((g) => !g.done);
  const lines: string[] = [];
  pending.slice(0, MAX_LISTED).forEach((g, i) => {
    const realId = Math.round((-g.id - 1) / 10);
    lines.push(`${i + 1}. ${snip(g.content)}`);
    lines.push(`   https://t.me/c/${HTKT_LINK_ID}/${realId}`);
  });
  if (pending.length > MAX_LISTED) lines.push(`... và ${pending.length - MAX_LISTED} case nữa.`);
  return [String(pending.length), ...lines];
}

// Số liệu case CẢ NGÀY theo từng nhóm (không link) để AI đọc và trả lời bằng lời:
// tổng, đã xử lý (có tim/reply), còn tồn + vài mã tồn đầu tiên.
export async function buildDayCaseStats(supabase: SupabaseClient, now: Date): Promise<string> {
  const { data, error } = await supabase
    .from("qll_tracking")
    .select("message_id, handled, content")
    .gte("created_at", dayStartUtcIso(now))
    .limit(1500);
  if (error) throw new Error(error.message);
  const rows = (data as { message_id: number; handled: boolean; content: string | null }[] | null) ?? [];

  const qll = rows.filter((r) => r.message_id > 0);
  const qllPending = qll.filter((r) => !r.handled);

  const groups = new Map<string, { done: boolean; content: string | null }>();
  for (const r of rows) {
    if (r.message_id >= 0) continue;
    const k = htktCaseKey(r.content ?? "");
    const g = groups.get(k);
    if (!g) groups.set(k, { done: r.handled, content: r.content });
    else if (r.handled) g.done = true;
  }
  const htktAll = [...groups.values()];
  const htktPending = htktAll.filter((g) => !g.done);

  const lst = (items: (string | null)[]) =>
    items.slice(0, 8).map((c) => `- ${snip(c)}`).join("\n");
  return [
    "SỐ LIỆU CASE HÔM NAY (từ đầu ngày, mỗi nhóm một dòng tổng):",
    `QLL: tổng ${qll.length}, đã xử lý ${qll.length - qllPending.length}, còn tồn ${qllPending.length}`,
    qllPending.length ? lst(qllPending.map((r) => r.content)) : "",
    `HTKT (đã gộp theo mã lớp): tổng ${htktAll.length}, đã xử lý ${htktAll.length - htktPending.length}, còn tồn ${htktPending.length}`,
    htktPending.length ? lst(htktPending.map((g) => g.content)) : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function buildPendingCases(
  supabase: SupabaseClient,
  now: Date = new Date(),
  scope: CaseScope = "all"
): Promise<string> {
  // Case tồn = chưa xử lý TỪ ĐẦU NGÀY (kể cả của ca trước), không chỉ ca hiện tại.
  const since = dayStartUtcIso(now);

  try {
    const out: string[] = [];
    const sections: [string, () => Promise<string[]>][] = [];
    if (scope !== "htkt") sections.push(["QLL", () => pendingQll(supabase, since)]);
    if (scope !== "qll") sections.push(["HTKT", () => pendingHtkt(supabase, since)]);
    for (const [name, run] of sections) {
      const [n, ...lines] = await run();
      if (n === "0") {
        out.push(`✅ ${name} hôm nay: không còn case nào tồn.`);
      } else {
        out.push(`📋 Case tồn ${name} hôm nay: ${n}`, ...lines);
      }
      out.push("");
    }
    return out.join("\n").trim();
  } catch {
    return "Dạ em chưa lấy được danh sách case, thử lại sau nhé 🥺";
  }
}

// ---------------------------------------------------------------------------
// Điểm vào
// ---------------------------------------------------------------------------

const FALLBACK_BUSY = "Dạ Bee đang hơi bận, {title} thử lại sau chút hoặc dùng /help nhé 🥺";
const FALLBACK_CAP = "Dạ hôm nay Bee hết lượt trả lời tự động rồi, {title} dùng /help nhé 🥺";

const HELP_TEXT = [
  "Dạ Bee làm được mấy việc này ạ:",
  '• "Ai đang trực?" — xem CTV đã check-in ca này',
  '• "Báo cáo ca" — báo cáo hiệu suất (admin)',
  '• "Case tồn nhóm QLL/HTKT" — case chưa xử lý (admin)',
  '• "Tới ca chiều tag CTV ca chiều xử lý case tồn" — sau 13h30 Bee tự tag (admin)',
  "• Muốn dùng lệnh: gõ /help",
].join("\n");

async function resolveTitle(supabase: SupabaseClient, username?: string): Promise<string> {
  if (!username) return "anh/chị";
  try {
    const cfg = await loadMonitorConfig(supabase);
    const t = cfg.userTitles ?? {};
    return t[username.toLowerCase()] ?? t[username] ?? "anh/chị";
  } catch {
    return "anh/chị";
  }
}

// Trả true nếu tin đã được Bee xử lý/nuốt (handler riêng tư dùng để dừng chuỗi).
// Không bao giờ ném lỗi.
export async function maybeHandleAi(
  message: TelegramMessage,
  deps: AiDeps,
  adminIds: number[],
  opts: { now?: Date; rng?: () => number } = {}
): Promise<boolean> {
  const ai = deps.ai;
  if (!ai) return false; // tắt -> hoàn toàn không làm gì
  try {
    return await handleAi(message, deps, ai, adminIds, opts);
  } catch (e) {
    console.error("Bee AI lỗi (bỏ qua):", e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function handleAi(
  message: TelegramMessage,
  deps: AiDeps,
  ai: AiConfig,
  adminIds: number[],
  opts: { now?: Date; rng?: () => number }
): Promise<boolean> {
  // Ghi nhận nhóm Bee đang ở (+ tin gần đây của nhóm ngoài QLL/HTKT). Fail-soft.
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await observeGroup(deps.supabase, message, opts.now ?? new Date());
    // Form xin nghỉ ở QLL -> tự chuyển vào nhóm Cộng đồng (không tốn lượt AI). Fail-soft.
    await applyLeaveForward(deps, ai, message);
  }
  // Ảnh/tệp có chú thích: tag Bee trong caption vẫn được nhận.
  const text = (message.text ?? message.caption ?? "").trim();
  const from = message.from;
  if (!from || from.is_bot || text === "") return false;

  const isPrivate = message.chat.type === "private";
  const isAdmin = adminIds.includes(from.id);

  let question: string;
  if (isPrivate) {
    if (!isAdmin) return false; // chat riêng của người khác: giữ nguyên luồng cũ
    if (text.startsWith("/")) return false; // lệnh: để các handler cũ xử lý
    question = text;
  } else {
    if (message.chat.type !== "group" && message.chat.type !== "supergroup") return false;
    const m = extractMention(text, ai.botUsername);
    // Admin reply thẳng vào tin của Bee = đang nói chuyện với Bee (không cần tag).
    // CTV reply tin của Bee (vd nhắc SLA) vẫn bị bỏ qua để khỏi tốn lượt AI.
    const rf = message.reply_to_message?.from;
    const repliesToBee =
      isAdmin &&
      !!rf?.is_bot &&
      (rf.username ?? "").toLowerCase() === ai.botUsername.toLowerCase();
    if (!m.mentioned && !repliesToBee) return false;
    console.log(
      `[Bee AI] được gọi trong nhóm ${message.chat.id} "${message.chat.title ?? ""}" bởi ${from.id}${isAdmin ? " (admin)" : ""}`
    );
    question = m.mentioned ? m.question : text;
  }

  // Nội dung nhạy cảm (TK/MK, dãy số dài như SĐT): KHÔNG gửi nguyên văn lên AI.
  // - Người khác: im lặng như cũ.
  // - Admin, câu dài (dạy/nhờ việc, có dán form): CHE số/TK/MK rồi vẫn cho AI hiểu.
  // - Admin, câu tra số ngắn: TypeScript tra thẳng DB (không tốn lượt AI).
  if (isSensitive(question) && isAdmin && !isShortLookup(question)) {
    question = redactForAi(question);
  } else if (isSensitive(question)) {
    if (!isAdmin) return true;
    const digits = question.replace(/[\s.\-]/g, "").match(/\d{8,}/)?.[0];
    let text: string;
    try {
      text = digits
        ? `Em tra theo ${digits} (không gửi số này cho AI) nè:\n\n${await lookupCases(deps.supabase, digits, true)}`
        : "Tin có tài khoản/mật khẩu nên em không xử lý bằng AI ạ. Anh nhắn mã lớp hoặc mã HS để em tra nhé 😊";
    } catch {
      text = "Em chưa tra được, anh thử lại sau nhé 🥺";
    }
    await sendHere(deps, message, isPrivate, text);
    return true;
  }

  const now = opts.now ?? new Date();
  const rng = opts.rng ?? Math.random;
  const folded = foldVi(question);

  // Nhóm A (không cần AI): lệnh bộ nhớ rõ ràng + yêu cầu nghiệp vụ khớp luật.
  let intent: Intent | null = isAdmin ? classifyMemory(question) : null;
  if (intent === null) intent = classifyByRules(folded);
  // Admin: luật từ khóa chỉ dùng cho câu XEM đơn giản. Câu ra lệnh hành động
  // (nhắn/tag/hẹn) hoặc nhắc tới người/case cụ thể, đại từ ("anh ý", "case đó")
  // phải để AI hiểu theo mạch hội thoại.
  if (isAdmin && intent !== null && needsAiUnderstanding(intent, question)) intent = null;
  let canned: string | null = null;
  if (intent === null) {
    // Câu xã giao ngắn ("ok", "cảm ơn"): trả mẫu có sẵn. Riêng admin đang giữa
    // cuộc trò chuyện thì "ok" có thể là đồng ý bản nháp -> để AI hiểu theo mạch.
    const midConversation =
      isAdmin && (await lastTurnAgeMs(deps.supabase, convKey(message), now.getTime())) < FOLLOWUP_WINDOW_MS;
    if (!midConversation) {
      canned = cannedChat(folded, "{title}", rng); // điền danh xưng sau
      if (canned !== null) intent = "chat";
    }
  }

  // Nhóm B (cần AI) của ADMIN: trò chuyện 2 chiều với "bộ não" (AI + công cụ +
  // trí nhớ). Mỗi tin chỉ 1 lượt hội thoại AI; lỗi thì báo bận, KHÔNG gọi AI lần
  // nữa ở luồng cũ. Hết trần ngày -> rơi xuống luồng cũ (báo hết lượt).
  if (isAdmin && intent === null) {
    const g = await gate(deps.supabase, from.id, true, false, ai.dailyCap, now);
    if (g === "ok") {
      const title = await resolveTitle(deps.supabase, from.username);
      const stopTyping = startTyping(ai, message);
      let answer: string | null;
      try {
        answer = await runAgent(deps, ai, message, isPrivate, question, title, now);
      } finally {
        stopTyping();
      }
      if (answer !== null) {
        await appendHistory(deps.supabase, convKey(message), question, [answer], now.getTime());
        return true;
      }
      await sendHere(deps, message, isPrivate, FALLBACK_BUSY.replace("{title}", title));
      return true;
    }
  }
  const needsAi = intent === null;

  // Admin: ghi lại câu Bee trả lời vào mạch hội thoại (để hiểu câu nói tắt lần sau).
  const replies: string[] = [];
  const d: AiDeps = isAdmin
    ? {
        ...deps,
        telegram: Object.assign(Object.create(deps.telegram) as TelegramClient, {
          sendMessage: (
            chatId: number,
            text: string,
            replyTo?: number,
            parseMode?: "HTML"
          ) => {
            if (chatId === message.chat.id) replies.push(text);
            return deps.telegram.sendMessage(chatId, text, replyTo, parseMode);
          },
        }),
      }
    : deps;

  let handled: boolean;
  // Trần lượt + cooldown. Admin không bị cooldown; câu rule của admin khỏi tốn DB.
  if (needsAi || !isAdmin) {
    const g = await gate(deps.supabase, from.id, needsAi, !isAdmin, ai.dailyCap, now);
    if (g === "cooldown") return true;
    const title0 = await resolveTitle(deps.supabase, from.username);
    if (g === "cap") {
      await sendHere(deps, message, isPrivate, FALLBACK_CAP.replace("{title}", title0));
      return true;
    }
    handled = await respond(d, ai, message, isPrivate, isAdmin, question, intent, canned, title0, now, adminIds);
  } else {
    const title = await resolveTitle(deps.supabase, from.username);
    handled = await respond(d, ai, message, isPrivate, isAdmin, question, intent, canned, title, now, adminIds);
  }
  if (isAdmin && handled) {
    await appendHistory(deps.supabase, convKey(message), question, replies, now.getTime());
  }
  return handled;
}

function sendHere(
  deps: AiDeps,
  message: TelegramMessage,
  isPrivate: boolean,
  text: string,
  html = false
) {
  return deps.telegram.sendMessage(
    message.chat.id,
    text,
    isPrivate ? undefined : message.message_id,
    html ? "HTML" : undefined
  );
}

async function respond(
  deps: AiDeps,
  ai: AiConfig,
  message: TelegramMessage,
  isPrivate: boolean,
  isAdmin: boolean,
  question: string,
  intent: Intent | null,
  canned: string | null,
  title: string,
  now: Date,
  _adminIds: number[]
): Promise<boolean> {
  let chatReply = canned ? canned.replace(/\{title\}/g, title) : "";

  // Lời dạy áp cho mọi người hỏi; mạch hội thoại chỉ lưu cho admin.
  const notes = await loadNotes(deps.supabase);
  const history =
    isAdmin && message.from ? await loadHistory(deps.supabase, convKey(message), now.getTime()) : [];

  if (intent === null) {
    const stopTyping = startTyping(ai, message);
    let r: Awaited<ReturnType<typeof callGroq>>;
    try {
      const context = await buildContext(deps, isAdmin, now);
      r = await callGroq(ai, question, title, context, notes, history);
    } finally {
      stopTyping();
    }
    if (!r) {
      await sendHere(deps, message, isPrivate, FALLBACK_BUSY.replace("{title}", title));
      return true;
    }
    intent = r.intent;
    chatReply = r.reply;
  }

  switch (intent) {
    case "checkin": {
      const body = deps.checkinSupabase
        ? await buildCheckinList(deps.checkinSupabase, now)
        : "Dạ chức năng check-in chưa được cấu hình ạ 🥺";
      await sendHere(deps, message, isPrivate, deps.checkinSupabase ? `${lead(title)}\n\n${body}` : body);
      return true;
    }
    case "nhacnhom": {
      if (!isAdmin) {
        await sendHere(deps, message, isPrivate, `Dạ việc này em chỉ nhận từ admin thôi ạ ${title} 🥺`);
        return true;
      }
      // Nhóm: câu hỏi -> tin đang reply -> mạch hội thoại gần nhất.
      let scope = detectScope(foldVi(question));
      if (scope === "all") scope = detectScope(foldVi(message.reply_to_message?.text ?? ""));
      for (let i = history.length - 1; scope === "all" && i >= 0; i--) {
        scope = detectScope(foldVi(history[i].content));
      }
      // Câu nhắc: admin đưa nguyên câu -> dùng nguyên văn; không thì AI viết theo
      // lời dạy + yêu cầu; AI lỗi -> mẫu có sẵn.
      const custom = extractCustomText(question);
      const writer =
        custom !== ""
          ? undefined
          : (group: string, n: number) => writeNudge(ai, notes, question, group, n, history);
      await sendHere(deps, message, isPrivate, await remindGroups(deps, scope, title, now, custom, writer));
      return true;
    }
    case "daynho": {
      if (!isAdmin) return false;
      const note = extractNote(question);
      if (note.length < 3) {
        await sendHere(deps, message, isPrivate, `Dạ ${title} muốn em nhớ điều gì ạ? Ví dụ: "Bee nhớ: nhắc nhóm thì gọi là anh chị" 😊`);
        return true;
      }
      const list = notes.filter((x) => x !== note);
      list.push(note);
      const kept = list.slice(-MAX_NOTES);
      const ok = await saveNotes(deps.supabase, kept);
      await sendHere(
        deps,
        message,
        isPrivate,
        ok
          ? `Dạ em nhớ rồi ạ (lời dạy số ${kept.length}): "${note}" 😊`
          : `Dạ em chưa lưu được, ${title} thử lại giúp em nhé 🥺`
      );
      return true;
    }
    case "xemnho": {
      if (!isAdmin) return false;
      const text = notes.length
        ? `Dạ em đang nhớ ${notes.length} lời dạy ạ 😊\n` + notes.map((x, i) => `${i + 1}. ${x}`).join("\n") +
          `\n\nMuốn bỏ thì ${title} nhắn "Bee quên số ${notes.length}" hoặc "Bee quên hết" nhé.`
        : `Dạ em chưa được dạy gì ạ. ${title} nhắn "Bee nhớ: ..." để dạy em nhé 😊`;
      await sendHere(deps, message, isPrivate, text);
      return true;
    }
    case "quennho": {
      if (!isAdmin) return false;
      const s = question.normalize("NFC").toLowerCase();
      let next: string[];
      let msg: string;
      if (/hết|tất cả/.test(s)) {
        next = [];
        msg = `Dạ em quên hết ${notes.length} lời dạy rồi ạ 😊`;
      } else {
        const idx = Number((s.match(/\d+/) ?? ["0"])[0]);
        if (idx < 1 || idx > notes.length) {
          await sendHere(deps, message, isPrivate, `Dạ em không thấy lời dạy số đó ạ, ${title} nhắn "Bee nhớ gì" để xem danh sách nhé 🥺`);
          return true;
        }
        msg = `Dạ em quên lời dạy số ${idx} rồi ạ: "${notes[idx - 1]}" 😊`;
        next = notes.filter((_, i) => i !== idx - 1);
      }
      const ok = await saveNotes(deps.supabase, next);
      await sendHere(deps, message, isPrivate, ok ? msg : `Dạ em chưa xóa được, ${title} thử lại nhé 🥺`);
      return true;
    }
    case "hentag": {
      if (!isAdmin) {
        await sendHere(deps, message, isPrivate, `Dạ việc này em chỉ nhận từ admin thôi ạ ${title} 🥺`);
        return true;
      }
      // Không nói rõ nhóm -> lấy theo tin Bee đang được reply (vd danh sách case tồn QLL).
      let scope = detectScope(foldVi(question));
      if (scope === "all") scope = detectScope(foldVi(message.reply_to_message?.text ?? ""));
      const where = scope === "all" ? "QLL và HTKT" : scope.toUpperCase();
      const r = await scheduleHandoff(deps.supabase, scope, message.from?.id ?? 0, now);
      let text: string;
      if (r === "sent") {
        text = `Dạ hôm nay em tag CTV ca chiều xong rồi ạ ${title} 😊`;
      } else if (r === "error") {
        text = `Dạ em chưa ghi nhận được lịch này, ${title} thử lại sau nhé 🥺`;
      } else if (handoffTimeNow(now) >= HANDOFF_START_H) {
        text = `Dạ em ghi nhận rồi ạ, em sẽ tag CTV ca chiều xử lý case tồn ${where} trong ít phút nữa ạ 😊`;
      } else {
        text = `Dạ em ghi nhận rồi ạ, sau 13h30 em sẽ tag CTV ca chiều xử lý case tồn ${where} trong nhóm ạ 😊`;
      }
      await sendHere(deps, message, isPrivate, text);
      return true;
    }
    case "hanmuc": {
      if (!isAdmin) {
        await sendHere(deps, message, isPrivate, `Dạ mục này em chỉ báo cho admin thôi ạ ${title} 🥺`);
        return true;
      }
      await sendHere(deps, message, isPrivate, await buildQuotaReport(deps.supabase, ai, now));
      return true;
    }
    case "checkout": {
      const pool = CHECKOUT_REPLY;
      await sendHere(deps, message, isPrivate, pool[pickIndex(pool.length, undefined)].replace(/\{title\}/g, title));
      return true;
    }
    case "baocao":
    case "casetreo": {
      if (!isAdmin) {
        await sendHere(deps, message, isPrivate, `Dạ mục này em chỉ báo cho admin thôi ạ ${title} 🥺`);
        return true;
      }
      const html = intent === "baocao";
      const scope = detectScope(foldVi(question));
      const where = scope === "all" ? "cả 2 nhóm QLL và HTKT" : `nhóm ${scope.toUpperCase()}`;
      const intro = html ? lead(title) : `Dạ em check ${where} rồi, ${title} xem case tồn nhé 😊`;
      const body = html
        ? await buildShiftReport(deps.supabase, deps.checkinSupabase, now)
        : await buildPendingCases(deps.supabase, now, detectScope(foldVi(question)));
      if (isPrivate) {
        await sendHere(deps, message, true, `${intro}\n\n${body}`, html);
        return true;
      }
      // Trong nhóm: admin tag thì trả lời thẳng trong nhóm (reply vào tin hỏi).
      await sendHere(deps, message, false, `${intro}\n\n${body}`, html);
      return true;
    }
    case "help": {
      await sendHere(deps, message, isPrivate, HELP_TEXT);
      return true;
    }
    case "chat":
    default: {
      const reply = chatReply || `Dạ em đây ạ, ${title} cần Bee hỗ trợ gì ạ? 😊`;
      await sendHere(deps, message, isPrivate, reply);
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Lịch tag CTV ca chiều xử lý case tồn (admin dặn, cron thực hiện)
// ---------------------------------------------------------------------------
// Lưu trong pending_batches (không cần bảng mới), admin_id = -(YYYYMMDD*10 + 5)
// (báo cáo cuối ca dùng +1..+3, quota AI dùng +4). Mỗi ngày tối đa 1 lịch.
// Sau 13h30, cron chiếm lịch (đổi pending -> sending nguyên tử), lấy CTV đã
// check-in ca chiều, tag họ trong đúng nhóm kèm case tồn từ đầu ngày, rồi lưu
// kết quả (sent). Quá 15h30 mà chưa tag được thì hết hạn và báo lại admin.

export const HANDOFF_START_H = 13.5;
const HANDOFF_EXPIRE_H = 15.5;
const HANDOFF_STALE_MS = 3 * 60_000; // "sending" quá 3 phút coi như treo -> chiếm lại
const QLL_CHAT_ID = -1002273179613;
const HTKT_CHAT_ID = -1002458492731;

interface HandoffState {
  kind: "handoff";
  day: string;
  scope: CaseScope;
  requestedBy: number;
  requestedAt: string;
  status: "pending" | "sending" | "sent" | "expired";
  claimedAt?: number;
  sentScopes: string[];
  sentAt?: string;
  ctvs?: string[];
  counts?: { qll: number; htkt: number };
  note?: string;
}

function handoffRowId(day: string): number {
  return -(Number(day.replace(/-/g, "")) * 10 + 5);
}

export function handoffTimeNow(now: Date): number {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return vn.getUTCHours() + vn.getUTCMinutes() / 60;
}

function dayStartUtcIso(now: Date): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), -7, 0, 0)
  ).toISOString();
}

async function readHandoff(supabase: SupabaseClient, day: string): Promise<HandoffState | null> {
  const { data, error } = await supabase
    .from("pending_batches")
    .select("items")
    .eq("admin_id", handoffRowId(day))
    .maybeSingle();
  if (error) throw new Error(error.message);
  const it = data?.items as Partial<HandoffState> | undefined;
  if (!it || it.kind !== "handoff" || it.day !== day) return null;
  return it as HandoffState;
}

// Admin dặn tag. Trả: "ok" (đã ghi/cập nhật), "sent" (hôm nay tag xong rồi), "error".
export async function scheduleHandoff(
  supabase: SupabaseClient,
  scope: CaseScope,
  requestedBy: number,
  now: Date
): Promise<"ok" | "sent" | "error"> {
  const day = vnDay(now);
  try {
    const cur = await readHandoff(supabase, day);
    if (cur && cur.status === "sent") return "sent";
    if (cur && cur.status === "sending") return "ok"; // đang tag, khỏi ghi đè
    const next: HandoffState = {
      kind: "handoff",
      day,
      scope,
      requestedBy,
      requestedAt: now.toISOString(),
      status: "pending",
      sentScopes: [],
    };
    const { error } = await supabase
      .from("pending_batches")
      .upsert({ admin_id: handoffRowId(day), items: next }, { onConflict: "admin_id" });
    if (error) throw new Error(error.message);
    return "ok";
  } catch (e) {
    console.error("scheduleHandoff lỗi:", e instanceof Error ? e.message : String(e));
    return "error";
  }
}

async function saveHandoff(supabase: SupabaseClient, state: HandoffState): Promise<void> {
  await supabase
    .from("pending_batches")
    .upsert({ admin_id: handoffRowId(state.day), items: state }, { onConflict: "admin_id" });
}

// Chiếm lịch nguyên tử: chỉ 1 lần gọi cron thắng. Trả state đã chiếm hoặc null.
async function claimHandoff(
  supabase: SupabaseClient,
  cur: HandoffState,
  nowMs: number
): Promise<HandoffState | null> {
  const stale = cur.status === "sending" && nowMs - (cur.claimedAt ?? 0) > HANDOFF_STALE_MS;
  if (cur.status !== "pending" && !stale) return null;
  const next: HandoffState = { ...cur, status: "sending", claimedAt: nowMs };
  const { data, error } = await supabase
    .from("pending_batches")
    .update({ items: next })
    .eq("admin_id", handoffRowId(cur.day))
    .eq("items->>status", cur.status)
    .select("admin_id");
  if (error) {
    console.error("claimHandoff lỗi:", error.message);
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? next : null;
}

function scopeLabel(s: string): string {
  return s === "qll" ? "QLL" : "HTKT";
}

// Chạy mỗi phút từ cron. Không bao giờ ném lỗi. Ngoài khung 13h30-15h30 (và khi
// chưa có lịch) gần như không làm gì: chỉ 1 lần đọc DB trong khung giờ.
export async function runHandoff(
  telegram: TelegramClient,
  supabase: SupabaseClient,
  checkinClient: SupabaseClient | undefined,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    const now = new Date(nowMs);
    const t = handoffTimeNow(now);
    if (t < HANDOFF_START_H || t >= 17) return;
    if (!supabase || typeof supabase.from !== "function") return;

    const cur = await readHandoff(supabase, vnDay(now));
    if (!cur || (cur.status !== "pending" && cur.status !== "sending")) return;

    if (t >= HANDOFF_EXPIRE_H) {
      const exp: HandoffState = { ...cur, status: "expired", note: "quá giờ, chưa tag được" };
      await saveHandoff(supabase, exp);
      await telegram.sendMessage(
        cur.requestedBy,
        "Dạ em chưa tag được CTV ca chiều (chưa có ai check-in hoặc lỗi) nên đã hủy lịch hôm nay ạ 🥺"
      );
      return;
    }

    const claimed = await claimHandoff(supabase, cur, nowMs);
    if (!claimed) return;

    const ctvs = checkinClient ? await getCurrentShiftCheckins(checkinClient, now) : [];
    if (ctvs.length === 0) {
      // Chưa ai check-in ca chiều: trả về pending, phút sau thử lại.
      await saveHandoff(supabase, { ...claimed, status: "pending", claimedAt: undefined });
      return;
    }

    const since = dayStartUtcIso(now);
    const tags = ctvs.map((u) => `@${u}`).join(" ");
    const scopes: ("qll" | "htkt")[] =
      claimed.scope === "all" ? ["qll", "htkt"] : [claimed.scope as "qll" | "htkt"];
    const counts = { qll: 0, htkt: 0 };
    const done = new Set(claimed.sentScopes);
    let failed = false;

    for (const s of scopes) {
      if (done.has(s)) continue;
      const [n, ...lines] = s === "qll" ? await pendingQll(supabase, since) : await pendingHtkt(supabase, since);
      counts[s] = Number(n);
      if (n === "0") {
        done.add(s);
        continue;
      }
      const text =
        `${tags} ơi, sang ca chiều rồi, nhờ mình xử lý giúp các case tồn ${scopeLabel(s)} nhé 😊\n\n` +
        `📋 Case tồn ${scopeLabel(s)}: ${n}\n${lines.join("\n")}`;
      const res = await telegram.sendMessage(s === "qll" ? QLL_CHAT_ID : HTKT_CHAT_ID, text);
      if (res.ok) done.add(s);
      else failed = true;
    }

    if (failed) {
      // Giữ lại phần đã gửi, phút sau thử lại phần còn thiếu.
      await saveHandoff(supabase, {
        ...claimed,
        status: "pending",
        claimedAt: undefined,
        sentScopes: [...done],
      });
      return;
    }

    await saveHandoff(supabase, {
      ...claimed,
      status: "sent",
      sentScopes: [...done],
      sentAt: now.toISOString(),
      ctvs,
      counts,
    });
    const total = counts.qll + counts.htkt;
    await telegram.sendMessage(
      cur.requestedBy,
      total === 0
        ? "Dạ ca sáng không còn case tồn nên em không tag ai ạ 😊"
        : `Dạ em đã tag ${ctvs.length} CTV ca chiều xử lý case tồn (QLL ${counts.qll}, HTKT ${counts.htkt}) rồi ạ 😊`
    );
  } catch (e) {
    console.error("runHandoff lỗi:", e instanceof Error ? e.message : String(e));
  }
}

// Mô tả lịch hôm nay cho AI đọc (để hỏi "Bee đã tag chưa").
export async function describeHandoff(supabase: SupabaseClient, now: Date): Promise<string> {
  try {
    const h = await readHandoff(supabase, vnDay(now));
    if (!h) return "";
    if (h.status === "sent") {
      return `Đã tag CTV ca chiều (${(h.ctvs ?? []).join(", ")}) xử lý case tồn: QLL ${h.counts?.qll ?? 0}, HTKT ${h.counts?.htkt ?? 0}.`;
    }
    if (h.status === "expired") return "Lịch tag CTV ca chiều hôm nay đã hết hạn, chưa tag được.";
    return "Đã có lịch tag CTV ca chiều xử lý case tồn, đang chờ sau 13h30.";
  } catch {
    return "";
  }
}

// Admin nhờ "nhắn nhóm QLL/HTKT": đăng ngay vào nhóm, tag CTV đã check-in ca hiện
// tại + liệt kê case tồn từ đầu ngày. Nhóm nào không còn tồn thì bỏ qua. Trả câu
// báo lại admin (không ném lỗi).
// Câu nhắc mặc định, xoay vòng, mỗi câu đúng 1 icon mặt.
const NUDGES: readonly string[] = [
  "Dạ, còn {n} case anh chị hỗ trợ nốt giúp em ạ 😊",
  "Dạ còn {n} case {g} chưa xử lý, anh chị xem giúp em nhé 🥺",
  "Anh chị ơi, còn {n} case {g} tồn, mình hỗ trợ nốt giúp em với ạ 😅",
  "Dạ em nhắc nhẹ, còn {n} case {g} anh chị xử lý giúp em nhé 😊",
];
function nudgeLine(n: number, group: string): string {
  return NUDGES[pickIndex(NUDGES.length, undefined)]
    .replace(/\{n\}/g, String(n))
    .replace(/\{g\}/g, group);
}

// Lấy câu admin muốn Bee nhắn: phần sau dấu ":" / "nhắn là" / "nói là" / "câu thành"
// CUỐI CÙNG trong tin. Không có -> "" (dùng câu mặc định).
export function extractCustomText(q: string): string {
  const re = /(?:[:：]|nhắn là|nói là|nhắn rằng|câu thành|đổi thành)\s*/gi;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) end = m.index + m[0].length;
  if (end < 0) return "";
  const t = q.slice(end).replace(/\s+/g, " ").trim().slice(0, 300);
  if (t.length < 3) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function remindGroups(
  deps: AiDeps,
  scope: CaseScope,
  title: string,
  now: Date,
  custom = "",
  writer?: (group: string, n: number) => Promise<string | null>
): Promise<string> {
  try {
    const ctvs = deps.checkinSupabase ? await getCurrentShiftCheckins(deps.checkinSupabase, now) : [];
    const tags = ctvs.map((u) => `@${u}`).join(" ");
    const since = dayStartUtcIso(now);
    const scopes: ("qll" | "htkt")[] = scope === "all" ? ["qll", "htkt"] : [scope];
    const posted: string[] = [];
    const empty: string[] = [];
    const failed: string[] = [];
    for (const s of scopes) {
      const [n, ...lines] =
        s === "qll" ? await pendingQll(deps.supabase, since) : await pendingHtkt(deps.supabase, since);
      if (n === "0") {
        empty.push(scopeLabel(s));
        continue;
      }
      const sentence =
        custom !== ""
          ? custom
          : (writer ? await writer(scopeLabel(s), Number(n)) : null) ?? nudgeLine(Number(n), scopeLabel(s));
      const text = `${tags !== "" ? tags + " " : ""}${sentence}\n\n${lines.join("\n")}`;
      const res = await deps.telegram.sendMessage(s === "qll" ? QLL_CHAT_ID : HTKT_CHAT_ID, text);
      (res.ok ? posted : failed).push(`${scopeLabel(s)} (${n} case)`);
    }
    const parts: string[] = [];
    if (posted.length) {
      parts.push(
        `Dạ em nhắn nhóm ${posted.join(", ")} rồi ạ` + (ctvs.length ? `, em đã tag ${ctvs.length} CTV đang trực ca 😊` : " 😊")
      );
    }
    if (empty.length) parts.push(`Nhóm ${empty.join(", ")} không còn case tồn nên em không nhắn ạ.`);
    if (failed.length) parts.push(`Em chưa gửi được vào nhóm ${failed.join(", ")}, ${title} thử lại giúp em nhé 🥺`);
    return parts.join("\n");
  } catch (e) {
    console.error("remindGroups lỗi:", e instanceof Error ? e.message : String(e));
    return `Dạ em chưa nhắn nhóm được, ${title} thử lại sau nhé 🥺`;
  }
}

// ---------------------------------------------------------------------------
// Bộ nhớ: lời dạy của admin (lâu dài) + vài lượt hội thoại gần nhất
// ---------------------------------------------------------------------------
// Lưu trong pending_batches, admin_id cố định (không đụng id admin thật/dương,
// -9001/-9002 của luồng cũ, hay các id theo ngày ~ -2e9).
const NOTES_ROW_ID = -9101;
const HISTORY_ROW_ID = -9102;
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 300;
const HISTORY_TURNS = 6; // 3 cặp hỏi-đáp gần nhất (đủ hiểu câu nối tiếp, ít token)
const FOLLOWUP_WINDOW_MS = 10 * 60_000; // trong 10 phút coi là đang nói chuyện dở

// Khóa ngữ cảnh: tách theo cuộc trò chuyện (chat_id) VÀ người nói (user_id).
export function convKey(message: TelegramMessage): string {
  return `${message.chat.id}:${message.from?.id ?? 0}`;
}

// Bao lâu từ lượt hội thoại gần nhất của người này (Infinity nếu chưa có).
export async function lastTurnAgeMs(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number
): Promise<number> {
  const row = await readHistoryRow(supabase);
  const list = row.byUser[String(userId)] ?? [];
  return list.length ? nowMs - list[list.length - 1].t : Infinity;
}
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000; // quá 2 giờ thì quên mạch cũ

export async function loadNotes(supabase: SupabaseClient): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("pending_batches")
      .select("items")
      .eq("admin_id", NOTES_ROW_ID)
      .maybeSingle();
    const n = (data?.items as { notes?: unknown } | undefined)?.notes;
    return Array.isArray(n) ? n.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function saveNotes(supabase: SupabaseClient, notes: string[]): Promise<boolean> {
  const { error } = await supabase
    .from("pending_batches")
    .upsert({ admin_id: NOTES_ROW_ID, items: { kind: "notes", notes } }, { onConflict: "admin_id" });
  if (error) console.error("saveNotes lỗi:", error.message);
  return !error;
}

// Bỏ phần lệnh ở đầu ("Bee nhớ:", "từ giờ", ...) để lấy đúng nội dung lời dạy.
export function extractNote(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/^\s*bee[\s,]+/i, "")
    .replace(/^(hãy\s+|em\s+)?(ghi nhớ|nhớ|học)\s*(giúp anh|giúp chị|giúp|là|rằng)?\s*[:：,-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

interface HistoryRow {
  kind: "history";
  byUser: Record<string, { t: number; role: "user" | "assistant"; content: string }[]>;
}

async function readHistoryRow(supabase: SupabaseClient): Promise<HistoryRow> {
  try {
    const { data } = await supabase
      .from("pending_batches")
      .select("items")
      .eq("admin_id", HISTORY_ROW_ID)
      .maybeSingle();
    const it = data?.items as Partial<HistoryRow> | undefined;
    if (it && it.kind === "history" && it.byUser && typeof it.byUser === "object") {
      return { kind: "history", byUser: it.byUser };
    }
  } catch {
    // bỏ qua
  }
  return { kind: "history", byUser: {} };
}

export async function loadHistory(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number
): Promise<ChatTurn[]> {
  const row = await readHistoryRow(supabase);
  return (row.byUser[String(userId)] ?? [])
    .filter((h) => nowMs - h.t < HISTORY_TTL_MS)
    .slice(-HISTORY_TURNS)
    .map((h) => ({ role: h.role, content: h.content }));
}

// Ghi thêm 1 lượt hỏi-đáp. Đọc-rồi-ghi (không nguyên tử) — mất 1 lượt hiếm hoi
// khi 2 tin đến cùng lúc là chấp nhận được.
export async function appendHistory(
  supabase: SupabaseClient,
  userId: string,
  question: string,
  answers: string[],
  nowMs: number
): Promise<void> {
  try {
    const row = await readHistoryRow(supabase);
    const key = String(userId);
    const list = (row.byUser[key] ?? []).filter((h) => nowMs - h.t < HISTORY_TTL_MS);
    list.push({ t: nowMs, role: "user", content: question.slice(0, 300) });
    const a = answers.join("\n").replace(/https?:\/\/\S+/g, "").slice(0, 400).trim();
    if (a) list.push({ t: nowMs, role: "assistant", content: a });
    row.byUser[key] = list.slice(-HISTORY_TURNS);
    // Dọn người đã im quá TTL cho dòng nhẹ.
    for (const [k, v] of Object.entries(row.byUser)) {
      if (!v.length || nowMs - v[v.length - 1].t >= HISTORY_TTL_MS) delete row.byUser[k];
    }
    await supabase
      .from("pending_batches")
      .upsert({ admin_id: HISTORY_ROW_ID, items: row }, { onConflict: "admin_id" });
  } catch {
    // bỏ qua
  }
}

// AI viết câu nhắc vào nhóm theo lời dạy + yêu cầu của admin. Số case do code
// truyền vào (không để AI bịa). Lỗi -> null (dùng mẫu có sẵn).
export async function writeNudge(
  ai: AiConfig,
  notes: string[],
  request: string,
  group: string,
  n: number,
  history: ChatTurn[]
): Promise<string | null> {
  const system = [
    'Bạn là Bee, viết MỘT câu nhắc ngắn gửi vào nhóm chat công việc để nhờ các CTV xử lý case tồn. Chỉ trả JSON {"intent":"chat","reply":"<câu nhắc>"}.',
    `Thông tin bắt buộc đúng: nhóm ${group}, còn ${n} case tồn.`,
    'Yêu cầu: tiếng Việt tự nhiên, lễ phép, gọi người nhận là "anh chị", xưng "em", 1-2 câu, đúng 1 emoji mặt cười ở cuối. Không gắn @, không link, không liệt kê case (hệ thống tự thêm).',
    ...(notes.length ? ["LỜI DẠY CỦA ADMIN (làm theo):", ...notes.map((x, i) => `${i + 1}. ${x}`)] : []),
  ].join("\n");
  const r = await callGroqOnce(ai, system, `Yêu cầu của admin: ${request}`, history);
  const text = r?.reply?.trim() ?? "";
  return text.length >= 5 ? text : null;
}

// ===========================================================================
// BỘ NÃO BEE (admin): trò chuyện 2 chiều + công cụ (tool calling) + tự học
// ===========================================================================
// AI tự nói chuyện; cần số liệu/hành động thì gọi công cụ, code thực thi rồi
// trả kết quả cho AI viết câu trả lời. Số liệu luôn lấy từ DB qua công cụ.
// Admin dạy điều gì (cách nói, quy tắc, thông tin team) -> AI tự gọi ghi_nho.
// Trả câu trả lời cuối (đã gửi) hoặc null nếu lỗi (để rơi về luồng cũ).

const AGENT_MAX_ROUNDS = 3; // thường 1 (trò chuyện) hoặc 2 (gọi công cụ rồi trả lời)
const AGENT_DEADLINE_MS = 8500; // chừa chỗ cho webhook Vercel

type AgentMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const NHOM = { type: "string", enum: ["qll", "htkt", "all"], description: "qll, htkt hoặc all (cả hai)" };
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "xem_so_lieu",
      description: "Số liệu case hôm nay theo nhóm: tổng, đã xử lý, còn tồn + vài mã tồn. Dùng để trả lời bằng lời.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_bao_cao_ca",
      description:
        "Báo cáo 1 ca HÔM NAY: CTV nào làm, mỗi người bao nhiêu case (tim, reply, QLL, HTKT). Bỏ trống ca = ca hiện tại.",
      parameters: {
        type: "object",
        properties: { ca: { type: "string", enum: ["sang", "chieu", "toi"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_checkin",
      description: "Danh sách CTV đã check-in ca hiện tại.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "tra_cuu_case",
      description: "Tìm case trong 3 ngày gần nhất theo mã lớp/mã HS/tên/từ khóa: nhóm, giờ, đã xử lý chưa, ai xử lý, link.",
      parameters: { type: "object", properties: { tu_khoa: { type: "string" } }, required: ["tu_khoa"] },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_ctv",
      description: "Hôm nay 1 CTV đã xử lý bao nhiêu case (theo ca, tim/reply, QLL/HTKT).",
      parameters: {
        type: "object",
        properties: { username: { type: "string", description: "username Telegram, không cần @" } },
        required: ["username"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_cau_hinh",
      description: "Ai điều phối từng ca, CTV đang tắt SLA, lịch tag ca chiều hôm nay, danh sách lệnh bot.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_cac_nhom",
      description: "Danh sách các nhóm Telegram Bee đang ở (tên, lần cuối có tin, bot còn trong nhóm không).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_nhom",
      description:
        "Đọc tin nhắn gần đây (24h) của 1 nhóm ngoài QLL/HTKT theo tên, vd \"Xếp lớp\". Dùng để tóm tắt, xem ai hỏi gì, tin nào chưa ai trả lời.",
      parameters: { type: "object", properties: { ten_nhom: { type: "string" } }, required: ["ten_nhom"] },
    },
  },
  {
    type: "function",
    function: {
      name: "gui_tin_nhom",
      description:
        "ĐĂNG THẬT 1 tin vào 1 nhóm theo TÊN (Bee tự tra ID nhóm, admin không cần đưa ID). Có tra_loi_cho thì reply vào tin gần nhất của người đó trong nhóm. Chỉ dùng khi admin bảo gửi/nhắn/rep rõ ràng.",
      parameters: {
        type: "object",
        properties: {
          ten_nhom: { type: "string", description: "tên nhóm, vd \"Xếp lớp\"" },
          noi_dung: { type: "string" },
          tra_loi_cho: {
            type: "string",
            description: "username người cần reply (\"admin\" = chính người đang ra lệnh); bỏ trống = gửi tin mới",
          },
        },
        required: ["ten_nhom", "noi_dung"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "xem_han_muc",
      description: "Hạn mức/credit hôm nay: số lần gọi Groq, token đã dùng, Groq báo còn bao nhiêu, trần lượt của Bee.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "gui_danh_sach",
      description:
        "Gửi vào cuộc trò chuyện này bản đầy đủ (bảng/danh sách có link). Dùng khi admin muốn XEM danh sách case tồn, bảng báo cáo hoặc danh sách check-in.",
      parameters: {
        type: "object",
        properties: {
          loai: { type: "string", enum: ["case_ton", "bao_cao", "checkin"] },
          nhom: NHOM,
        },
        required: ["loai"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nhan_nhom",
      description:
        "ĐĂNG THẬT vào nhóm: tag CTV đang trực + câu nhắc + danh sách case tồn. Chỉ gọi khi admin đã bảo gửi/nhắn rõ ràng hoặc đã đồng ý bản nháp.",
      parameters: {
        type: "object",
        properties: {
          nhom: NHOM,
          cau_nhac: { type: "string", description: "Câu nhắc 1-2 câu, không @, không link, không liệt kê case" },
        },
        required: ["nhom", "cau_nhac"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tag_ctv",
      description:
        "ĐĂNG THẬT vào nhóm: tag ĐÚNG những người được chỉ định. Có ma_case thì reply thẳng vào tin case đó. Dùng khi admin bảo tag/nhờ 1 người cụ thể (kể cả \"anh ý\" = người vừa nhắc).",
      parameters: {
        type: "object",
        properties: {
          nhom: { type: "string", enum: ["qll", "htkt"] },
          usernames: { type: "array", items: { type: "string" }, description: "username Telegram, không @" },
          ma_case: { type: "string", description: "mã case/mã HS/mã lớp để tìm tin gốc (nếu có)" },
          loi_nhan: { type: "string", description: "câu nhờ ngắn, tự nhiên, không @, không link" },
        },
        required: ["nhom", "usernames", "loi_nhan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hen_tag_ca_chieu",
      description: "Hẹn: sau 13h30 hôm nay tự tag CTV ca chiều xử lý case tồn.",
      parameters: { type: "object", properties: { nhom: NHOM }, required: ["nhom"] },
    },
  },
  {
    type: "function",
    function: {
      name: "ghi_nho",
      description:
        "Ghi vào bộ não lâu dài điều admin dạy: cách nói, quy tắc làm việc, sở thích, thông tin bền vững về team. KHÔNG ghi số liệu tạm thời.",
      parameters: {
        type: "object",
        properties: { noi_dung: { type: "string", description: "1 câu ngắn, rõ ý" } },
        required: ["noi_dung"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quen",
      description: "Xóa 1 điều trong bộ não theo số thứ tự, hoặc so=0 để xóa hết.",
      parameters: { type: "object", properties: { so: { type: "integer" } }, required: ["so"] },
    },
  },
];

function vnClock(now: Date): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())} ngày ${p(vn.getUTCDate())}/${p(vn.getUTCMonth() + 1)}`;
}

function agentSystem(title0: string, notes: string[], now: Date, isPrivate: boolean): string {
  const title = title0 === "anh/chị" ? "anh" : title0;
  return [
    `Bạn là Tiểu Bee, trợ lý đồng nghiệp của team CTV VHHS. Theo dõi case ở 2 nhóm QLL và HTKT, ngoài ra còn ở các nhóm khác (xem_cac_nhom). Đang nói chuyện với admin; xưng "em", gọi "${title}".`,
    "- Hỏi về nhóm khác (\"nhóm Xếp lớp\", \"em ở những nhóm nào\", \"nhóm vừa tag em\") -> xem_cac_nhom / xem_nhom, không hỏi lại QLL hay HTKT.",
    "- Gửi/rep 1 tin bất kỳ vào nhóm nào đó -> gui_tin_nhom (theo tên, không cần ID; \"rep lại anh\" = tra_loi_cho \"admin\"). nhan_nhom CHỈ để nhắc case tồn ở QLL/HTKT, không dùng gửi tin thường.",
    "- TUYỆT ĐỐI không nói đã gửi/nhắn/tag nếu chưa gọi công cụ gửi và công cụ chưa báo thành công.",
    "- Việc tự động đang chạy: mọi tin ở QLL có đủ form (Tên / Code / Mã học sinh + mã lớp + LỚP + Ngày vào lớp / GV dạy) — xin nghỉ, xin muộn, out sớm, phản ánh... — tự chuyển sang nhóm Cộng đồng VH - BGD; xem số lượng qua xem_cau_hinh. Ngoài việc này và hẹn tag ca chiều, em KHÔNG có cơ chế tự động nào khác: không được hứa \"em sẽ tự fw/chuyển/gửi\" các loại tin khác.",
    `Giờ VN: ${vnClock(now)}. Ca sáng 8-12h, chiều 13h30-17h, tối 17h30-21h30. ${isPrivate ? "Chat riêng." : "Trong nhóm, mọi người cùng thấy."}`,
    "Giọng: như đồng nghiệp nhắn tin, ngắn (1-2 câu), thân thiện, đổi cách nói cho tự nhiên. Không cần mở đầu bằng \"Dạ\" hay gọi tên ở mọi câu, không lặp lại câu hỏi. Tối đa 1 emoji, văn bản thuần, không markdown.",
    "Quy tắc:",
    "- Hiểu câu nối tiếp và đại từ (\"nhóm đó\", \"còn bên kia\", \"ok gửi đi\") theo các tin trước.",
    "- Số liệu chỉ lấy qua công cụ, không bịa. Thiếu thông tin quan trọng thì hỏi lại 1 câu ngắn, không đoán.",
    "- Tag 1 người/1 case cụ thể (\"tag anh ý vào case 215785\") -> tag_ctv đúng người đó (\"anh ý\", \"bạn đó\" = người vừa nhắc trong mạch; không rõ là ai thì hỏi lại). KHÔNG dùng nhan_nhom cho việc này.",
    "- Nhắc chung cả ca xử lý case tồn -> nhan_nhom. Được nhờ soạn/thử thì xem_so_lieu rồi đưa bản nháp và hỏi gửi không; chỉ gửi khi admin bảo gửi hoặc ra lệnh rõ. Nhóm hết case tồn thì nói không cần nhắc.",
    "- Lời nhắn đăng vào nhóm phải là câu hoàn chỉnh tự nhiên do em viết (vd \"anh hỗ trợ giúp em case này nhé\"), không chép lại nguyên câu lệnh của admin.",
    "- Khi trả lời admin, nêu tên CTV không kèm @ (tránh tag nhầm).",
    "- Báo đúng kết quả công cụ; công cụ báo chưa gửi/lỗi thì không nói đã gửi.",
    "- Admin dặn quy tắc lâu dài (\"từ nay\", \"lần sau\", \"nhớ...\") thì ghi_nho 1 câu rõ ý. Không ghi sửa nháp tạm hay số liệu trong ngày. Hỏi em nhớ gì thì chỉ kể BỘ NÃO.",
    "- Ngoài số liệu, em giúp được việc chung như đồng nghiệp: soạn/sửa tin nhắn, gợi ý cách trả lời phụ huynh, giải thích, tính nhẩm, góp ý, trò chuyện. Việc chung dùng hiểu biết chung; còn thông tin nội bộ (case, CTV, số liệu, cấu hình) thì chỉ lấy qua công cụ.",
    "- Hỏi về 1 case cụ thể (mã lớp, mã HS, tên) dùng tra_cuu_case; về 1 CTV dùng xem_ctv; về điều phối/SLA/lệnh bot dùng xem_cau_hinh.",
    "- Việc thay đổi dữ liệu (chuyển ca, thêm/xóa CTV, tắt SLA...) em chưa tự làm được: chỉ admin gõ đúng lệnh (xem_cau_hinh có danh sách lệnh) và đưa luôn câu lệnh mẫu.",
    "- Câu hỏi mơ hồ: đoán ý hợp lý nhất theo mạch; nếu vẫn có 2 khả năng khác nhau thì hỏi lại 1 câu.",
    notes.length
      ? "BỘ NÃO (admin dạy, luôn làm theo):\n" + notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
      : "BỘ NÃO: (trống)",
  ].join("\n");
}

// Bỏ markdown để hiển thị gọn trên Telegram (không dùng parse_mode).
export function plainText(s: string): string {
  return s
    .replace(/@([A-Za-z0-9_]{3,})/g, "$1") // lời Bee nói không tag ai; tag chỉ qua công cụ
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function agentCall(
  ai: AiConfig,
  messages: AgentMsg[],
  deadline: number,
  allowTools = true,
  sb?: SupabaseClient // có thì ghi sổ hạn mức
): Promise<{ content: string; tool_calls?: ToolCall[]; finish?: string } | null> {
  const doFetch = ai.fetchImpl ?? fetch;
  // Tối đa 2 lần gửi: lần 2 CHỈ khi 429 có Retry-After ngắn (<=2s) hoặc lỗi 5xx,
  // và còn đủ thời gian. 400/401/timeout/mất mạng: không thử lại.
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 800) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(left, ai.timeoutMs));
    const t0 = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: ai.agentModel,
        messages,
        tools: AGENT_TOOLS,
        tool_choice: allowTools ? "auto" : "none",
        temperature: 0.6,
        max_completion_tokens: ai.maxCompletionTokens,
      };
      if (/gpt-oss|qwen/i.test(ai.agentModel)) {
        body.reasoning_effort = "low";
        body.include_reasoning = false;
      }
      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (sb) await recordGroqCall(sb, { status: 0, model: ai.agentModel });
        throw e;
      }
      if (sb && !res.ok) await recordGroqCall(sb, { status: res.status, model: ai.agentModel, headers: res.headers });
      if (res.status === 429) {
        const wait = Number(res.headers?.get?.("retry-after") ?? "") * 1000;
        console.error(`[Bee AI] 429 rate limit (retry-after=${wait || "?"}ms, lần ${attempt + 1})`);
        if (attempt === 0 && wait > 0 && wait <= 2000 && Date.now() + wait + 1500 < deadline) {
          await sleepMs(wait);
          continue;
        }
        return null;
      }
      if (res.status >= 500) {
        console.error(`[Bee AI] HTTP ${res.status} lỗi phía Groq (lần ${attempt + 1})`);
        if (attempt === 0) continue;
        return null;
      }
      if (!res.ok) {
        // 400: request/model sai; 401: key sai -> không thử lại.
        console.error(`[Bee AI] HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as {
        choices?: {
          message?: { content?: string | null; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (sb) {
        await recordGroqCall(sb, {
          status: res.status,
          model: ai.agentModel,
          tokIn: data.usage?.prompt_tokens,
          tokOut: data.usage?.completion_tokens,
          headers: res.headers,
        });
      }
      // Theo dõi quota qua log Vercel: token mỗi lần gọi + phần còn lại theo header.
      console.log(
        `[Bee AI] ok model=${ai.agentModel} ${Date.now() - t0}ms in=${data.usage?.prompt_tokens ?? "?"} out=${
          data.usage?.completion_tokens ?? "?"
        } còn_req_ngày=${res.headers?.get?.("x-ratelimit-remaining-requests") ?? "?"} còn_tok_phút=${
          res.headers?.get?.("x-ratelimit-remaining-tokens") ?? "?"
        }`
      );
      const m = data.choices?.[0]?.message;
      if (!m) return null;
      return {
        content: m.content ?? "",
        tool_calls: m.tool_calls?.length ? m.tool_calls : undefined,
        finish: data.choices?.[0]?.finish_reason,
      };
    } catch (e) {
      console.error("Bee agent lỗi:", e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Mốc giữa ca của HÔM NAY (giờ VN) để dựng báo cáo đúng ca được hỏi — cùng cách
// cron dựng báo cáo cuối ca. Không chỉ định ca -> giữ thời điểm hiện tại.
export function shiftMoment(now: Date, ca: unknown): Date {
  const hour = ca === "sang" ? 10 : ca === "chieu" ? 15 : ca === "toi" ? 19 : null;
  if (hour === null) return now;
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hour - 7, 0, 0));
}

function toScope(v: unknown): CaseScope {
  return v === "qll" || v === "htkt" ? v : "all";
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    deps: AiDeps;
    message: TelegramMessage;
    isPrivate: boolean;
    title: string;
    now: Date;
    notes: string[];
  }
): Promise<string> {
  const { deps, message, isPrivate, title, now } = ctx;
  try {
    switch (name) {
      case "xem_so_lieu":
        return await buildDayCaseStats(deps.supabase, now);
      case "xem_bao_cao_ca":
        return stripHtml(await buildShiftReport(deps.supabase, deps.checkinSupabase, shiftMoment(now, args.ca)));
      case "tra_cuu_case":
        return await lookupCases(deps.supabase, String(args.tu_khoa ?? ""), true);
      case "xem_ctv":
        return await ctvToday(deps.supabase, String(args.username ?? ""), now);
      case "xem_cau_hinh":
        return `${await configSummary(deps.supabase, now)}\n${await leaveForwardSummary(deps.supabase, now)}`;
      case "gui_tin_nhom": {
        let replyUser = String(args.tra_loi_cho ?? "").trim().replace(/^@/, "").toLowerCase();
        if (replyUser === "admin") replyUser = `id:${message.from?.id ?? 0}`;
        const r = await sendToGroup(
          deps,
          String(args.ten_nhom ?? ""),
          sanitizeReply(String(args.noi_dung ?? "")),
          replyUser,
          now.getTime()
        );
        return `KẾT QUẢ THẬT (báo đúng như vậy): ${r}`;
      }
      case "xem_cac_nhom":
        return await listGroups(deps.supabase, deps.ai, now.getTime());
      case "xem_nhom":
        return await readGroup(deps.supabase, String(args.ten_nhom ?? ""), now.getTime());
      case "xem_han_muc":
        return deps.ai ? await buildQuotaReport(deps.supabase, deps.ai, now) : "Bee AI đang tắt.";
      case "xem_checkin":
        return deps.checkinSupabase
          ? await buildCheckinList(deps.checkinSupabase, now)
          : "Chưa cấu hình dữ liệu check-in.";
      case "gui_danh_sach": {
        const loai = String(args.loai ?? "");
        if (loai === "bao_cao") {
          const html = await buildShiftReport(deps.supabase, deps.checkinSupabase, now);
          await sendHere(deps, message, isPrivate, html, true);
          return "Đã gửi bảng báo cáo ca vào cuộc trò chuyện.";
        }
        if (loai === "checkin") {
          const t = deps.checkinSupabase
            ? await buildCheckinList(deps.checkinSupabase, now)
            : "Dạ chức năng check-in chưa được cấu hình ạ 🥺";
          await sendHere(deps, message, isPrivate, t);
          return "Đã gửi danh sách check-in.";
        }
        const list = await buildPendingCases(deps.supabase, now, toScope(args.nhom));
        await sendHere(deps, message, isPrivate, list);
        return `Đã gửi danh sách case tồn. Nội dung: ${list.replace(/https?:\/\/\S+/g, "").slice(0, 400)}`;
      }
      case "nhan_nhom": {
        let scope = toScope(args.nhom);
        if (scope === "all") scope = detectScope(foldVi(message.reply_to_message?.text ?? ""));
        const cau = sanitizeReply(String(args.cau_nhac ?? ""));
        const r = await remindGroups(deps, scope, title, now, cau.length >= 5 ? cau : "");
        return `KẾT QUẢ THẬT (báo đúng như vậy): ${r}`;
      }
      case "tag_ctv": {
        const nhom = args.nhom === "qll" ? "qll" : args.nhom === "htkt" ? "htkt" : null;
        if (!nhom) return "Chưa rõ nhóm QLL hay HTKT, hãy hỏi lại admin.";
        const users = (Array.isArray(args.usernames) ? args.usernames : [])
          .map((u) => String(u).trim().replace(/^@/, "").toLowerCase())
          .filter((u) => /^[a-z0-9_]{3,32}$/.test(u));
        if (users.length === 0) return "Chưa rõ tag ai, hãy hỏi lại admin (cần username).";
        const loiNhan = sanitizeReply(String(args.loi_nhan ?? "")) || "nhờ mình hỗ trợ giúp em nhé 😊";
        const r = await tagInGroup(deps, nhom, users.slice(0, 5), String(args.ma_case ?? ""), loiNhan);
        return `KẾT QUẢ THẬT (báo đúng như vậy): ${r}`;
      }
      case "hen_tag_ca_chieu": {
        const scope = toScope(args.nhom);
        const r = await scheduleHandoff(deps.supabase, scope, message.from?.id ?? 0, now);
        if (r === "sent") return "Hôm nay đã tag CTV ca chiều rồi.";
        if (r === "error") return "Lỗi, chưa lưu được lịch.";
        return handoffTimeNow(now) >= HANDOFF_START_H
          ? "Đã lưu lịch; vì đã quá 13h30 nên sẽ tag trong vài phút tới."
          : "Đã lưu lịch; sau 13h30 sẽ tự tag CTV ca chiều.";
      }
      case "ghi_nho": {
        const note = String(args.noi_dung ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
        if (note.length < 3) return "Nội dung trống, chưa ghi.";
        // Chặn ghi số liệu tạm thời vào bộ não lâu dài.
        if (/hôm nay|hiện tại|còn \d+ case|\d+ case tồn/i.test(note)) {
          return "Không ghi: đây là số liệu tạm thời, không phải điều cần nhớ lâu dài.";
        }
        const list = ctx.notes.filter((x) => x !== note);
        list.push(note);
        ctx.notes = list.slice(-MAX_NOTES);
        return (await saveNotes(deps.supabase, ctx.notes))
          ? `Đã ghi nhớ (điều số ${ctx.notes.length}).`
          : "Lỗi, chưa ghi được.";
      }
      case "quen": {
        const so = Number(args.so ?? -1);
        if (so === 0) ctx.notes = [];
        else if (so >= 1 && so <= ctx.notes.length) ctx.notes = ctx.notes.filter((_, i) => i !== so - 1);
        else return "Không có điều số đó.";
        return (await saveNotes(deps.supabase, ctx.notes)) ? "Đã xóa." : "Lỗi, chưa xóa được.";
      }
      default:
        return "Không có công cụ này.";
    }
  } catch (e) {
    console.error(`Bee tool ${name} lỗi:`, e instanceof Error ? e.message : String(e));
    return "Công cụ bị lỗi, chưa lấy được dữ liệu.";
  }
}

export async function runAgent(
  deps: AiDeps,
  ai: AiConfig,
  message: TelegramMessage,
  isPrivate: boolean,
  question: string,
  title: string,
  now: Date
): Promise<string | null> {
  const deadline = Date.now() + AGENT_DEADLINE_MS;
  const ctx = {
    deps,
    message,
    isPrivate,
    title,
    now,
    notes: await loadNotes(deps.supabase),
  };
  const history = message.from ? await loadHistory(deps.supabase, convKey(message), now.getTime()) : [];
  // Admin reply vào 1 tin cụ thể -> đưa nội dung tin đó vào làm ngữ cảnh.
  const quoted = (message.reply_to_message?.text ?? "").replace(/https?:\/\/\S+/g, "").slice(0, 300);
  const userText =
    (quoted ? `(đang trả lời tin: "${quoted}")\n` : "") + question.slice(0, MAX_QUESTION_CHARS);

  const messages: AgentMsg[] = [
    { role: "system", content: agentSystem(title, ctx.notes, now, isPrivate) },
    ...history.map((h) => ({ role: h.role, content: h.content.slice(0, 200) })),
    { role: "user", content: userText },
  ];

  let acted = false; // đã thực thi công cụ có tác dụng thật (gửi/ghi)
  let sentOk = false; // lượt này có công cụ GỬI nào báo thành công thật không
  let why = "hết vòng";
  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    // Vòng cuối: KHÔNG cho gọi công cụ nữa -> AI buộc phải trả lời bằng dữ liệu
    // đã lấy được, thay vì bỏ dở (trước đây rơi vào "Bee đang hơi bận").
    const lastRound = round === AGENT_MAX_ROUNDS - 1;
    const m = await agentCall(ai, messages, deadline, !lastRound, deps.supabase);
    if (!m) {
      why = "gọi AI thất bại";
      break;
    }
    if (!m.tool_calls || lastRound) {
      const text = plainText(m.content).slice(0, 1500);
      if (text === "") {
        why = `AI trả rỗng (finish=${m.finish ?? "?"})`;
        break;
      }
      // Chốt chặn: không cho Bee nhận "đã gửi" khi lượt này không có công cụ
      // gửi nào thành công thật (AI hay "tưởng tượng" ra hành động).
      const final = claimsSent(text) && !sentOk ? FAKE_SEND_FIX : text;
      if (final !== text) console.error(`[Bee AI] chặn câu nhận đã gửi sai: ${text.slice(0, 120)}`);
      await sendHere(deps, message, isPrivate, final);
      return final;
    }
    messages.push({ role: "assistant", content: m.content, tool_calls: m.tool_calls });
    for (const tc of m.tool_calls.slice(0, 3)) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // tham số hỏng -> chạy với {}
      }
      const result = await runTool(tc.function.name, args, ctx);
      if (/^(gui_danh_sach|nhan_nhom|tag_ctv|gui_tin_nhom|hen_tag_ca_chieu|ghi_nho|quen)$/.test(tc.function.name)) {
        acted = true;
      }
      if (/^(nhan_nhom|tag_ctv|gui_tin_nhom|gui_danh_sach|hen_tag_ca_chieu)$/.test(tc.function.name) && /Đã (gửi|tag|nhắn|lưu lịch)|em nhắn nhóm/i.test(result)) {
        sentOk = true;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 1200) });
    }
  }
  // Đã làm việc thật nhưng không kịp nói câu cuối -> báo ngắn, KHÔNG rơi về luồng
  // cũ (tránh làm lặp hành động).
  console.error(`[Bee AI] không ra câu trả lời: ${why}`);
  if (acted) {
    const text = `Dạ em làm xong rồi ạ ${title} 😊`;
    await sendHere(deps, message, isPrivate, text);
    return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Công cụ CHỈ ĐỌC bổ sung cho Bee (không ghi DB, không đổi nghiệp vụ)
// ---------------------------------------------------------------------------

function vnHHmm(iso: string | null): string {
  if (!iso) return "?";
  const vn = new Date(new Date(iso).getTime() + VN_OFFSET_MS);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())} ${p(vn.getUTCDate())}/${p(vn.getUTCMonth() + 1)}`;
}

function caseLink(scopedId: number): { group: string; link: string } {
  if (scopedId > 0) return { group: "QLL", link: `https://t.me/c/${QLL_LINK_ID}/${scopedId}` };
  return { group: "HTKT", link: `https://t.me/c/${HTKT_LINK_ID}/${Math.round((-scopedId - 1) / 10)}` };
}

// Tìm case theo từ khóa trong qll_tracking (dữ liệu giữ ~3 ngày). withLinks=false
// khi gửi cho AI đọc thì vẫn kèm link để AI có thể dẫn lại cho admin.
export async function lookupCases(
  supabase: SupabaseClient,
  keyword: string,
  withLinks: boolean
): Promise<string> {
  const kw = keyword.replace(/[%,()*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (kw.length < 3) return "Từ khóa quá ngắn (cần ít nhất 3 ký tự).";
  const { data, error } = await supabase
    .from("qll_tracking")
    .select("message_id, sender_name, content, handled, created_at")
    .ilike("content", `%${kw}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  const rows =
    (data as {
      message_id: number;
      sender_name: string | null;
      content: string | null;
      handled: boolean;
      created_at: string | null;
    }[] | null) ?? [];
  if (rows.length === 0) return `Không tìm thấy case nào chứa "${kw}" trong 3 ngày gần nhất.`;

  // Ai đã tương tác (tim/reply) với các case này.
  const who = new Map<number, string[]>();
  try {
    const { data: inter } = await supabase
      .from("shift_interactions")
      .select("message_id, ctv_username, kind")
      .in(
        "message_id",
        rows.map((r) => r.message_id)
      );
    for (const r of (inter as { message_id: number; ctv_username: string | null; kind: string | null }[] | null) ??
      []) {
      const list = who.get(r.message_id) ?? [];
      list.push(`${r.ctv_username ?? "?"} (${r.kind === "react" ? "tim" : "reply"})`);
      who.set(r.message_id, list);
    }
  } catch {
    // không có thông tin người xử lý -> bỏ qua
  }

  return rows
    .map((r, i) => {
      const { group, link } = caseLink(r.message_id);
      const by = who.get(r.message_id);
      return [
        `${i + 1}. [${group}] ${vnHHmm(r.created_at)} — ${snip(r.content)}`,
        `   ${r.handled ? "Đã xử lý" : "CHƯA xử lý"}${by?.length ? ` — ${by.join(", ")}` : ""}`,
        withLinks ? `   ${link}` : "",
      ]
        .filter((l) => l !== "")
        .join("\n");
    })
    .join("\n");
}

// Hôm nay 1 CTV đã tương tác bao nhiêu case (đọc shift_interactions).
export async function ctvToday(supabase: SupabaseClient, username: string, now: Date): Promise<string> {
  const u = username.trim().replace(/^@/, "").toLowerCase();
  if (u === "") return "Thiếu username CTV.";
  const { data, error } = await supabase
    .from("shift_interactions")
    .select("message_id, kind, shift")
    .eq("ctv_username", u)
    .eq("shift_date", vnDay(now));
  if (error) throw new Error(error.message);
  const rows = (data as { message_id: number; kind: string | null; shift: string | null }[] | null) ?? [];
  if (rows.length === 0) return `Hôm nay ${u} chưa có lượt xử lý case nào được ghi nhận.`;
  const all = new Set<number>();
  const byShift = new Map<string, Set<number>>();
  let react = 0;
  let reply = 0;
  for (const r of rows) {
    all.add(r.message_id);
    const s = r.shift ?? "?";
    if (!byShift.has(s)) byShift.set(s, new Set());
    byShift.get(s)!.add(r.message_id);
    if (r.kind === "react") react++;
    else if (r.kind === "reply") reply++;
  }
  const qll = [...all].filter((id) => id > 0).length;
  const name: Record<string, string> = { sang: "sáng", chieu: "chiều", toi: "tối" };
  const shifts = [...byShift.entries()].map(([s, set]) => `ca ${name[s] ?? s}: ${set.size}`).join(", ");
  return `Hôm nay ${u} xử lý ${all.size} case (QLL ${qll}, HTKT ${all.size - qll}; tim ${react}, reply ${reply}). Theo ca: ${shifts}.`;
}

// Cấu hình đang áp dụng: điều phối từng ca, SLA tắt cho ai, lịch tag, lệnh bot.
export async function configSummary(supabase: SupabaseClient, now: Date): Promise<string> {
  const cfg = await loadMonitorConfig(supabase);
  const today = vnDay(now);
  const slaOff = cfg.slaExcludeDate === today ? cfg.slaExclude ?? [] : [];
  const handoff = await describeHandoff(supabase, now);
  const commands = buildHelpText()
    .split("\n")
    .filter((l) => l.trim().startsWith("/") || l.includes("/"))
    .slice(0, 25)
    .join("\n");
  return [
    `Điều phối: sáng ${cfg.sang || "?"}, chiều ${cfg.chieu || "?"}, tối ${cfg.toi || "?"} (mặc định ${cfg.defaultDp || "?"}).`,
    `Đang tắt SLA hôm nay: ${slaOff.length ? slaOff.join(", ") : "không ai"}.`,
    handoff ? `Lịch tag ca chiều: ${handoff}` : "Lịch tag ca chiều: chưa có.",
    "Lệnh bot (admin gõ ở chat riêng):",
    commands,
  ].join("\n");
}

// Tìm tin case gần nhất trong 1 nhóm theo mã/từ khóa (3 ngày dữ liệu).
// Trả id tin THẬT trong nhóm (HTKT đổi ngược từ id âm phái sinh).
async function findCaseMessage(
  supabase: SupabaseClient,
  nhom: "qll" | "htkt",
  keyword: string
): Promise<{ realId: number; content: string | null } | null> {
  const kw = keyword.replace(/[%,()*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (kw.length < 3) return null;
  let q = supabase.from("qll_tracking").select("message_id, content").ilike("content", `%${kw}%`);
  q = nhom === "qll" ? q.gt("message_id", 0) : q.lt("message_id", 0);
  const { data } = await q.order("created_at", { ascending: false }).limit(1);
  const row = (data as { message_id: number; content: string | null }[] | null)?.[0];
  if (!row) return null;
  const realId = row.message_id > 0 ? row.message_id : Math.round((-row.message_id - 1) / 10);
  return { realId, content: row.content };
}

// Tag đúng người trong nhóm; có mã case thì reply vào tin case đó. Trả mô tả kết
// quả thật (để AI báo lại đúng).
async function tagInGroup(
  deps: AiDeps,
  nhom: "qll" | "htkt",
  users: string[],
  maCase: string,
  loiNhan: string
): Promise<string> {
  const chatId = nhom === "qll" ? QLL_CHAT_ID : HTKT_CHAT_ID;
  const label = nhom.toUpperCase();
  let replyTo: number | undefined;
  let note = "";
  if (maCase.trim() !== "") {
    const found = await findCaseMessage(deps.supabase, nhom, maCase);
    if (found) replyTo = found.realId;
    else note = ` (không tìm thấy tin case "${maCase}" trong ${label} nên đăng tin riêng)`;
  }
  const text = `${users.map((u) => `@${u}`).join(" ")} ${loiNhan}`;
  const res = await deps.telegram.sendMessage(chatId, text, replyTo);
  if (!res.ok) return `Chưa gửi được vào nhóm ${label}.`;
  return replyTo
    ? `Đã tag ${users.join(", ")} ngay dưới tin case ${maCase} trong nhóm ${label}.`
    : `Đã tag ${users.join(", ")} trong nhóm ${label}${note}.`;
}

// ---------------------------------------------------------------------------
// Sổ theo dõi hạn mức Groq (1 dòng trong pending_batches, không đổi schema)
// ---------------------------------------------------------------------------
const USAGE_ROW_ID = -9103;
const GROQ_FREE_TPD = 200_000; // token/ngày gói free (để ước tính, theo docs Groq)

interface UsageRow {
  kind: "groq_usage";
  day: string;
  calls: number;
  ok: number;
  errors: number;
  rate429: number;
  tokIn: number;
  tokOut: number;
  model?: string;
  lastAt?: string;
  remReq?: string; // lượt còn trong ngày (header Groq)
  limReq?: string;
  remTok?: string; // token còn trong phút (header Groq)
  limTok?: string;
}

export interface GroqCallMeta {
  status: number; // 0 = lỗi mạng/timeout
  model: string;
  tokIn?: number;
  tokOut?: number;
  headers?: { get(k: string): string | null } | null;
}

async function readUsage(supabase: SupabaseClient, day: string): Promise<UsageRow> {
  const empty: UsageRow = { kind: "groq_usage", day, calls: 0, ok: 0, errors: 0, rate429: 0, tokIn: 0, tokOut: 0 };
  try {
    const { data } = await supabase
      .from("pending_batches")
      .select("items")
      .eq("admin_id", USAGE_ROW_ID)
      .maybeSingle();
    const it = data?.items as Partial<UsageRow> | undefined;
    if (!it || it.kind !== "groq_usage") return empty;
    // Sang ngày mới: reset bộ đếm, giữ lại header gần nhất để còn tham khảo.
    if (it.day !== day) return { ...empty, model: it.model, lastAt: it.lastAt, remReq: it.remReq, limReq: it.limReq, remTok: it.remTok, limTok: it.limTok };
    return { ...empty, ...it } as UsageRow;
  } catch {
    return empty;
  }
}

// Ghi 1 lần gọi Groq. Đọc-rồi-ghi (không nguyên tử): lệch vài lượt khi trùng
// thời điểm là chấp nhận được. Không bao giờ ném lỗi.
export async function recordGroqCall(supabase: SupabaseClient, meta: GroqCallMeta, now = new Date()): Promise<void> {
  try {
    const u = await readUsage(supabase, vnDay(now));
    u.calls++;
    if (meta.status >= 200 && meta.status < 300) u.ok++;
    else u.errors++;
    if (meta.status === 429) u.rate429++;
    u.tokIn += meta.tokIn ?? 0;
    u.tokOut += meta.tokOut ?? 0;
    u.model = meta.model;
    u.lastAt = now.toISOString();
    const h = meta.headers;
    const g = (k: string) => h?.get?.(k) ?? undefined;
    u.remReq = g("x-ratelimit-remaining-requests") ?? u.remReq;
    u.limReq = g("x-ratelimit-limit-requests") ?? u.limReq;
    u.remTok = g("x-ratelimit-remaining-tokens") ?? u.remTok;
    u.limTok = g("x-ratelimit-limit-tokens") ?? u.limTok;
    await supabase
      .from("pending_batches")
      .upsert({ admin_id: USAGE_ROW_ID, items: u }, { onConflict: "admin_id" });
  } catch {
    // bỏ qua: thống kê không được làm hỏng luồng chính
  }
}

function fmtNum(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : n;
  return v === undefined || !Number.isFinite(v) ? "?" : v.toLocaleString("vi-VN");
}

// Câu trả lời hạn mức — TypeScript dựng, KHÔNG tốn lượt AI.
export async function buildQuotaReport(supabase: SupabaseClient, ai: AiConfig, now: Date): Promise<string> {
  const day = vnDay(now);
  const u = await readUsage(supabase, day);
  let beeCount = 0;
  try {
    const { data } = await supabase
      .from("pending_batches")
      .select("items")
      .eq("admin_id", quotaRowId(day))
      .maybeSingle();
    const it = data?.items as { day?: string; count?: number } | undefined;
    if (it?.day === day && typeof it.count === "number") beeCount = it.count;
  } catch {
    // bỏ qua
  }
  const tok = u.tokIn + u.tokOut;
  const pct = Math.round((tok / GROQ_FREE_TPD) * 100);
  const lines = [
    "Hạn mức hôm nay của Bee nè 😊",
    `• Groq (${u.model ?? ai.agentModel}): gọi ${u.calls} lần (thành công ${u.ok}, lỗi ${u.errors}, bị giới hạn 429: ${u.rate429})`,
    `• Token Bee đã dùng hôm nay: vào ${fmtNum(u.tokIn)}, ra ${fmtNum(u.tokOut)} → ${fmtNum(tok)}/${fmtNum(GROQ_FREE_TPD)} token/ngày (${pct}%)`,
  ];
  if (u.remReq && u.limReq) {
    // Số thật từ header Groq, tính cho CẢ key (gồm mọi nơi dùng chung key).
    const used = Number(u.limReq) - Number(u.remReq);
    lines.push(
      `• Groq (số thật, lúc ${u.lastAt ? vnHHmm(u.lastAt) : "?"}): đã dùng ${fmtNum(used)}/${fmtNum(u.limReq)} lượt hôm nay, còn ${fmtNum(u.remReq)} lượt`
    );
  }
  if (u.remTok && u.limTok) {
    lines.push(
      `• Token trong 1 phút: còn ${fmtNum(u.remTok)}/${fmtNum(u.limTok)} (tự hồi lại sau mỗi phút, không phải hạn mức ngày)`
    );
  }
  lines.push(`• Trần riêng của Bee: ${beeCount}/${ai.dailyCap} tin nhắn cần AI`);
  lines.push("• Vercel, Supabase: em chưa có quyền đọc, anh xem ở trang Usage của từng hệ thống nhé.");
  if (pct >= 80 || u.rate429 > 0) {
    lines.push("Lưu ý: sắp chạm hạn mức hoặc đã bị giới hạn, Bee có thể trả lời chậm hoặc báo bận.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sổ nhóm: Bee tự ghi nhận các nhóm mình đang ở (Telegram không có API liệt kê)
// ---------------------------------------------------------------------------
// - Sổ nhóm: 1 dòng pending_batches (admin_id -9104): id, tên, lần cuối thấy tin.
// - Tin gần đây của nhóm NGOÀI QLL/HTKT: 1 dòng/nhóm, admin_id = chatId - 3e12
//   (không đụng id admin thật/dương, -9xxx, id theo ngày ~ -2e9). Giữ 30 tin, 24h.
// - QLL/HTKT đã có tracking riêng (qll_tracking) -> chỉ ghi vào sổ nhóm.
const GROUPS_ROW_ID = -9104;
const GROUP_LOG_OFFSET = 3_000_000_000_000;
const GROUP_LOG_MAX = 30;
const GROUP_LOG_TTL_MS = 24 * 3600_000;
const REGISTRY_REFRESH_MS = 10 * 60_000;
const TRACKED_GROUPS = new Set([QLL_CHAT_ID, HTKT_CHAT_ID]);
// Bộ nhớ tạm theo instance: tránh ghi sổ nhóm mỗi tin (nhóm QLL rất đông).
const registrySeen = new Map<number, number>();
// Chỉ dùng trong test (mỗi test một DB giả).
export function resetGroupCacheForTest(): void {
  registrySeen.clear();
}

interface GroupInfo {
  title: string;
  type: string;
  lastSeen: string;
}
interface GroupLogItem {
  t: number;
  from: string;
  text: string;
  mid: number;
  replyTo?: number;
  uid?: number;
}

function groupLogRowId(chatId: number): number {
  return chatId - GROUP_LOG_OFFSET;
}

async function readRow<T>(supabase: SupabaseClient, id: number): Promise<T | undefined> {
  const { data } = await supabase.from("pending_batches").select("items").eq("admin_id", id).maybeSingle();
  return (data?.items as T | undefined) ?? undefined;
}

async function writeRow(supabase: SupabaseClient, id: number, items: unknown): Promise<void> {
  await supabase.from("pending_batches").upsert({ admin_id: id, items }, { onConflict: "admin_id" });
}

export async function observeGroup(supabase: SupabaseClient, message: TelegramMessage, now: Date): Promise<void> {
  try {
    const chatId = message.chat.id;
    const nowMs = now.getTime();
    const title = message.chat.title ?? String(chatId);

    // 1) Sổ nhóm (giới hạn ghi: nhóm mới với instance này, hoặc >10 phút).
    const last = registrySeen.get(chatId);
    if (last === undefined || nowMs - last > REGISTRY_REFRESH_MS) {
      const reg = (await readRow<{ kind?: string; groups?: Record<string, GroupInfo> }>(supabase, GROUPS_ROW_ID)) ?? {};
      const groups = reg.kind === "groups" && reg.groups ? reg.groups : {};
      groups[String(chatId)] = { title, type: message.chat.type, lastSeen: now.toISOString() };
      await writeRow(supabase, GROUPS_ROW_ID, { kind: "groups", groups });
      registrySeen.set(chatId, nowMs); // chỉ đánh dấu sau khi ghi xong
    }

    // 2) Tin gần đây (chỉ nhóm ngoài QLL/HTKT).
    if (TRACKED_GROUPS.has(chatId)) return;
    const raw = (message.text ?? message.caption ?? "").trim();
    if (raw === "") return;
    const f = message.from;
    const who = f?.username ? f.username : [f?.first_name, f?.last_name].filter(Boolean).join(" ") || "?";
    const item: GroupLogItem = {
      t: nowMs,
      from: f?.is_bot ? `${who} (bot)` : who,
      text: isSensitive(raw) ? "[tin có tài khoản/mật khẩu/số dài, đã ẩn]" : raw.replace(/\s+/g, " ").slice(0, 200),
      mid: message.message_id,
      replyTo: message.reply_to_message?.message_id,
      uid: f?.id,
    };
    const id = groupLogRowId(chatId);
    const cur = (await readRow<{ kind?: string; items?: GroupLogItem[] }>(supabase, id)) ?? {};
    const items = (cur.kind === "grouplog" && Array.isArray(cur.items) ? cur.items : []).filter(
      (x) => nowMs - x.t < GROUP_LOG_TTL_MS
    );
    items.push(item);
    await writeRow(supabase, id, { kind: "grouplog", chatId, title, items: items.slice(-GROUP_LOG_MAX) });
  } catch {
    // ghi sổ lỗi không được làm hỏng luồng chính
  }
}

async function loadGroups(supabase: SupabaseClient): Promise<[number, GroupInfo][]> {
  const reg = await readRow<{ kind?: string; groups?: Record<string, GroupInfo> }>(supabase, GROUPS_ROW_ID);
  const groups = reg?.kind === "groups" && reg.groups ? reg.groups : {};
  return Object.entries(groups)
    .map(([k, v]) => [Number(k), v] as [number, GroupInfo])
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
}

// Bot còn trong nhóm không (gọi Telegram, không tốn Groq). Không có token -> "?".
async function botStatusIn(ai: AiConfig | undefined, chatId: number): Promise<string> {
  if (!ai?.botToken) return "?";
  try {
    const botId = ai.botToken.split(":")[0];
    const res = await fetch(
      `https://api.telegram.org/bot${ai.botToken}/getChatMember?chat_id=${chatId}&user_id=${botId}`
    );
    const j = (await res.json()) as { ok?: boolean; result?: { status?: string } };
    const s = j.result?.status;
    if (!j.ok || !s) return "không truy cập được (có thể đã bị xóa khỏi nhóm)";
    if (s === "administrator") return "admin";
    if (s === "member" || s === "restricted") return "thành viên";
    return "đã rời nhóm";
  } catch {
    return "?";
  }
}

export async function listGroups(supabase: SupabaseClient, ai: AiConfig | undefined, nowMs: number): Promise<string> {
  const groups = await loadGroups(supabase);
  if (groups.length === 0) {
    return "Em chưa ghi nhận nhóm nào. Nhóm sẽ hiện ở đây sau khi có tin nhắn đầu tiên trong nhóm (kể từ bản cập nhật này).";
  }
  const lines = await Promise.all(
    groups.slice(0, 15).map(async ([id, g], i) => {
      const role = TRACKED_GROUPS.has(id) ? "theo dõi case" : "chỉ đọc tin gần đây";
      const ago = Math.round((nowMs - Date.parse(g.lastSeen)) / 60_000);
      const agoText = ago < 60 ? `${ago} phút trước` : `${Math.round(ago / 60)} giờ trước`;
      return `${i + 1}. ${g.title} (${role}) — tin gần nhất ${agoText}, bot: ${await botStatusIn(ai, id)}`;
    })
  );
  return [`Bee đang biết ${groups.length} nhóm:`, ...lines].join("\n");
}

// Đọc tin gần đây của 1 nhóm theo tên (khớp gần đúng, bỏ dấu).
export async function readGroup(supabase: SupabaseClient, name: string, nowMs: number): Promise<string> {
  const q = foldVi(name);
  const groups = await loadGroups(supabase);
  const hit =
    groups.find(([, g]) => foldVi(g.title) === q) ??
    groups.find(([, g]) => q !== "" && foldVi(g.title).includes(q)) ??
    groups.find(([, g]) => q.split(" ").filter((w) => w.length > 1).every((w) => foldVi(g.title).includes(w)));
  if (!hit) {
    const known = groups.map(([, g]) => g.title).join("; ") || "(chưa có)";
    return `Không thấy nhóm nào tên giống "${name}". Các nhóm em biết: ${known}.`;
  }
  const [id, g] = hit;
  if (TRACKED_GROUPS.has(id)) {
    return `"${g.title}" là nhóm theo dõi case. Dùng xem_so_lieu / gui_danh_sach / tra_cuu_case để xem.`;
  }
  const log = await readRow<{ kind?: string; items?: GroupLogItem[] }>(supabase, groupLogRowId(id));
  const items = (log?.kind === "grouplog" && Array.isArray(log.items) ? log.items : []).filter(
    (x) => nowMs - x.t < GROUP_LOG_TTL_MS
  );
  if (items.length === 0) return `Nhóm "${g.title}": chưa có tin nào trong 24 giờ qua mà em thấy.`;
  const repliedTo = new Set(items.map((x) => x.replyTo).filter((x): x is number => x !== undefined));
  const lines = items.slice(-20).map((x) => {
    const mark = repliedTo.has(x.mid) ? " (đã có người trả lời)" : "";
    return `${vnHHmm(new Date(x.t).toISOString())} ${x.from}: ${x.text}${mark}`;
  });
  return [`Nhóm "${g.title}" — ${items.length} tin trong 24h qua (hiện ${lines.length} tin gần nhất):`, ...lines].join(
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Gửi tin vào nhóm theo tên + chốt chặn "nhận đã gửi" sai
// ---------------------------------------------------------------------------
const FAKE_SEND_FIX =
  "Em xin lỗi, em chưa gửi được tin nào thật ạ 🥺 Anh nói lại giúp em: gửi vào nhóm nào và nội dung gì nhé.";

// Câu trả lời có khẳng định đã gửi/nhắn/tag/đăng không.
export function claimsSent(text: string): boolean {
  const s = text.normalize("NFC").toLowerCase();
  return /(đã|vừa|rồi).{0,20}(gửi|nhắn|tag|đăng|rep)|(gửi|nhắn|tag|đăng|rep).{0,30}(rồi|xong)/.test(s) &&
    !/(chưa|không) (gửi|nhắn|tag|đăng)/.test(s);
}

async function findGroupByName(
  supabase: SupabaseClient,
  name: string
): Promise<[number, GroupInfo] | undefined> {
  const q = foldVi(name);
  const groups = await loadGroups(supabase);
  return (
    groups.find(([, g]) => foldVi(g.title) === q) ??
    groups.find(([, g]) => q !== "" && foldVi(g.title).includes(q)) ??
    groups.find(([, g]) => {
      const words = q.split(" ").filter((w) => w.length > 1);
      return words.length > 0 && words.every((w) => foldVi(g.title).includes(w));
    })
  );
}

// Gửi tin vào nhóm (tìm theo tên trong sổ nhóm). replyUser: reply vào tin gần
// nhất của người đó (chỉ nhóm có lưu tin gần đây). Trả mô tả kết quả THẬT.
export async function sendToGroup(
  deps: AiDeps,
  name: string,
  text: string,
  replyUser: string,
  nowMs: number
): Promise<string> {
  if (text.trim().length < 1) return "Chưa có nội dung để gửi, hãy hỏi lại admin.";
  const hit = await findGroupByName(deps.supabase, name);
  if (!hit) {
    const known = (await loadGroups(deps.supabase)).map(([, g]) => g.title).join("; ") || "(chưa có)";
    return `Chưa gửi: không thấy nhóm tên "${name}". Các nhóm em biết: ${known}.`;
  }
  const [chatId, g] = hit;
  let replyTo: number | undefined;
  let note = "";
  if (replyUser) {
    const log = await readRow<{ kind?: string; items?: GroupLogItem[] }>(deps.supabase, groupLogRowId(chatId));
    const items = (log?.kind === "grouplog" && Array.isArray(log.items) ? log.items : []).filter(
      (x) => nowMs - x.t < GROUP_LOG_TTL_MS
    );
    const target = [...items].reverse().find((x) => {
      const who = x.from.toLowerCase();
      return replyUser.startsWith("id:")
        ? x.uid === Number(replyUser.slice(3))
        : who === replyUser || who.replace(" (bot)", "") === replyUser;
    });
    if (target) replyTo = target.mid;
    else note = ` (không thấy tin gần đây của ${replyUser} nên gửi tin mới)`;
  }
  const res = await deps.telegram.sendMessage(chatId, text, replyTo);
  if (!res.ok) return `Chưa gửi được vào nhóm "${g.title}" (Telegram từ chối, có thể bot không có quyền gửi tin).`;
  return `Đã gửi vào nhóm "${g.title}"${replyTo ? " (reply đúng tin)" : ""}${note}: "${text}"`;
}

// ---------------------------------------------------------------------------
// Che dữ liệu nhạy cảm trước khi gửi AI (chỉ dùng cho tin của admin)
// ---------------------------------------------------------------------------
// Câu tra số ngắn ("tra case 0964517258") -> luồng TypeScript cũ.
export function isShortLookup(q: string): boolean {
  const s = q.trim();
  return s.length <= 80 && !s.includes("\n");
}

// Che TK/MK + dãy số dài kiểu SĐT/STK (>= 8 chữ số). GIỮ mã lớp (TOAN.2026.1836),
// mã HS ngắn, giờ học... để AI vẫn hiểu form.
export function redactForAi(q: string): string {
  return q
    .replace(/(tk|mk|tài khoản|mật khẩu|password|pass)\s*[:：=]?\s*\S+/gi, "$1: [đã ẩn]")
    .replace(/(?<![A-Za-z0-9_.])\+?\d[\d \-]{6,}\d(?![A-Za-z0-9_])/g, (m) =>
      m.replace(/\D/g, "").length >= 8 ? "[số đã ẩn]" : m
    );
}


// ---------------------------------------------------------------------------
// FORM XIN NGHỈ (QLL) -> tự chuyển vào nhóm Cộng đồng. TypeScript, không tốn AI.
// ---------------------------------------------------------------------------
// Mẫu bắt buộc (đủ TẤT CẢ key, đúng thứ tự):
//   [Tên học sinh]
//   Code: [Dãy số]
//   Mã học sinh: [Mã HS] [Mã lớp] | [Tên môn] | LỚP [Khối] | [Chương trình] | Ngày vào lớp: [Ngày]
//   GV dạy: [Mã GV] - [Tên giáo viên]
//   [Khung giờ học]

// Bỏ dấu nhưng GIỮ dấu câu (":", "|", "-", "/") để kiểm cấu trúc.
function foldKeep(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

export interface LeaveForm {
  name: string;
  code: string;
  hs: string;
  cls: string;
}

export function parseLeaveForm(text: string): LeaveForm | null {
  const lines = (text ?? "")
    .normalize("NFC")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length < 5) return null;

  // 1) Dòng đầu: tên học sinh (chữ, không có ":", không bắt đầu bằng số).
  const name = lines[0];
  if (name.includes(":") || /^\d/.test(name) || !/\p{L}{2,}/u.test(name) || name.length > 60) return null;

  const f = lines.map(foldKeep);
  const idx = (re: RegExp, from: number) => {
    for (let i = from; i < f.length; i++) if (re.test(f[i])) return i;
    return -1;
  };

  // 2) Code: [Dãy số]
  const iCode = idx(/^code\s*:\s*\d{3,}\s*$/, 1);
  if (iCode < 0) return null;

  // 3) Mã học sinh: [Mã HS] ... [Mã lớp] | [Môn] | LỚP [Khối] | [Chương trình] | Ngày vào lớp: [Ngày]
  const iHs = idx(/^ma hoc sinh\s*:/, iCode + 1);
  if (iHs < 0) return null;
  const hsLine = f[iHs];
  const hs = hsLine.match(/^ma hoc sinh\s*:\s*(\d{3,})/)?.[1];
  const cls = lines[iHs].match(/[A-Za-z][A-Za-z_]*\.\d{4}\.\d{3,4}/)?.[0];
  if (!hs || !cls) return null;
  const parts = hsLine.split("|").map((p) => p.trim());
  if (parts.length < 5) return null;
  if (!parts.some((p) => /^lop\s+\S+/.test(p))) return null;
  if (!/ngay vao lop\s*:\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(hsLine)) return null;

  // 4) GV dạy: [Mã GV] - [Tên giáo viên]
  const iGv = idx(/^gv day\s*:\s*\S+\s*-\s*\S+/, iHs + 1);
  if (iGv < 0) return null;

  // 5) Khung giờ học: KHÔNG bắt buộc (admin chốt chỉ cần đủ K1-K6).

  const code = lines[iCode].replace(/^[^:]*:\s*/, "").trim();
  return { name, code, hs, cls: cls.toUpperCase() };
}

// Có ý XIN NGHỈ (dòng Mã HS hoặc cuối tin). Chấp nhận lỗi gõ thường gặp ("nghri").
// Bắt buộc vì QLL dùng CÙNG khung form cho cả xin muộn / out sớm / phản ánh.
export function hasLeaveIntent(text: string): boolean {
  const f = ` ${foldVi(text)} `;
  return / (xin|bao|cho|duoc|phep) (cho )?(con |hs |em |be )?ngh?r?it?( hoc| buoi| ca| a| nhe|) /.test(f) ||
    / (xin|bao) nghi /.test(f);
}

// Admin chốt: chuyển MỌI loại yêu cầu (xin nghỉ, xin muộn, out sớm, phản ánh...)
// miễn đủ K1-K6 của form. hasLeaveIntent giữ lại để Bee nói được loại yêu cầu.
export function isLeaveFormMessage(text: string): LeaveForm | null {
  return parseLeaveForm(text);
}

export const COMMUNITY_CHAT_ID = -1002556373370; // [BU VUIHOC VH] Cộng đồng VH - BGD
const LEAVE_ROW_ID = -9105;
const LEAVE_KEYS_MAX = 500;

// Tin QLL là form xin nghỉ đủ mẫu -> chuyển vào nhóm Cộng đồng. Mỗi (ngày, mã HS,
// mã lớp) chỉ chuyển 1 lần. Chiếm khóa TRƯỚC khi gửi để webhook lặp không gửi trùng.
// Không bao giờ ném lỗi; không đụng luồng tracking/SLA của QLL.
export async function applyLeaveForward(deps: AiDeps, ai: AiConfig, message: TelegramMessage): Promise<void> {
  try {
    if (message.chat.id !== QLL_CHAT_ID || message.from?.is_bot) return;
    const text = message.text ?? message.caption ?? "";
    if (extractMention(text, ai.botUsername).mentioned) return; // tin ra lệnh cho Bee
    const form = isLeaveFormMessage(text);
    if (!form) return;

    const day = vnDay(new Date());
    // Chống trùng theo TỪNG TIN (1 HS có thể vừa xin muộn vừa xin nghỉ trong ngày).
    const key = `${message.message_id}`;
    const cur = await readRow<{ kind?: string; day?: string; keys?: string[]; count?: number }>(
      deps.supabase,
      LEAVE_ROW_ID
    );
    const sameDay = cur?.kind === "leavefw" && cur.day === day;
    const keys = sameDay && Array.isArray(cur?.keys) ? cur!.keys! : [];
    if (keys.includes(key)) {
      console.log(`[Bee FW] bỏ qua form trùng ${key}`);
      return;
    }
    const count = (sameDay ? cur?.count ?? 0 : 0) + 1;
    await writeRow(deps.supabase, LEAVE_ROW_ID, {
      kind: "leavefw",
      day,
      keys: [...keys, key].slice(-LEAVE_KEYS_MAX),
      count,
    });

    let ok = false;
    if (ai.botToken) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${ai.botToken}/forwardMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: COMMUNITY_CHAT_ID,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
          }),
        });
        const j = (await res.json()) as { ok?: boolean; description?: string };
        ok = !!j.ok;
        if (!ok) console.error(`[Bee FW] forwardMessage lỗi: ${j.description ?? res.status}`);
      } catch (e) {
        console.error("[Bee FW] forwardMessage lỗi:", e instanceof Error ? e.message : String(e));
      }
    }
    if (!ok) {
      // Dự phòng (nhóm chặn chuyển tiếp / không có token): gửi bản sao kèm link gốc.
      const link = `https://t.me/c/${QLL_LINK_ID}/${message.message_id}`;
      const r = await deps.telegram.sendMessage(COMMUNITY_CHAT_ID, `${text}\n\n(Chuyển từ QLL: ${link})`.slice(0, 4000));
      ok = r.ok;
    }
    console.log(
      `[Bee FW] form QLL #${key} HS ${form.hs} ${form.cls} (${form.name}) -> Cộng đồng: ${ok ? "ok" : "lỗi"}`
    );
  } catch (e) {
    console.error("[Bee FW] lỗi (bỏ qua):", e instanceof Error ? e.message : String(e));
  }
}

// Số form xin nghỉ đã chuyển hôm nay (cho Bee trả lời admin).
export async function leaveForwardSummary(supabase: SupabaseClient, now: Date): Promise<string> {
  const cur = await readRow<{ kind?: string; day?: string; count?: number }>(supabase, LEAVE_ROW_ID);
  const n = cur?.kind === "leavefw" && cur.day === vnDay(now) ? cur.count ?? 0 : 0;
  return `Form QLL (đủ mẫu) đã tự chuyển sang nhóm Cộng đồng VH - BGD hôm nay: ${n}.`;
}
