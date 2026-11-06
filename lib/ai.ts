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
  buildShiftReport,
  getCurrentShiftCheckins,
  getCurrentShiftVn,
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
  | "hentag";
const INTENTS: readonly Intent[] = [
  "checkin",
  "baocao",
  "casetreo",
  "help",
  "chat",
  "checkout",
  "hentag",
];

// Câu dẫn trước số liệu (có sẵn, không tốn lượt AI).
const LEAD: readonly string[] = [
  "Dạ {title} xem nhé 😊",
  "Dạ em gửi {title} đây ạ 😊",
  "Dạ có ngay ạ, {title} xem giúp em nhé 😊",
  "Dạ đây ạ {title} 😊",
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
    botUsername: ((env.BOT_USERNAME ?? "").trim() || DEFAULT_BOT_USERNAME)
      .replace(/^@/, "")
      .toLowerCase(),
    dailyCap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, MAX_DAILY_CAP) : DEFAULT_DAILY_CAP,
    timeoutMs: 5000, // webhook Vercel ~10s -> AI tối đa 5s rồi bỏ cuộc
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

export function classifyByRules(folded: string): Intent | null {
  // Dặn Bee: đến ca chiều thì tag CTV ca chiều xử lý case tồn.
  if (
    /\b(tag|goi|nhac|nho|giao)\b.*\bctv\b.*\bca chieu\b/.test(folded) ||
    /\bca chieu\b.*\b(tag|goi|nhac|nho|giao)\b.*\bctv\b/.test(folded) ||
    /\b(den|khi|vao|luc|sau)\b.*\bca chieu\b.*\b(tag|goi|nhac|giao)\b/.test(folded) ||
    /\bchieu\b.*\b(tag|goi|nhac|giao)\b.*\bctv\b/.test(folded)
  ) {
    return "hentag";
  }
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
  "Dạ em đây ạ, {title} cần Bee hỗ trợ gì ạ? 😊",
  "Dạ Bee nghe ạ, {title} cứ nhắn nhé! 😊",
  "Chào {title} ạ, {title} cần em xem gì không ạ? 😊",
];
const THANKS: readonly string[] = [
  "Dạ không có chi ạ, cần gì {title} cứ gọi Bee nhé! 😊",
  "Dạ em cảm ơn {title} ạ, Bee luôn sẵn sàng! 😊",
];
const ACK: readonly string[] = [
  "Dạ vâng ạ 😊",
  "Dạ ok ạ, cần gì {title} cứ gọi Bee nhé! 😊",
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

function buildSystemPrompt(title: string, context: string): string {
  return [
    'Bạn là Bee (Tiểu Bee), trợ lý ong thân thiện của team CTV VHHS. Chỉ trả về MỘT đối tượng JSON: {"intent":"...","reply":"..."}.',
    "intent là một trong:",
    "- chat: mọi câu hỏi/trò chuyện có thể tự trả lời (kể cả hỏi về số liệu bên dưới)",
    "- checkin: chỉ khi người hỏi muốn xem NGUYÊN danh sách check-in",
    "- baocao: chỉ khi muốn xem NGUYÊN bảng báo cáo ca",
    "- casetreo: chỉ khi muốn xem NGUYÊN danh sách case chưa xử lý",
    "- help: hỏi Bee làm được gì",
    "- checkout: hỏi ai đã check-out/tan ca (Bee chưa có dữ liệu này)",
    "- hentag: dặn đến ca chiều thì tag CTV ca chiều xử lý case tồn",
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
      const pending = await buildPendingCases(deps.supabase, now);
      parts.push(pending.split("\n").filter((l) => !l.includes("t.me/")).join("\n"));
    } catch {
      // bỏ qua
    }
  }
  return parts.join("\n\n").slice(0, 3500);
}

// Thử tối đa 2 lần (lỗi lẻ tẻ của Groq thường qua được ở lần 2).
async function callGroq(
  ai: AiConfig,
  question: string,
  title: string,
  context = ""
): Promise<{ intent: Intent; reply: string } | null> {
  const first = await callGroqOnce(ai, question, title, context);
  if (first) return first;
  return await callGroqOnce(ai, question, title, context);
}

async function callGroqOnce(
  ai: AiConfig,
  question: string,
  title: string,
  context = ""
): Promise<{ intent: Intent; reply: string } | null> {
  const doFetch = ai.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: ai.model,
      messages: [
        { role: "system", content: buildSystemPrompt(title, context) },
        { role: "user", content: question.slice(0, MAX_QUESTION_CHARS) },
      ],
      temperature: 0.3,
      max_completion_tokens: 450,
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

function shiftStartUtcIso(now: Date, key: "sang" | "chieu" | "toi"): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const hour = key === "sang" ? 0 : key === "chieu" ? 13 : 17;
  const min = key === "sang" ? 0 : 30;
  return new Date(
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hour - 7, min, 0)
  ).toISOString();
}

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

export async function buildPendingCases(
  supabase: SupabaseClient,
  now: Date = new Date(),
  scope: CaseScope = "all"
): Promise<string> {
  const { key, label } = getCurrentShiftVn(now);
  const since = shiftStartUtcIso(now, key);
  const ca = label.toUpperCase();
  try {
    const out: string[] = [];
    const sections: [string, () => Promise<string[]>][] = [];
    if (scope !== "htkt") sections.push(["QLL", () => pendingQll(supabase, since)]);
    if (scope !== "qll") sections.push(["HTKT", () => pendingHtkt(supabase, since)]);
    for (const [name, run] of sections) {
      const [n, ...lines] = await run();
      if (n === "0") {
        out.push(`✅ ${name} ca ${ca}: không còn case nào tồn.`);
      } else {
        out.push(`📋 Case tồn ${name} — ca ${ca}: ${n}`, ...lines);
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
  const text = (message.text ?? "").trim();
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
    question = m.mentioned ? m.question : text;
  }

  // Nội dung nhạy cảm (TK/MK, dãy số dài): không gửi đi đâu, không trả lời.
  if (isSensitive(question)) return true;

  const now = opts.now ?? new Date();
  const rng = opts.rng ?? Math.random;
  const folded = foldVi(question);

  let intent: Intent | null = classifyByRules(folded);
  let canned: string | null = null;
  if (intent === null) {
    canned = cannedChat(folded, "{title}", rng); // điền danh xưng sau
    if (canned !== null) intent = "chat";
  }
  const needsAi = intent === null;

  // Trần lượt + cooldown. Admin không bị cooldown; câu rule của admin khỏi tốn DB.
  if (needsAi || !isAdmin) {
    const g = await gate(deps.supabase, from.id, needsAi, !isAdmin, ai.dailyCap, now);
    if (g === "cooldown") return true;
    const title0 = await resolveTitle(deps.supabase, from.username);
    if (g === "cap") {
      await sendHere(deps, message, isPrivate, FALLBACK_CAP.replace("{title}", title0));
      return true;
    }
    return await respond(deps, ai, message, isPrivate, isAdmin, question, intent, canned, title0, now, adminIds);
  }
  const title = await resolveTitle(deps.supabase, from.username);
  return await respond(deps, ai, message, isPrivate, isAdmin, question, intent, canned, title, now, adminIds);
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

  if (intent === null) {
    const context = await buildContext(deps, isAdmin, now);
    const r = await callGroq(ai, question, title, context);
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
