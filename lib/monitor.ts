// lib/monitor.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "./telegram.js";
import type { TelegramMessage } from "./types.js";

// --- CẤU HÌNH VÀ CA LÀM VIỆC ---
export interface ShiftCoordinatorConfig {
  sang: string;
  chieu: string;
  toi: string;
  defaultDp: string;
  ctvUsernames: string[]; 
  ctvSang?: string[];
  ctvChieu?: string[];
  ctvToi?: string[];
  userTitles?: Record<string, "anh" | "chị">;
}

const CONFIG_ROW_ID = -9001;
const WATCH_ROW_ID = -9002;
export const SLA_TIMEOUT_MS = 5 * 60 * 1000; // 5 phút theo dõi
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface WatchedGroupMessage {
  messageId: number;
  chatId: number;
  senderId: number;
  createdAtMs: number;
}

const DEFAULT_CONFIG: ShiftCoordinatorConfig = {
  sang: "HuyNQ5",
  chieu: "HuyNQ5",
  toi: "HuyNQ5",
  defaultDp: "HuyNQ5",
  ctvUsernames: ["op_huynq5", "huynq5"],
  ctvSang: [],
  ctvChieu: [],
  ctvToi: [],
  userTitles: {},
};

function stripDiacritics(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

const URGENT_PHRASES_NO_ACCENT = [
  "ho tro ngay",
  "gay gat",
  "buc xuc",
  "khan cap",
  "goi gap",
  "can gap",
  "ho tro gap",
  "xu ly gap",
  "check gap",
  "kiem tra gap",
  "khieu nai",
  "phan nan",
  "can ngay",
  "duyet",
];

export function isUrgentQllMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const lower = trimmed.toLowerCase();
  if (/(?:^|[\s,.!?:;("'])gấp(?:$|[\s,.!?:;)"'])/.test(lower)) {
    if (!lower.includes("gấp đôi") && !lower.includes("gấp sách")) {
      return true;
    }
  }
  const noAccent = stripDiacritics(trimmed);
  return URGENT_PHRASES_NO_ACCENT.some((phrase) => noAccent.includes(phrase));
}

// --- HÀM KIỂM TRA ĐIỀU KIỆN KEY NHẬN DIỆN CASE MỚI ---
export function isValidQllCaseMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;

  // 1. Kiểm tra từ khóa khẩn cấp
  if (isUrgentQllMessage(trimmed)) {
    return true;
  }

  // 2. Điều kiện HOẶC: Chứa từ 3 chữ số trở lên HOẶC chứa tiền tố mã lớp
  const hasMin3Digits = /\d{3,}/.test(trimmed);
  
  const classPrefixes = ["toan", "moet", "khtn", "tclc", "ta", "tvtth"];
  const lowerText = stripDiacritics(trimmed);
  const hasClassPrefix = classPrefixes.some((prefix) => lowerText.includes(prefix));

  return hasMin3Digits || hasClassPrefix;
}


// Quy định khung giờ ca làm việc chuẩn:
// Sáng: 8g - 12g (gánh đến trước 13h30)
// Chiều: 13h30 - 17g (gánh từ 13h30 đến trước 17h30)
// Tối: 17h30 - 21h30 (gánh từ 17h30 trở đi)
export function getCurrentShiftVn(now: Date = new Date()): {
  key: "sang" | "chieu" | "toi";
  label: string;
} {
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  const hour = vnTime.getUTCHours();
  const minute = vnTime.getUTCMinutes();
  const timeVal = hour + minute / 60;

  if (timeVal < 13.5) return { key: "sang", label: "Sáng" };
  if (timeVal >= 13.5 && timeVal < 17.5) return { key: "chieu", label: "Chiều" };
  return { key: "toi", label: "Tối" };
}

export function getActiveCoordinator(
  config: ShiftCoordinatorConfig,
  now: Date = new Date()
): { username: string; shiftLabel: string } {
  const shift = getCurrentShiftVn(now);
  const raw = config[shift.key] || config.defaultDp || "HuyNQ5";
  return {
    username: raw.replace(/^@/, "").trim(),
    shiftLabel: shift.label,
  };
}

export async function loadMonitorConfig(
  client: SupabaseClient
): Promise<ShiftCoordinatorConfig> {
  if (!client || typeof client.from !== "function") return DEFAULT_CONFIG;
  try {
    const { data, error } = await client
      .from("pending_batches")
      .select("items")
      .eq("admin_id", CONFIG_ROW_ID)
      .maybeSingle();
    if (error || !data?.items) return DEFAULT_CONFIG;
    const raw = data.items as Partial<ShiftCoordinatorConfig>;
    return {
      sang: raw.sang || DEFAULT_CONFIG.sang,
      chieu: raw.chieu || DEFAULT_CONFIG.chieu,
      toi: raw.toi || DEFAULT_CONFIG.toi,
      defaultDp: raw.defaultDp || DEFAULT_CONFIG.defaultDp,
      ctvUsernames: Array.isArray(raw.ctvUsernames)
        ? raw.ctvUsernames
        : DEFAULT_CONFIG.ctvUsernames,
      ctvSang: Array.isArray(raw.ctvSang) ? raw.ctvSang : [],
      ctvChieu: Array.isArray(raw.ctvChieu) ? raw.ctvChieu : [],
      ctvToi: Array.isArray(raw.ctvToi) ? raw.ctvToi : [],
      userTitles: raw.userTitles && typeof raw.userTitles === "object" ? raw.userTitles : {},
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveMonitorConfig(
  client: SupabaseClient,
  config: ShiftCoordinatorConfig
): Promise<boolean> {
  if (!client || typeof client.from !== "function") return false;
  try {
    const { error } = await client
      .from("pending_batches")
      .upsert(
        { admin_id: CONFIG_ROW_ID, items: config as unknown },
        { onConflict: "admin_id" }
      );
    return !error;
  } catch {
    return false;
  }
}

export async function loadWatchedMessages(
  client: SupabaseClient
): Promise<WatchedGroupMessage[]> {
  if (!client || typeof client.from !== "function") return [];
  try {
    const { data, error } = await client
      .from("pending_batches")
      .select("items")
      .eq("admin_id", WATCH_ROW_ID)
      .maybeSingle();
    if (error || !Array.isArray(data?.items)) return [];
    return data.items as WatchedGroupMessage[];
  } catch {
    return [];
  }
}

export async function saveWatchedMessages(
  client: SupabaseClient,
  list: WatchedGroupMessage[]
): Promise<void> {
  if (!client || typeof client.from !== "function") return;
  try {
    await client
      .from("pending_batches")
      .upsert(
        { admin_id: WATCH_ROW_ID, items: list as unknown },
        { onConflict: "admin_id" }
      );
  } catch {
    // ignore
  }
}

// Xử lý các lệnh quản lý /dp, /đp, /addctv, /addctvca, /settitle, /delctv
export async function maybeHandleCoordinatorCommands(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower === "/dp" ||
    lower === "/đp" ||
    lower.startsWith("/dp ") ||
    lower.startsWith("/đp ")
  ) {
    const config = await loadMonitorConfig(supabase);
    const argStr = trimmed.replace(/^\/(dp|đp)\b/i, "").trim();

    if (argStr === "") {
      const active = getActiveCoordinator(config);
      const ctvList =
        config.ctvUsernames.length > 0
          ? config.ctvUsernames.map((u) => `@${u}`).join(", ")
          : "(chưa có)";
      const ctvSangList =
        config.ctvSang && config.ctvSang.length > 0
          ? config.ctvSang.map((u) => `${config.userTitles?.[u] || ""} @${u}`.trim()).join(", ")
          : "(chưa có)";
      const ctvChieuList =
        config.ctvChieu && config.ctvChieu.length > 0
          ? config.ctvChieu.map((u) => `${config.userTitles?.[u] || ""} @${u}`.trim()).join(", ")
          : "(chưa có)";
      const ctvToiList =
        config.ctvToi && config.ctvToi.length > 0
          ? config.ctvToi.map((u) => `${config.userTitles?.[u] || ""} @${u}`.trim()).join(", ")
          : "(chưa có)";

      await telegram.sendMessage(
        message.chat.id,
        [
          "📋 Cấu hình Điều phối viên theo ca:",
          `• Ca Sáng (08h-12h): @${config.sang}`,
          `• Ca Chiều (13h30-17h): @${config.chieu}`,
          `• Ca Tối (17h30-21h30): @${config.toi}`,
          `👉 Hiện tại đang là ca ${active.shiftLabel} -> Tag: @${active.username}`,
          "",
          `👥 Danh sách CTV Vận hành (${config.ctvUsernames.length}): ${ctvList}`,
          "",
          "🧑‍💻 Danh sách CTV trực theo ca (Tag sau 5p):",
          `• Ca Sáng: ${ctvSangList}`,
          `• Ca Chiều: ${ctvChieuList}`,
          `• Ca Tối: ${ctvToiList}`,
          "",
          "💡 Cú pháp đổi điều phối:",
          "/đp sáng HuyNQ5 | /đp chiều HuyNQ5 | /đp tối HuyNQ5",
          "💡 Cú pháp thêm CTV trực theo ca:",
          "/addctvca <sang|chieu|toi> @user1 @user2",
          "💡 Cú pháp cài đặt danh xưng (anh/chị):",
          "/settitle @username anh (hoặc chị)",
        ].join("\n")
      );
      return true;
    }

    const parts = argStr.split(/\s+/);
    if (parts.length === 1) {
      const uname = parts[0].replace(/^@/, "").trim();
      config.sang = uname;
      config.chieu = uname;
      config.toi = uname;
      config.defaultDp = uname;
      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã gán điều phối viên cho tất cả các ca: @${uname}`
      );
      return true;
    }

    const shiftRaw = stripDiacritics(parts[0]);
    const uname = parts[1].replace(/^@/, "").trim();
    if (!uname) {
      await telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /đp <sáng|chiều|tối> <username> (VD: /đp tối HuyNQ5)"
      );
      return true;
    }

    if (shiftRaw === "sang") {
      config.sang = uname;
      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã gán điều phối Ca Sáng: @${uname}`
      );
      return true;
    }
    if (shiftRaw === "chieu") {
      config.chieu = uname;
      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã gán điều phối Ca Chiều: @${uname}`
      );
      return true;
    }
    if (shiftRaw === "toi") {
      config.toi = uname;
      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã gán điều phối Ca Tối: @${uname}`
      );
      return true;
    }

    await telegram.sendMessage(
      message.chat.id,
      "Ca không hợp lệ. Dùng: /đp sáng <user>, /đp chiều <user>, hoặc /đp tối <user>"
    );
    return true;
  }

  // --- LỆNH /settitle (Cài đặt danh xưng anh/chị) ---
  if (lower.startsWith("/settitle")) {
    const rest = trimmed.slice("/settitle".length).trim();
    const parts = rest.split(/\s+/);
    const uname = parts[0]?.replace(/^@/, "").trim().toLowerCase();
    const titleArg = stripDiacritics(parts[1] || "").toLowerCase();

    if (uname && (titleArg === "anh" || titleArg === "chi" || titleArg === "chị")) {
      const config = await loadMonitorConfig(supabase);
      if (!config.userTitles) config.userTitles = {};
      const resolvedTitle = titleArg.startsWith("chi") ? "chị" : "anh";
      config.userTitles[uname] = resolvedTitle;
      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã lưu danh xưng cho @${uname}: **${resolvedTitle}**`
      );
    } else {
      await telegram.sendMessage(
        message.chat.id,
        "⚠️ Sai cú pháp! Dùng: /settitle @username <anh|chị>"
      );
    }
    return true;
  }

  // --- LỆNH /addctvca ---
  if (lower.startsWith("/addctvca")) {
    const rest = trimmed.slice("/addctvca".length).trim();
    if (!rest) {
      await telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /addctvca <sang|chieu|toi> @username1 @username2"
      );
      return true;
    }

    const parts = rest.split(/\s+/);
    const shiftType = stripDiacritics(parts[0] || "");
    const usernames = parts
      .slice(1)
      .map((u) => u.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);

    if (["sang", "chieu", "toi"].includes(shiftType) && usernames.length > 0) {
      const config = await loadMonitorConfig(supabase);

      if (shiftType === "sang") config.ctvSang = usernames;
      if (shiftType === "chieu") config.ctvChieu = usernames;
      if (shiftType === "toi") config.ctvToi = usernames;

      await saveMonitorConfig(supabase, config);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Đã lưu thành công ${usernames.length} CTV cho ca ${shiftType.toUpperCase()}: ${usernames
          .map((u) => `@${u}`)
          .join(", ")}`
      );
    } else {
      await telegram.sendMessage(
        message.chat.id,
        "⚠️ Sai cú pháp! Dùng: /addctvca <sang|chieu|toi> @user1 @user2"
      );
    }
    return true;
  }

  // --- LỆNH ADDCTV CŨ ---
  if (lower.startsWith("/addctv")) {
    const rest = trimmed.slice("/addctv".length).trim();
    if (!rest) {
      await telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /addctv @username1 @username2"
      );
      return true;
    }
    const config = await loadMonitorConfig(supabase);
    const tokens = rest
      .split(/[\s,]+/)
      .map((t) => t.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);
    const set = new Set(config.ctvUsernames.map((u) => u.toLowerCase()));
    for (const t of tokens) set.add(t);
    config.ctvUsernames = Array.from(set);
    await saveMonitorConfig(supabase, config);
    await telegram.sendMessage(
      message.chat.id,
      `✅ Đã cập nhật danh sách CTV Vận hành (${config.ctvUsernames.length}): ${config.ctvUsernames
        .map((u) => `@${u}`)
        .join(", ")}`
    );
    return true;
  }

  // --- LỆNH DELCTV CŨ ---
  if (lower.startsWith("/delctv")) {
    const rest = trimmed.slice("/delctv".length).trim();
    if (!rest) {
      await telegram.sendMessage(message.chat.id, "Cú pháp: /delctv @username");
      return true;
    }
    const config = await loadMonitorConfig(supabase);
    const toRemove = new Set(
      rest
        .split(/[\s,]+/)
        .map((t) => t.replace(/^@/, "").trim().toLowerCase())
        .filter(Boolean)
    );
    config.ctvUsernames = config.ctvUsernames.filter(
      (u) => !toRemove.has(u.toLowerCase())
    );
    await saveMonitorConfig(supabase, config);
    await telegram.sendMessage(
      message.chat.id,
      `♻️ Đã xóa khỏi danh sách CTV. Còn lại (${config.ctvUsernames.length}): ${config.ctvUsernames
        .map((u) => `@${u}`)
        .join(", ")}`
    );
    return true;
  }

  return false;
}

