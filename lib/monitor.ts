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
  // Ngày (giờ VN, YYYY-MM-DD) ứng với các list ctvSang/chieu/toi hiện tại.
  // Dùng để tự reset list CTV theo ca mỗi khi sang ngày mới (từ form check-in).
  ctvShiftDate?: string;
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
      ctvShiftDate: typeof raw.ctvShiftDate === "string" ? raw.ctvShiftDate : undefined,
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
          "💡 Cú pháp xóa CTV trực theo ca:",
          "/delctvca <sang|chieu|toi> @username",
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

  // --- [THÊM MỚI] LỆNH /delctvca (Xóa CTV theo ca) ---
  if (lower.startsWith("/delctvca")) {
    const rest = trimmed.slice("/delctvca".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      await telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /delctvca <sang|chieu|toi> @username"
      );
      return true;
    }

    const shiftType = stripDiacritics(parts[0] || "");
    const targetUname = parts[1].replace(/^@/, "").trim().toLowerCase();

    if (!["sang", "chieu", "toi"].includes(shiftType) || !targetUname) {
      await telegram.sendMessage(
        message.chat.id,
        "⚠️ Sai cú pháp! Dùng: /delctvca <sang|chieu|toi> @username"
      );
      return true;
    }

    const config = await loadMonitorConfig(supabase);
    let targetKey: "ctvSang" | "ctvChieu" | "ctvToi" = "ctvSang";
    if (shiftType === "chieu") targetKey = "ctvChieu";
    if (shiftType === "toi") targetKey = "ctvToi";

    const currentList = config[targetKey] || [];
    const updatedList = currentList.filter((u) => u.toLowerCase() !== targetUname);
    config[targetKey] = updatedList;

    await saveMonitorConfig(supabase, config);
    await telegram.sendMessage(
      message.chat.id,
      `♻️ Đã xóa @${targetUname} khỏi ca **${shiftType.toUpperCase()}**. Còn lại (${updatedList.length}): ${
        updatedList.length > 0 ? updatedList.map((u) => `@${u}`).join(", ") : "(trống)"
      }`
    );
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
  reaction: any, 
  supabase: SupabaseClient,
  targetChatId: number
): Promise<void> {
  // Lấy chat_id linh hoạt từ payload reaction để tránh trường hợp Telegram trả về thiếu cấu trúc chat
  const chatId = reaction.chat?.id || reaction.message_chat_id || targetChatId;
  if (targetChatId && chatId !== targetChatId) return;

  // Chỉ gỡ SLA khi có thao tác THÊM icon mới
  if (!Array.isArray(reaction.new_reaction) || reaction.new_reaction.length === 0) {
    return;
  }
  
  const watched = await loadWatchedMessages(supabase);
  
  // So khớp chính xác message_id để xóa khỏi hàng đợi SLA
  const filtered = watched.filter((w) => w.messageId !== reaction.message_id);
  
  if (filtered.length !== watched.length) {
    await saveWatchedMessages(supabase, filtered);
  }
}

// --- CÁC HÀM PHỤ TRỢ XỬ LÝ DATABASE & REACTION ---

