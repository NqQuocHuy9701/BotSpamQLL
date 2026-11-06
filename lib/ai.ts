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
  getCurrentShiftVn,
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

export type Intent = "checkin" | "baocao" | "casetreo" | "help" | "chat" | "checkout";
const INTENTS: readonly Intent[] = ["checkin", "baocao", "casetreo", "help", "chat", "checkout"];

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
export function classifyByRules(folded: string): Intent | null {
  // Bee chưa có dữ liệu check-out: trả lời thẳng thay vì nhả danh sách check-in.
  if (/\b(check ?out|checkout|tan ca|het ca|ve ca)\b/.test(folded)) return "checkout";
  if (/\b(bao cao|thong ke|hieu suat|kpi|xep hang)\b/.test(folded)) return "baocao";
  if (
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
    .slice(0, 280);
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
    const intent = String(obj.intent ?? "").toLowerCase().trim() as Intent;
    if (!INTENTS.includes(intent)) return null;
    return { intent, reply: sanitizeReply(typeof obj.reply === "string" ? obj.reply : "") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gọi Groq
// ---------------------------------------------------------------------------

function buildSystemPrompt(title: string): string {
  return [
    'Bạn là Bee, trợ lý ong thân thiện của team CTV VHHS. Chỉ trả về MỘT đối tượng JSON: {"intent":"...","reply":"..."}.',
    "intent là một trong:",
    "- checkin: hỏi ai đang trực / đã check-in ca này",
    "- baocao: hỏi báo cáo, hiệu suất, số liệu của ca",
    "- casetreo: hỏi case chưa xử lý / đang treo / bị miss",
    "- help: hỏi Bee làm được gì, cách dùng",
    "- checkout: hỏi ai đã check-out / tan ca / về ca",
    "- chat: chào hỏi, trò chuyện, hoặc câu không thuộc các loại trên",
    `reply: CHỈ điền khi intent=chat, 1 câu ngắn tiếng Việt, xưng "em", gọi người hỏi là "${title}", mở đầu bằng "Dạ", đúng 1 emoji mặt cười. Không bịa số liệu, không nhắc tới @ai. Nếu được nhờ việc ngoài khả năng thì từ chối lịch sự và gợi ý gõ /help. Intent khác thì reply là "".`,
  ].join("\n");
}

async function callGroq(
  ai: AiConfig,
  question: string,
  title: string
): Promise<{ intent: Intent; reply: string } | null> {
  const doFetch = ai.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: ai.model,
      messages: [
        { role: "system", content: buildSystemPrompt(title) },
        { role: "user", content: question.slice(0, MAX_QUESTION_CHARS) },
      ],
      temperature: 0.3,
      max_completion_tokens: 300,
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
      console.error(`Groq HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return parseGroqJson(data.choices?.[0]?.message?.content);
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

export async function buildPendingCases(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<string> {
  const { key, label } = getCurrentShiftVn(now);
  try {
    const { data, count, error } = await supabase
      .from("qll_tracking")
      .select("message_id, sender_name, content", { count: "exact" })
      .eq("handled", false)
      .gt("message_id", 0) // chỉ nhóm QLL (id dương)
      .gte("created_at", shiftStartUtcIso(now, key))
      .order("created_at", { ascending: true })
      .limit(15);
    if (error) throw new Error(error.message);
    const rows =
      (data as { message_id: number; sender_name: string | null; content: string | null }[] | null) ??
      [];
    if (rows.length === 0) {
      return `✅ Ca ${label.toUpperCase()}: không còn case nào chưa xử lý.`;
    }
    const total = count ?? rows.length;
    const lines = [`📋 Case chưa xử lý — ca ${label.toUpperCase()}: ${total}`];
    rows.forEach((r, i) => {
      const snippet = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 45);
      lines.push(`${i + 1}. ${r.sender_name ?? "QLL"} — ${snippet}`);
      lines.push(`   https://t.me/c/${QLL_LINK_ID}/${r.message_id}`);
    });
    if (total > rows.length) lines.push(`... và ${total - rows.length} case nữa.`);
    return lines.join("\n");
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
  '• "Case nào đang treo?" — case chưa xử lý (admin)',
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
    if (!m.mentioned) return false; // chỉ phản hồi khi được tag
    question = m.question;
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
    const r = await callGroq(ai, question, title);
    if (!r) {
      await sendHere(deps, message, isPrivate, FALLBACK_BUSY.replace("{title}", title));
      return true;
    }
    intent = r.intent;
    chatReply = r.reply;
  }

  const from = message.from!;

  switch (intent) {
    case "checkin": {
      const body = deps.checkinSupabase
        ? await buildCheckinList(deps.checkinSupabase, now)
        : "Dạ chức năng check-in chưa được cấu hình ạ 🥺";
      await sendHere(deps, message, isPrivate, deps.checkinSupabase ? `${lead(title)}\n\n${body}` : body);
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
      const body = html
        ? await buildShiftReport(deps.supabase, deps.checkinSupabase, now)
        : await buildPendingCases(deps.supabase, now);
      if (isPrivate) {
        await sendHere(deps, message, true, `${lead(title)}\n\n${body}`, html);
        return true;
      }
      // Trong nhóm: gửi riêng cho admin, nhóm chỉ nhận 1 câu xác nhận.
      const dm = await deps.telegram.sendMessage(
        from.id,
        `${lead(title)}\n\n${body}`,
        undefined,
        html ? "HTML" : undefined
      );
      await sendHere(
        deps,
        message,
        false,
        dm.ok
          ? `Dạ em gửi riêng cho ${title} rồi ạ 😊`
          : `Dạ em chưa nhắn riêng được, ${title} nhắn em ở chat riêng nhé 🥺`
      );
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