// Bắt sự kiện thả Icon (Reaction) trong nhóm để giải phóng SLA
export async function handleGroupReaction(
  reaction: any, // Đổi sang any để xử lý JSON payload từ Telegram
  supabase: SupabaseClient,
  targetChatId: number
): Promise<void> {
  if (reaction.chat.id !== targetChatId) return;
  // Chỉ gỡ SLA khi có thao tác THÊM icon mới
  if (!Array.isArray(reaction.new_reaction) || reaction.new_reaction.length === 0) {
    return;
  }
  const watched = await loadWatchedMessages(supabase);
  const filtered = watched.filter((w) => w.messageId !== reaction.message_id);
  if (filtered.length !== watched.length) {
    await saveWatchedMessages(supabase, filtered);
  }
}

// --- CÁC HÀM PHỤ TRỢ XỬ LÝ DATABASE & REACTION ---

export async function insertQllCase(
  client: SupabaseClient,
  record: { message_id: number; chat_id: number; sender_id: number; sender_name: string; content: string }
) {
  if (!client || typeof client.from !== "function") return;
  try {
    await client.from("qll_tracking").upsert(
      { ...record, handled: false, reported: false },
      { onConflict: "message_id" }
    );
  } catch (e) {
    console.error("Lỗi insertQllCase:", e);
  }
}