export async function insertQllCase(
  client: SupabaseClient,
  record: { message_id: number; sender_name: string; content: string; shift_name: string }
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

  // Chuẩn hóa: Gọt sạch dấu "@", khoảng trắng và đưa về chữ thường cho toàn bộ danh sách CTV lấy từ DB
  const listCtv = (config.ctvUsernames || []).map((u: string) => u.replace(/^@/, "").trim().toLowerCase());
  const listSang = (config?.ctvSang || []).map((u: string) => u.replace(/^@/, "").trim().toLowerCase());
  const listChieu = (config?.ctvChieu || []).map((u: string) => u.replace(/^@/, "").trim().toLowerCase());
  const listToi = (config?.ctvToi || []).map((u: string) => u.replace(/^@/, "").trim().toLowerCase());

  const isAllCtvShift =
    listSang.includes(senderUname) ||
    listChieu.includes(senderUname) ||
    listToi.includes(senderUname);

  const isCtvOrAdmin =
    adminIds.includes(message.from.id) ||
    (senderUname !== "" && (listCtv.includes(senderUname) || isAllCtvShift));

  // 🛑 CHỐT CHẶN 1 (ƯU TIÊN CAO NHẤT): Nếu là Admin hoặc CTV nội bộ -> Bỏ qua hoàn toàn ngay từ cửa ngõ
  if (isCtvOrAdmin) {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return; 
  }

  const isCredentialReply = 
    lowerText.includes("acc:") || 
    lowerText.includes("pass:") || 
    lowerText.includes("mk:") || 
    lowerText.includes("tk:") || 
    lowerText.includes("tk gia sư") ||
    lowerText.includes("e gửi") || 
    lowerText.includes("gửi lại tk");

  // CHỐT CHẶN 2: Chặn tuyệt đối tin nhắn Tài khoản / Mật khẩu của người ngoài
  if (isCredentialReply) {
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
    content: text,
    sender_name: senderName,
    shift_name: getCurrentShiftVn().label
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
export async function checkUnansweredMessages(
  telegram: TelegramClient,
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;

  // Lấy mốc 5 phút trước
  const fiveMinsAgo = new Date(nowMs - SLA_TIMEOUT_MS).toISOString();

  // Truy vấn trực tiếp db: Chưa handled, chưa reported, quá 5 phút
  const { data: expiredCases, error } = await supabase
    .from("qll_tracking")
    .select("message_id, created_at")
    .eq("handled", false)
    .eq("reported", false)
    .lte("created_at", fiveMinsAgo);

  if (error || !expiredCases || expiredCases.length === 0) return;

  const config = await loadMonitorConfig(supabase);
  const { username } = getActiveCoordinator(config, new Date(nowMs));
  const currentShift = getCurrentShiftVn(new Date(nowMs));
  const titles = config.userTitles || {};

  let currentShiftCtv: string[] = [];
  if (currentShift.key === "sang") currentShiftCtv = config.ctvSang || [];
  else if (currentShift.key === "chieu") currentShiftCtv = config.ctvChieu || [];
  else currentShiftCtv = config.ctvToi || [];

  const processedIds: number[] = [];
  const TARGET_GROUP_ID = -1002273179613; 

  for (const item of expiredCases) {
    if (currentShiftCtv.length > 0) {
      const randomCtv = currentShiftCtv[Math.floor(Math.random() * currentShiftCtv.length)];
      const title = titles[randomCtv.toLowerCase()] || "anh/chị";
      await telegram.sendMessage(TARGET_GROUP_ID, `Dạ ${title} @${randomCtv} ơi case này cần hỗ trợ ạ !`, item.message_id);
    } else {
      const dpTitle = titles[username.toLowerCase()] || "anh/chị";
      await telegram.sendMessage(TARGET_GROUP_ID, `Dạ ${dpTitle} @${username} ơi case này cần hỗ trợ ạ !`, item.message_id);
    }
    processedIds.push(item.message_id);
  }

  // Khóa case lại, không tag lần 2
  if (processedIds.length > 0) {
    await supabase.from("qll_tracking").update({ reported: true }).in("message_id", processedIds);
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
export async function handleMessageReaction(
  update: any,
  supabase: SupabaseClient
): Promise<void> {
  const reaction = update.message_reaction;
  if (!reaction || !reaction.message_id) return;

  const messageId = reaction.message_id;
  const newReaction = reaction.new_reaction || [];

  // Nếu có thả icon (new_reaction không rỗng) -> Cập nhật handled = true
  if (newReaction.length > 0) {
    try {
      await supabase
        .from("qll_tracking")
        .update({ handled: true })
        .eq("message_id", messageId);
    } catch (e) {
      console.error("Lỗi cập nhật handled qua reaction:", e);
    }
  }
}


// =====================================================================
// BÁO CÁO HIỆU SUẤT CTV TRONG CA (Reply-only)
// Đếm số case hợp lệ (đã nằm trong qll_tracking) mà CTV của ca hiện tại
// reply. Mỗi case chỉ tính cho ĐÚNG MỘT CTV = người reply cuối cùng
// (upsert ghi đè theo case trong bảng shift_interactions, PK đã đổi thành
// (chat_id, message_id, kind)). Báo cáo gửi riêng cho admin qua /baocao.
// =====================================================================

// Ngày hiện tại theo giờ VN dạng YYYY-MM-DD (dùng làm shift_date).
function getVnDateString(now: Date = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const y = vn.getUTCFullYear();
  const m = String(vn.getUTCMonth() + 1).padStart(2, "0");
  const d = String(vn.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Trả về danh sách CTV (đã gọt @, lowercase) của ca ứng với thời điểm `now`.
function ctvListOfCurrentShift(
  config: ShiftCoordinatorConfig,
  now: Date = new Date()
): string[] {
  const { key } = getCurrentShiftVn(now);
  const raw =
    key === "sang"
      ? config.ctvSang
      : key === "chieu"
      ? config.ctvChieu
      : config.ctvToi;
  return (raw || []).map((u) => u.replace(/^@/, "").trim().toLowerCase());
}

// Ghi nhận 1 reply của CTV lên 1 case hợp lệ. Chỉ ghi khi:
//  - Người reply có username VÀ thuộc danh sách CTV của ca hiện tại.
//  - Tin gốc được reply là case hợp lệ (có trong qll_tracking).
// Upsert theo (chat_id, message_id, kind='reply') => mỗi case chỉ 1 dòng,
// luôn là CTV reply cuối cùng. Không throw (nuốt lỗi như các helper khác).
export async function recordCtvReply(
  supabase: SupabaseClient,
  opts: {
    chatId: number;
    caseMessageId: number; // message_id của tin gốc được reply
    replierUsername: string | undefined;
    now?: Date;
  }
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;
  const uname = (opts.replierUsername ?? "").replace(/^@/, "").trim().toLowerCase();
  if (uname === "") return;

  try {
    const now = opts.now ?? new Date();
    const config = await loadMonitorConfig(supabase);
    const ctvsOfShift = ctvListOfCurrentShift(config, now);
    // Chỉ đếm nếu người reply là CTV của ca hiện tại.
    if (!ctvsOfShift.includes(uname)) return;

    // Tin gốc phải là case hợp lệ đang theo dõi (đã lọc rule khi insert).
    const { data: caseRow } = await supabase
      .from("qll_tracking")
      .select("message_id")
      .eq("message_id", opts.caseMessageId)
      .maybeSingle();
    if (!caseRow) return;

    const { key, label } = getCurrentShiftVn(now);
    // Ghi đè theo case: 2 CTV reply cùng case -> giữ người reply cuối.
    await supabase.from("shift_interactions").upsert(
      {
        chat_id: opts.chatId,
        message_id: opts.caseMessageId,
        ctv_username: uname,
        kind: "reply",
        shift: key,
        shift_date: getVnDateString(now),
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id,message_id,kind" }
    );
    void label; // label chỉ dùng cho báo cáo, không lưu
  } catch (e) {
    console.error("Lỗi recordCtvReply:", e);
  }
}

// Dựng text báo cáo hiệu suất ca hiện tại.
// total_valid_cases: tổng case hợp lệ của ca+ngày (từ qll_tracking theo shift_name).
// Mỗi CTV: số case đã reply (đếm distinct case trong shift_interactions).
// coverage = (số case được 1 CTV reply) / (tổng case) * 100.
export async function buildShiftReport(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<string> {
  const { key, label } = getCurrentShiftVn(now);
  const shiftDate = getVnDateString(now);
  const shiftWindow =
    key === "sang"
      ? "08:00 - 12:00"
      : key === "chieu"
      ? "13:30 - 17:00"
      : "17:30 - 21:30";

  // Mốc BẮT ĐẦU ca HÔM NAY (giờ VN) quy ra UTC ISO. qll_tracking.shift_name chỉ
  // lưu nhãn ca (gộp nhiều ngày), nên để đếm ĐÚNG case của ca hôm nay ta lọc
  // theo created_at >= mốc đầu ca. Giờ đầu ca VN: sáng 08:00, chiều 13:30,
  // tối 17:30. UTC = giờ VN - 7h.
  const vnNow = new Date(now.getTime() + VN_OFFSET_MS);
  const startHourVn = key === "sang" ? 8 : key === "chieu" ? 13 : 17;
  const startMinVn = key === "chieu" || key === "toi" ? 30 : 0;
  const shiftStartUtcIso = new Date(
    Date.UTC(
      vnNow.getUTCFullYear(),
      vnNow.getUTCMonth(),
      vnNow.getUTCDate(),
      startHourVn - 7,
      startMinVn,
      0
    )
  ).toISOString();

  // Tổng case hợp lệ phát sinh trong ca hôm nay (từ mốc đầu ca tới hiện tại).
  let totalCases = 0;
  try {
    const { count } = await supabase
      .from("qll_tracking")
      .select("message_id", { count: "exact", head: true })
      .eq("shift_name", label)
      .gte("created_at", shiftStartUtcIso);
    totalCases = count ?? 0;
  } catch {
    totalCases = 0;
  }

  // Các reply của CTV trong ca+ngày.
  let rows: { ctv_username: string | null }[] = [];
  try {
    const { data } = await supabase
      .from("shift_interactions")
      .select("ctv_username")
      .eq("kind", "reply")
      .eq("shift", key)
      .eq("shift_date", shiftDate);
    rows = (data as { ctv_username: string | null }[] | null) ?? [];
  } catch {
    rows = [];
  }

  // Đếm số case mỗi CTV đã reply (mỗi dòng = 1 case vì PK theo case).
  const perCtv = new Map<string, number>();
  for (const r of rows) {
    const u = (r.ctv_username ?? "").trim().toLowerCase();
    if (u === "") continue;
    perCtv.set(u, (perCtv.get(u) ?? 0) + 1);
  }
  const coveredCases = rows.length; // mỗi case tối đa 1 dòng -> = số case có CTV reply
  const coverage =
    totalCases > 0 ? Math.round((coveredCases / totalCases) * 100) : 0;

  const lines: string[] = [];
  lines.push(`📊 BÁO CÁO HIỆU SUẤT CA [${label.toUpperCase()}] (${shiftWindow})`);
  lines.push(`Tổng số case phát sinh: ${totalCases}`);
  if (perCtv.size === 0) {
    lines.push("(Chưa có CTV nào reply case trong ca này)");
  } else {
    // Sắp xếp giảm dần theo số case.
    const sorted = [...perCtv.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([uname, n], i) => {
      lines.push(`${i + 1}. CTV @${uname}: ${n} Reply`);
    });
  }
  lines.push("------------------------");
  lines.push(`Tỷ lệ bao phủ: ${coverage}%`);
  return lines.join("\n");
}

// Xử lý lệnh /baocao (admin, chat riêng): dựng báo cáo ca hiện tại và trả về
// chat riêng của admin. Trả true nếu đã xử lý lệnh này.
export async function maybeHandleReportCommand(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  adminIds: number[]
): Promise<boolean> {
  const text = (message.text ?? "").trim().toLowerCase();
  if (text !== "/baocao") return false;
  // Chỉ admin trong chat riêng.
  const fromId = message.from?.id;
  if (
    message.chat.type !== "private" ||
    fromId === undefined ||
    !adminIds.includes(fromId)
  ) {
    return true; // nuốt lệnh, không làm gì nếu không đúng quyền/chat
  }
  const report = await buildShiftReport(supabase);
  await telegram.sendMessage(message.chat.id, report);
  return true;
}


// =====================================================================
// TỰ THÊM CTV VÀO CA TỪ FORM CHECK-IN (nhóm VHHS điểm danh tự động)
// Bot đọc form check-in trong topic điểm danh, trích @username + giờ,
// quy ca theo giờ, thêm CTV vào ca tương ứng. List CTV ca tự reset mỗi
// ngày (dựa trên ctvShiftDate). Chỉ nhận form chứa key "VHHS" + "Check in".
// =====================================================================

export interface ParsedCheckin {
  username: string; // đã gọt @, lowercase
  shiftKey: "sang" | "chieu" | "toi";
}

// parseCheckinForm(text): trích CTV + ca từ form check-in.
// Yêu cầu form chứa "VHHS" VÀ "Check in" (không phân biệt hoa thường, bỏ dấu),
// có dòng "CTV: @username" và "Thời gian: HH:MM". Trả null nếu không khớp
// (vd Check out, hoặc thiếu trường) -> bỏ qua.
export function parseCheckinForm(text: string): ParsedCheckin | null {
  const raw = text ?? "";
  const noAccentLower = stripDiacritics(raw);

  // Chỉ nhận đúng key team VHHS.
  if (!noAccentLower.includes("vhhs")) return null;
  // Chỉ nhận CHECK IN (loại check out). "check in" sau khi bỏ dấu/thường.
  if (!noAccentLower.includes("check in")) return null;
  if (noAccentLower.includes("check out")) return null;

  // Trích username sau "CTV:" (có thể có @). Lấy token username hợp lệ.
  const ctvMatch = raw.match(/CTV\s*:\s*@?([A-Za-z0-9_]{3,})/i);
  if (!ctvMatch) return null;
  const username = ctvMatch[1].trim().toLowerCase();
  if (username === "") return null;

  // Trích giờ "HH:MM" sau "Thời gian:" (ưu tiên), fallback: HH:MM đầu tiên.
  let hh: number | null = null;
  let mm: number | null = null;
  const timeLabeled = raw.match(/Th[ờo]i\s*gian\s*:\s*(\d{1,2}):(\d{2})/i);
  const timeAny = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  const picked = timeLabeled ?? timeAny;
  if (picked) {
    hh = parseInt(picked[1], 10);
    mm = parseInt(picked[2], 10);
  }
  if (hh === null || mm === null || isNaN(hh) || isNaN(mm)) return null;

  // Quy ca theo giờ form: sáng <13:30, chiều 13:30-<17:30, tối >=17:30.
  const t = hh + mm / 60;
  const shiftKey: "sang" | "chieu" | "toi" =
    t < 13.5 ? "sang" : t < 17.5 ? "chieu" : "toi";

  return { username, shiftKey };
}

// addCtvFromCheckin(supabase, text, now): nếu text là form check-in hợp lệ,
// thêm CTV vào list ca tương ứng trong config (-9001). Tự reset toàn bộ list
// ca khi sang ngày mới (ctvShiftDate != hôm nay). Trả về true nếu đã xử lý
// (dù thêm mới hay đã có), false nếu không phải form check-in.
export async function addCtvFromCheckin(
  supabase: SupabaseClient,
  text: string,
  now: Date = new Date()
): Promise<boolean> {
  const parsed = parseCheckinForm(text);
  if (!parsed) return false;
  if (!supabase || typeof supabase.from !== "function") return true;

  try {
    const config = await loadMonitorConfig(supabase);
    const today = getVnDateString(now);

    // Reset list ca khi sang ngày mới.
    if (config.ctvShiftDate !== today) {
      config.ctvSang = [];
      config.ctvChieu = [];
      config.ctvToi = [];
      config.ctvShiftDate = today;
    }

    const key =
      parsed.shiftKey === "sang"
        ? "ctvSang"
        : parsed.shiftKey === "chieu"
        ? "ctvChieu"
        : "ctvToi";
    const current = (config[key] || []).map((u) =>
      u.replace(/^@/, "").trim().toLowerCase()
    );
    if (!current.includes(parsed.username)) {
      current.push(parsed.username);
      config[key] = current;
      await saveMonitorConfig(supabase, config);
    }
    return true;
  } catch (e) {
    console.error("Lỗi addCtvFromCheckin:", e);
    return true;
  }
}

// =====================================================================
// LỆNH /checkin (admin, chat riêng): liệt kê CTV ĐÃ CHECK-IN của CA HIỆN TẠI.
// Đọc config (-9001). List CTV ca tự reset theo ngày (ctvShiftDate): nếu
// ctvShiftDate != hôm nay thì coi như chưa ai check-in (list cũ đã hết hạn).
// =====================================================================

// Dựng text danh sách CTV đã check-in cho ca hiện tại.
export async function buildCheckinList(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<string> {
  const config = await loadMonitorConfig(supabase);
  const { key, label } = getCurrentShiftVn(now);
  const today = getVnDateString(now);

  // List ca chỉ hợp lệ nếu thuộc về hôm nay; nếu khác ngày -> đã hết hạn.
  let list: string[] = [];
  if (config.ctvShiftDate === today) {
    const raw =
      key === "sang"
        ? config.ctvSang
        : key === "chieu"
        ? config.ctvChieu
        : config.ctvToi;
    list = (raw || []).map((u) => u.replace(/^@/, "").trim().toLowerCase());
  }

  const lines: string[] = [];
  lines.push(`📋 CTV đã check-in ca [${label.toUpperCase()}] hôm nay (${today}):`);
  if (list.length === 0) {
    lines.push("(Chưa có ai check-in)");
  } else {
    list.forEach((u, i) => {
      lines.push(`${i + 1}. @${u}`);
    });
    lines.push("------------------------");
    lines.push(`Tổng: ${list.length} CTV`);
  }
  return lines.join("\n");
}

// Xử lý lệnh /checkin (admin, chat riêng): liệt kê CTV đã check-in ca hiện
// tại và trả về chat riêng của admin. Trả true nếu đã xử lý lệnh này.
export async function maybeHandleCheckinCommand(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  adminIds: number[]
): Promise<boolean> {
  const text = (message.text ?? "").trim().toLowerCase();
  if (text !== "/checkin") return false;
  // Chỉ admin trong chat riêng.
  const fromId = message.from?.id;
  if (
    message.chat.type !== "private" ||
    fromId === undefined ||
    !adminIds.includes(fromId)
  ) {
    return true; // nuốt lệnh, không làm gì nếu không đúng quyền/chat
  }
  const list = await buildCheckinList(supabase);
  await telegram.sendMessage(message.chat.id, list);
  return true;
}