export async function markCaseHandled(client: SupabaseClient, messageId: number) {
  if (!client || typeof client.from !== "function") return;
  try {
    await client.from("qll_tracking").update({ handled: true }).eq("message_id", messageId);
  } catch (e) {
    console.error("Lỗi markCaseHandled:", e);
  }
}

export async function handleGroupQllMessage(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  targetChatId: number,
  adminIds: number[]
): Promise<void> {
  if (message.chat.id !== targetChatId) return;
  if (!message.from || message.from.is_bot) return;
  if (message.new_chat_members && message.new_chat_members.length > 0) return;

  const watched = await loadWatchedMessages(supabase);
  let watchedChanged = false;

  const replyToId = message.reply_to_message?.message_id;
  if (replyToId !== undefined) {
    const afterReply = watched.filter((w) => w.messageId !== replyToId);
    if (afterReply.length !== watched.length) {
      watched.length = 0;
      watched.push(...afterReply);
      watchedChanged = true;
    }
  }

  // --- TẢI CONFIG TRƯỚC KHI SỬ DỤNG ---
  const config = await loadMonitorConfig(supabase);

  const senderUname = (message.from.username ?? "").trim().toLowerCase();
  const text = (message.text ?? message.caption ?? "").trim();
  const lowerText = text.toLowerCase();

  const isCredentialReply = 
    lowerText.includes("acc:") || 
    lowerText.includes("pass:") || 
    lowerText.includes("mk:") || 
    lowerText.includes("tk:") || 
    lowerText.includes("tk gia sư") ||
    lowerText.includes("e gửi") || 
    lowerText.includes("gửi lại tk");

  // CHỐT CHẶN 1: Chặn tuyệt đối tin nhắn Tài khoản / Mật khẩu
  if (isCredentialReply) {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return; 
  }
  
  const isAllCtvShift =
    (config?.ctvSang && config.ctvSang.includes(senderUname)) ||
    (config?.ctvChieu && config.ctvChieu.includes(senderUname)) ||
    (config?.ctvToi && config.ctvToi.includes(senderUname));

  const isCtvOrAdmin =
    adminIds.includes(message.from.id) ||
    (senderUname !== "" && (config.ctvUsernames.includes(senderUname) || isAllCtvShift));

  // CHỐT CHẶN 2: Tin nhắn của Admin/CTV ca trực cũng bỏ qua
  if (isCtvOrAdmin) {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return; 
  }

  if (text === "") {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return;
  }

  // --- LỚP 2: LỌC RULE QLL (Yêu cầu chứa >=3 số hoặc mã lớp) ---
  if (!isValidQllCaseMessage(text)) {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return; // Sai format QLL -> Thoát ngay lập tức
  }

  // --- LỚP 3: CHỈ CÒN LẠI TIN NHẮN CHUẨN CỦA QLL -> LƯU DATABASE ---
  const senderName = message.from.first_name 
    ? `${message.from.first_name} ${message.from.last_name || ""}`.trim() 
    : senderUname || "QLL";
    
  await insertQllCase(supabase, {
    message_id: message.message_id,
    chat_id: message.chat.id,
    sender_id: message.from.id,
    sender_name: senderName,
    content: text,
  });


  // 2. PUSH VÀO MẢNG ĐỂ TÍNH SLA 5 PHÚT
  watched.push({
    messageId: message.message_id,
    chatId: message.chat.id,
    senderId: message.from.id,
    createdAtMs: Date.now(),
  });
  watchedChanged = true;

  if (isUrgentQllMessage(text)) {
    const { username } = getActiveCoordinator(config);
    const titles = config.userTitles || {};
    const dpTitle = titles[username.toLowerCase()] || "anh/chị";
    await telegram.sendMessage(
      message.chat.id,
      `Dạ ${dpTitle} @${username} ơi case này cần hỗ trợ ạ !`,
      message.message_id
    );
  }

  if (watchedChanged) {
    await saveWatchedMessages(supabase, watched);
  }
}

// Hàm kiểm tra SLA 5 phút (Chạy trong Cron) - Quá 5 phút không ai thả tim/reply sẽ tag random CTV trong ca
export async function checkUnansweredMessages(
  telegram: TelegramClient,
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;

  const watched = await loadWatchedMessages(supabase);
  if (watched.length === 0) return;

  const config = await loadMonitorConfig(supabase);
  const { username } = getActiveCoordinator(config, new Date(nowMs));
  const currentShift = getCurrentShiftVn(new Date(nowMs));
  const titles = config.userTitles || {};

  let currentShiftCtv: string[] = [];
  if (currentShift.key === "sang") currentShiftCtv = config.ctvSang || [];
  else if (currentShift.key === "chieu") currentShiftCtv = config.ctvChieu || [];
  else currentShiftCtv = config.ctvToi || [];

  const remaining: WatchedGroupMessage[] = [];
  let changed = false;

  for (const item of watched) {
    const ageMs = nowMs - item.createdAtMs;
    if (ageMs > 12 * 60 * 60 * 1000) {
      changed = true;
      continue;
    }

    if (ageMs >= SLA_TIMEOUT_MS) {
      // Quá 5 phút không ai thả tim/nhận -> Tag đúng anh/chị CTV ca đó hoặc điều phối
      if (currentShiftCtv.length > 0) {
        const randomCtv = currentShiftCtv[Math.floor(Math.random() * currentShiftCtv.length)];
        const title = titles[randomCtv.toLowerCase()] || "anh/chị";
        await telegram.sendMessage(
          item.chatId,
          `Dạ ${title} @${randomCtv} ơi case này cần hỗ trợ ạ !`,
          item.messageId
        );
      } else {
        const dpTitle = titles[username.toLowerCase()] || "anh/chị";
        await telegram.sendMessage(
          item.chatId,
          `Dạ ${dpTitle} @${username} ơi case này cần hỗ trợ ạ !`,
          item.messageId
        );
      }
      changed = true;
    } else {
      remaining.push(item);
    }
  }

  if (changed) {
    await saveWatchedMessages(supabase, remaining);
  }
}

export async function updateConfig(
  supabase: SupabaseClient,
  newConfig: Record<string, any>
): Promise<void> {
  const CONFIG_ROW_ID = -9001;

  const { data } = await supabase
    .from("pending_batches")
    .select("items")
    .eq("admin_id", CONFIG_ROW_ID)
    .single();

  let existingItems = data?.items || {};
  if (typeof existingItems !== "object") {
    existingItems = {};
  }

  const updatedItems = { ...existingItems, ...newConfig };

  await supabase
    .from("pending_batches")
    .upsert(
      {
        admin_id: CONFIG_ROW_ID,
        items: updatedItems,
        created_at: new Date().toISOString(),
      },
      { onConflict: "admin_id" }
    );
}
 
export async function sendReaction(
  chatId: number,
  messageId: number,
  emoji: string = "👍"
): Promise<boolean> {
  try {
    const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.log("❌ Thiếu BOT_TOKEN");
      return false;
    }

    const url = `https://api.telegram.org/bot${token}/setMessageReaction`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: emoji }],
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      description?: string;
    };

    if (!data.ok) {
      console.error("❌ Telegram từ chối thả icon:", data.description);
    }

    return data.ok;
  } catch (error) {
    console.error("❌ Lỗi mạng khi gọi sendReaction:", error);
    return false;
  }
}