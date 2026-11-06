// lib/monitor.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "./telegram.js";
import type { TelegramMessage } from "./types.js";
import { buildSlaReminder, buildUrgentReminder } from "./messages.js";

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
  // Danh sách CTV LOẠI TRỪ khỏi SLA tag ở nhóm QLL (CTV trực nhóm khác). Tự
  // reset theo ngày qua slaExcludeDate. Quản lý bằng lệnh /slaoff /slaon.
  slaExclude?: string[];
  slaExcludeDate?: string;
  // Dấu chống gửi trùng báo cáo cuối ca tự động: "<YYYY-MM-DD>-<sang|chieu|toi>".
  lastShiftReportKey?: string;
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
      slaExclude: Array.isArray(raw.slaExclude) ? raw.slaExclude : [],
      slaExcludeDate: typeof raw.slaExcludeDate === "string" ? raw.slaExcludeDate : undefined,
      lastShiftReportKey:
        typeof raw.lastShiftReportKey === "string" ? raw.lastShiftReportKey : undefined,
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
// Bảng tổng hợp toàn bộ lệnh tương tác với bot (dùng cho /help, /menu, /start).
export function buildHelpText(): string {
  return [
    "📖 DANH SÁCH LỆNH BOT (gõ ở chat riêng với bot)",
    "",
    "👥 ĐIỀU PHỐI / CTV CA:",
    "• /dp — xem cấu hình điều phối + CTV các ca",
    "• /dp <sáng|chiều|tối> <tên> — đổi điều phối viên ca",
    "• /addctvca <sang|chieu|toi> @u1 @u2 — thêm CTV trực ca",
    "• /delctvca <sang|chieu|toi> @u — xóa CTV trực ca",
    "• /settitle @u <anh|chị> — đặt danh xưng",
    "",
    "📊 BÁO CÁO / CHECK-IN:",
    "• /checkin — CTV đã check-in ca hiện tại (thực tế)",
    "• /baocao — báo cáo React/Reply/Tổng mỗi CTV (gộp 2 nhóm)",
    "",
    "⏰ SLA (nhắc case quá 5 phút):",
    "• /slaoff @u1 @u2 — tắt SLA tag cho CTV (nhóm QLL, theo ngày)",
    "• /slaon @u — bật lại SLA tag",
    "• /slaoff — xem danh sách đang tắt hôm nay",
    "• /tatsla — tắt toàn bộ giám sát SLA",
    "• /batsla — bật lại giám sát SLA",
    "",
    "📨 THÔNG BÁO HS (gửi hàng loạt):",
    "• (gửi file Excel) — nạp danh sách HS",
    "• /ok — gửi ngay | /ok 21:00 | /ok 16/10 21:00 — hẹn giờ",
    "• /remap — map lại QLL chưa nhận diện (sau khi /adduser, khỏi gửi lại file)",
    "• /huy — hủy batch đang chờ",
    "• /cancel — dừng/xóa các tin chưa gửi",
    "",
    "👤 QUẢN LÝ QLL:",
    "• /adduser <username> <họ tên> — thêm QLL thủ công",
    "• /finduser <họ tên> — tìm QLL",
    "• /listusers — liệt kê QLL",
    "",
    "📢 KHÁC:",
    "• /spam — đăng thông báo vào nhóm QLL (admin)",
    "• /help hoặc /menu — hiện bảng lệnh này",
    "",
    "💬 NÓI CHUYỆN VỚI BEE (không cần gõ lệnh):",
    '• Nhắn riêng (admin) hoặc tag @vh_messenger_bot trong nhóm, ví dụ "ai đang trực?", "báo cáo ca", "case nào đang treo?"',
  ].join("\n");
}

export async function maybeHandleCoordinatorCommands(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // --- LỆNH /help (/menu): tổng hợp toàn bộ lệnh tương tác với bot ---
  // Lưu ý: KHÔNG bắt /start ở đây — /start giữ luồng mở inbox cho QLL.
  if (lower === "/help" || lower === "/menu") {
    await telegram.sendMessage(message.chat.id, buildHelpText());
    return true;
  }

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
          "💡 Tắt/bật SLA tag nhóm QLL (theo ngày):",
          "/slaoff @user1 @user2  |  /slaon @user  |  /slaoff (xem ds)",
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

  // --- LỆNH /slaoff: loại trừ CTV khỏi SLA tag ở nhóm QLL (hôm nay) ---
  // "/slaoff" (không tham số) -> xem danh sách; "/slaoff @u1 @u2" -> thêm.
  // Danh sách tự reset theo ngày (slaExcludeDate).
  if (lower === "/slaoff" || lower.startsWith("/slaoff ")) {
    const rest = trimmed.slice("/slaoff".length).trim();
    const config = await loadMonitorConfig(supabase);
    const today = getVnDateString(new Date());

    // Reset danh sách nếu sang ngày mới.
    let list =
      config.slaExcludeDate === today && Array.isArray(config.slaExclude)
        ? config.slaExclude.map((u) => u.replace(/^@/, "").trim().toLowerCase())
        : [];

    if (rest === "") {
      await telegram.sendMessage(
        message.chat.id,
        list.length > 0
          ? `🚫 CTV đang TẮT SLA hôm nay (${today}) (${list.length}): ${list
              .map((u) => `@${u}`)
              .join(", ")}`
          : `🚫 Chưa có CTV nào tắt SLA hôm nay (${today}).`
      );
      return true;
    }

    const tokens = rest
      .split(/[\s,]+/)
      .map((t) => t.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);
    const set = new Set(list);
    for (const t of tokens) set.add(t);
    list = Array.from(set);

    config.slaExclude = list;
    config.slaExcludeDate = today;
    await saveMonitorConfig(supabase, config);
    await telegram.sendMessage(
      message.chat.id,
      `🚫 Đã TẮT SLA tag (nhóm QLL) cho: ${tokens
        .map((u) => `@${u}`)
        .join(", ")}.\nDanh sách hôm nay (${list.length}): ${list
        .map((u) => `@${u}`)
        .join(", ")}`
    );
    return true;
  }

  // --- LỆNH /slaon: gỡ CTV khỏi danh sách loại trừ SLA (bật lại tag) ---
  if (lower.startsWith("/slaon")) {
    const rest = trimmed.slice("/slaon".length).trim();
    if (rest === "") {
      await telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /slaon @username (bật lại SLA tag cho CTV)"
      );
      return true;
    }
    const config = await loadMonitorConfig(supabase);
    const today = getVnDateString(new Date());
    let list =
      config.slaExcludeDate === today && Array.isArray(config.slaExclude)
        ? config.slaExclude.map((u) => u.replace(/^@/, "").trim().toLowerCase())
        : [];
    const tokens = rest
      .split(/[\s,]+/)
      .map((t) => t.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);
    list = list.filter((u) => !tokens.includes(u));

    config.slaExclude = list;
    config.slaExcludeDate = today;
    await saveMonitorConfig(supabase, config);
    await telegram.sendMessage(
      message.chat.id,
      `✅ Đã BẬT lại SLA tag cho: ${tokens.map((u) => `@${u}`).join(", ")}.\nCòn tắt (${
        list.length
      }): ${list.length > 0 ? list.map((u) => `@${u}`).join(", ") : "(trống)"}`
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
    // v5: câu nhắc tin khẩn đa dạng (chỉ đổi chữ, giữ nguyên người tag + reply).
    const { text: urgentText } = buildUrgentReminder({
      title: dpTitle,
      username,
      qllName: senderName,
    });
    await telegram.sendMessage(message.chat.id, urgentText, message.message_id);
  }

  if (watchedChanged) {
    await saveWatchedMessages(supabase, watched);
  }
}
export async function checkUnansweredMessages(
  telegram: TelegramClient,
  supabase: SupabaseClient,
  nowMs: number = Date.now(),
  checkinClient?: SupabaseClient
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;

  // CHỈ nhắc SLA trong khung 07:00–21:59 giờ VN. Quá 22h hoặc trước 7h sáng ->
  // ngừng tag (case giữ nguyên reported=false để nhắc lại từ 7h sáng hôm sau).
  const vnHour = new Date(nowMs + VN_OFFSET_MS).getUTCHours();
  if (vnHour >= 22 || vnHour < 7) return;

  // Lấy mốc 5 phút trước
  const fiveMinsAgo = new Date(nowMs - SLA_TIMEOUT_MS).toISOString();

  // Truy vấn: Chưa handled, chưa reported, quá 5 phút. CHỈ case NHÓM QLL
  // (message_id > 0). Case HTKT lưu dưới id ÂM (scopedCaseId) -> KHÔNG nhắc SLA
  // (và cũng tránh reply hỏng vì id âm không tồn tại ở nhóm QLL).
  const { data: expiredCases, error } = await supabase
    .from("qll_tracking")
    .select("message_id, created_at, sender_name")
    .eq("handled", false)
    .eq("reported", false)
    .gt("message_id", 0)
    .lte("created_at", fiveMinsAgo);

  if (error || !expiredCases || expiredCases.length === 0) return;

  const config = await loadMonitorConfig(supabase);
  const titles = config.userTitles || {};

  // Danh sách CTV ca hiện tại = CHECK-IN THỰC TẾ (bỏ danh sách import tay
  // ctvSang/chieu/toi). Rỗng -> KHÔNG tag ai (giữ case lại, không đánh dấu).
  let currentShiftCtv: string[] = [];
  if (checkinClient) {
    try {
      currentShiftCtv = await getCurrentShiftCheckins(checkinClient, new Date(nowMs));
    } catch {
      currentShiftCtv = [];
    }
  }

  // Loại trừ CTV trong danh sách /slaoff của HÔM NAY (CTV trực nhóm khác).
  const today = getVnDateString(new Date(nowMs));
  if (config.slaExcludeDate === today && Array.isArray(config.slaExclude)) {
    const excl = new Set(
      config.slaExclude.map((u) => u.replace(/^@/, "").trim().toLowerCase())
    );
    currentShiftCtv = currentShiftCtv.filter((u) => !excl.has(u));
  }

  if (currentShiftCtv.length === 0) return; // không còn CTV nào để tag -> không tag

  const processedIds: number[] = [];
  const TARGET_GROUP_ID = -1002273179613;

  let lastIdx: number | undefined; // tránh lặp câu liền kề trong cùng lượt
  for (const item of expiredCases) {
    const randomCtv =
      currentShiftCtv[Math.floor(Math.random() * currentShiftCtv.length)];
    const title = titles[randomCtv.toLowerCase()] || "anh/chị";
    // v5: câu nhắc SLA đa dạng (chỉ đổi chữ, giữ nguyên người tag + reply).
    const { text, index } = buildSlaReminder({
      title,
      username: randomCtv,
      qllName: (item as { sender_name?: string | null }).sender_name,
      avoidIndex: lastIdx,
    });
    lastIdx = index;
    await telegram.sendMessage(TARGET_GROUP_ID, text, item.message_id);
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

// (Đã gỡ ctvListOfCurrentShift: nguồn danh sách CTV ca giờ là check-in thực tế
//  qua getCurrentShiftCheckins / isCtvOfCurrentCheckinShift.)

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
    checkinClient?: SupabaseClient; // nguồn danh sách CTV ca = check-in thực tế
    now?: Date;
  }
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;
  const uname = (opts.replierUsername ?? "").replace(/^@/, "").trim().toLowerCase();
  if (uname === "") return;

  try {
    const now = opts.now ?? new Date();
    // Danh sách CTV ca = CHECK-IN THỰC TẾ (một nguồn duy nhất). Fail-soft: nếu
    // thiếu checkinClient hoặc lỗi -> không chặn (vẫn ghi), tránh mất dữ liệu.
    const allowed = await isCtvOfCurrentCheckinShift(opts.checkinClient, uname, now);
    if (!allowed) return;

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

// Ghi nhận 1 REACT của CTV lên 1 case hợp lệ. Đối xứng với recordCtvReply
// nhưng kind='react'. Chỉ ghi khi:
//  - Người react có username VÀ thuộc danh sách CTV của ca hiện tại (config).
//  - Tin được react là case hợp lệ (có trong qll_tracking).
// Upsert theo (chat_id, message_id, kind='react') => mỗi case 1 dòng react,
// giữ người react cuối. KHÔNG throw (fail-soft) — gọi trong nhánh reaction
// nên tuyệt đối không được làm vỡ luồng SLA.
export async function recordCtvReaction(
  supabase: SupabaseClient,
  opts: {
    chatId: number;
    caseMessageId: number; // message_id của tin được react
    reactorUsername: string | undefined;
    checkinClient?: SupabaseClient; // nguồn danh sách CTV ca = check-in thực tế
    now?: Date;
  }
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;
  const uname = (opts.reactorUsername ?? "").replace(/^@/, "").trim().toLowerCase();
  if (uname === "") return;

  try {
    const now = opts.now ?? new Date();
    const allowed = await isCtvOfCurrentCheckinShift(opts.checkinClient, uname, now);
    if (!allowed) return;

    const { data: caseRow } = await supabase
      .from("qll_tracking")
      .select("message_id")
      .eq("message_id", opts.caseMessageId)
      .maybeSingle();
    if (!caseRow) return;

    const { key } = getCurrentShiftVn(now);
    await supabase.from("shift_interactions").upsert(
      {
        chat_id: opts.chatId,
        message_id: opts.caseMessageId,
        ctv_username: uname,
        kind: "react",
        shift: key,
        shift_date: getVnDateString(now),
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id,message_id,kind" }
    );
  } catch (e) {
    console.error("Lỗi recordCtvReaction:", e);
  }
}

// Dựng text báo cáo hiệu suất ca hiện tại (React + Reply + Tổng hỗ trợ).
// - Danh sách CTV = danh sách CHECK-IN THỰC TẾ của ca (từ checkin_logs).
// - Với mỗi CTV: đếm số tin DISTINCT có React hợp lệ, số tin DISTINCT có Reply
//   hợp lệ (mỗi loại tối đa 1 lượt/tin vì PK theo (chat_id,message_id,kind)),
//   và Tổng hỗ trợ = số tin DISTINCT có ÍT NHẤT 1 tương tác (react HOẶC reply)
//   -> cùng CTV vừa react vừa reply 1 tin chỉ tính 1 lượt tổng.
// - Tổng số case: giữ nguyên cách cũ (qll_tracking theo nhãn ca + created_at
//   >= mốc đầu ca hôm nay) để không đổi logic hiện tại.
// checkinClient undefined -> không lấy được danh sách CTV ca -> báo cáo trống.
export async function buildShiftReport(
  supabase: SupabaseClient,
  checkinClient?: SupabaseClient,
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
  // tối 17:30. UTC = giờ VN - 7h. (GIỮ NGUYÊN mốc cũ cho tổng case.)
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

  // Case phát sinh trong ca hôm nay, TÁCH theo nhóm:
  //  - QLL (message_id > 0): mỗi dòng = 1 case.
  //  - HTKT (message_id < 0, scopedCaseId): gộp theo MÃ (htktCaseKey) -> 2 tin
  //    cùng mã chỉ tính 1 case, 2 mã khác nhau là 2 case.
  let qllCases = 0;
  let htktCases = 0;
  try {
    const { data } = await supabase
      .from("qll_tracking")
      .select("message_id, content")
      .eq("shift_name", label)
      .gte("created_at", shiftStartUtcIso);
    const caseRows = (data as { message_id: number; content: string | null }[] | null) ?? [];
    const htktKeys = new Set<string>();
    for (const r of caseRows) {
      if (r.message_id > 0) qllCases++;
      else if (r.message_id < 0) htktKeys.add(htktCaseKey(r.content ?? ""));
    }
    htktCases = htktKeys.size;
  } catch {
    qllCases = 0;
    htktCases = 0;
  }
  const totalCases = qllCases + htktCases;

  // Danh sách CTV check-in thực tế của ca (giao để chỉ thống kê người này).
  let ctvShiftList: string[] = [];
  if (checkinClient) {
    try {
      ctvShiftList = await getCurrentShiftCheckins(checkinClient, now);
    } catch {
      ctvShiftList = [];
    }
  }
  const ctvSet = new Set(ctvShiftList);

  // Toàn bộ tương tác (reply + react) của ca+ngày.
  let rows: { ctv_username: string | null; kind: string | null; message_id: number | null }[] = [];
  try {
    const { data } = await supabase
      .from("shift_interactions")
      .select("ctv_username, kind, message_id")
      .eq("shift", key)
      .eq("shift_date", shiftDate);
    rows = (data as typeof rows | null) ?? [];
  } catch {
    rows = [];
  }

  // Gom theo CTV: tập tin React, tập tin Reply (distinct message_id).
  type Agg = { react: Set<number>; reply: Set<number> };
  const perCtv = new Map<string, Agg>();
  for (const r of rows) {
    const u = (r.ctv_username ?? "").trim().toLowerCase();
    if (u === "") continue;
    // Chỉ thống kê CTV thuộc danh sách check-in thực tế của ca.
    if (!ctvSet.has(u)) continue;
    const mid = r.message_id;
    if (mid === null || mid === undefined) continue;
    let agg = perCtv.get(u);
    if (!agg) {
      agg = { react: new Set<number>(), reply: new Set<number>() };
      perCtv.set(u, agg);
    }
    if (r.kind === "react") agg.react.add(mid);
    else if (r.kind === "reply") agg.reply.add(mid);
  }

  // Phần tiêu đề (chữ thường, có emoji). Bảng CTV để trong <pre> (monospace)
  // nên các cột thẳng hàng; gửi với parse_mode=HTML (xem maybeHandleReportCommand).
  const head: string[] = [];
  head.push(`📊 BÁO CÁO CA — ${label.toUpperCase()}`);
  head.push(`🕒 ${shiftWindow}`);
  head.push(`👥 CTV: ${ctvShiftList.length} · 📨 Case: ${totalCases}`);
  head.push(`📌 QLL ${qllCases} · 🛠 HTKT ${htktCases}`);

  if (perCtv.size === 0) {
    head.push("");
    head.push("Chưa có CTV nào React/Reply case trong ca này.");
    return head.join("\n");
  }

  const computed = [...perCtv.entries()].map(([uname, agg]) => {
    const react = agg.react.size;
    const reply = agg.reply.size;
    const union = new Set<number>([...agg.react, ...agg.reply]);
    let qll = 0;
    let htkt = 0;
    for (const id of union) {
      if (id > 0) qll++;
      else if (id < 0) htkt++;
    }
    return { uname, react, reply, total: union.size, qll, htkt };
  });
  computed.sort((a, b) => b.total - a.total);

  // Dựng bảng monospace. Cột: # | CTV | Tổng | React | Reply.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const padR = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
  const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

  // 2 BẢNG riêng (trong <pre> nên cột thẳng hàng). Mỗi cột số rộng CỐ ĐỊNH và
  // CĂN PHẢI; tiêu đề số cũng căn phải cùng bề rộng -> thẳng với số bên dưới.
  // Tiêu đề 2 cột cuối bảng 1 dùng CHỮ (React/Reply) thay emoji để không lệch,
  // nhưng vẫn giữ emoji ở hàng đầu để nhìn trực quan (emoji đặt cuối, không
  // nằm trong vùng canh cột).
  const NAME_W = 12; // bề rộng cột tên
  const W_TONG = 5;
  const W_RE = 5;
  const W_REP = 5;

  const tableRows: string[] = [];
  // Bảng 1: # | CTV | Tổng | React(❤) | Reply(💬)
  tableRows.push(
    `${padR("#", 2)} ${padR("CTV", NAME_W)} ${padL("Tổng", W_TONG)} ${padL("❤", W_RE)} ${padL("💬", W_REP)}`
  );
  computed.forEach((c, i) => {
    const name = c.uname.length > NAME_W ? c.uname.slice(0, NAME_W - 1) + "…" : c.uname;
    tableRows.push(
      `${padR(String(i + 1), 2)} ${padR(name, NAME_W)} ${padL(String(c.total), W_TONG)} ${padL(
        String(c.react),
        W_RE
      )} ${padL(String(c.reply), W_REP)}`
    );
  });

  // Bảng 2: CTV | QLL | HTKT
  const W_QLL = 5;
  const W_HTKT = 5;
  const detail: string[] = [];
  detail.push("");
  detail.push(`${padR("CTV", NAME_W + 3)} ${padL("QLL", W_QLL)} ${padL("HTKT", W_HTKT)}`);
  computed.forEach((c) => {
    const name =
      c.uname.length > NAME_W + 3 ? c.uname.slice(0, NAME_W + 2) + "…" : c.uname;
    detail.push(
      `${padR(name, NAME_W + 3)} ${padL(String(c.qll), W_QLL)} ${padL(String(c.htkt), W_HTKT)}`
    );
  });

  const table = esc([...tableRows, ...detail].join("\n"));
  return `${head.join("\n")}\n<pre>${table}</pre>`;
}

// Khóa gộp case HTKT theo MÃ: ưu tiên mã lớp (vd TOAN.2025.1482,
// MOET_TH.2025.0221), không có thì lấy dãy số đầu tiên >= 3 chữ số (mã HS,
// CID, SĐT). Không có mã nào thì dùng nội dung đã chuẩn hóa.
export function htktCaseKey(content: string): string {
  const c = (content ?? "").toUpperCase();
  const cls = c.match(/[A-Z][A-Z_]*\.\d{4}\.\d{3,4}/);
  if (cls) return cls[0];
  const num = c.match(/\d{3,}/);
  if (num) return num[0];
  return c.replace(/\s+/g, " ").trim();
}

// Xử lý lệnh /baocao (admin, chat riêng): dựng báo cáo ca hiện tại và trả về
// chat riêng của admin. Trả true nếu đã xử lý lệnh này.
export async function maybeHandleReportCommand(
  message: TelegramMessage,
  telegram: TelegramClient,
  supabase: SupabaseClient,
  adminIds: number[],
  checkinClient?: SupabaseClient
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
  const report = await buildShiftReport(supabase, checkinClient);
  await telegram.sendMessage(message.chat.id, report, undefined, "HTML");
  return true;
}

// =====================================================================
// TỰ ĐỘNG GỬI BÁO CÁO CUỐI CA cho admin (gọi trong cron mỗi phút).
// Mốc cuối ca (giờ VN): Sáng 12:00, Chiều 17:00, Tối 21:30. Tại mốc (cửa sổ
// 5 phút để cron chắc chắn bắt), dựng báo cáo CỦA CA VỪA KẾT THÚC và gửi cho
// tất cả adminIds. Chống gửi trùng bằng config.lastShiftReportKey =
// "<YYYY-MM-DD>-<shiftKey>" -> mỗi ca/ngày chỉ gửi đúng 1 lần.
// =====================================================================
export async function maybeSendShiftReports(
  telegram: TelegramClient,
  supabase: SupabaseClient,
  adminIds: number[],
  nowMs: number = Date.now(),
  checkinClient?: SupabaseClient
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;

  const vn = new Date(nowMs + VN_OFFSET_MS);
  const vnHour = vn.getUTCHours();
  const vnMin = vn.getUTCMinutes();
  const t = vnHour + vnMin / 60;

  // Xác định ca VỪA KẾT THÚC nếu đang trong cửa sổ 5 phút sau mốc cuối ca.
  // Sáng xong 12:00; Chiều xong 17:00; Tối xong 21:30.
  let endedShift: "sang" | "chieu" | "toi" | null = null;
  if (t >= 12 && t < 12 + 5 / 60) endedShift = "sang";
  else if (t >= 17 && t < 17 + 5 / 60) endedShift = "chieu";
  else if (t >= 21.5 && t < 21.5 + 5 / 60) endedShift = "toi";
  if (!endedShift) return;

  const today = getVnDateString(new Date(nowMs));

  // CHỐNG TRÙNG NGUYÊN TỬ: đọc-rồi-ghi config (cách cũ) vẫn lọt khi 2 lần gọi
  // /api/cron chạy GẦN NHƯ ĐỒNG THỜI (cả 2 cùng đọc thấy "chưa gửi"). Giờ dùng
  // INSERT 1 dòng claim vào pending_batches với admin_id riêng cho (ngày, ca):
  // khóa chính của bảng đảm bảo CHỈ 1 lần insert thành công; lần còn lại bị
  // từ chối 23505 -> không gửi.
  const claimed = await claimShiftReport(supabase, today, endedShift);
  if (!claimed) return;

  // Dựng báo cáo CỦA CA VỪA KẾT THÚC: lùi now vào giữa ca để getCurrentShiftVn
  // trả đúng ca đó (mốc cuối ca có thể đã rơi sang ranh giới ca sau).
  const midShiftMs =
    endedShift === "sang"
      ? atVnTimeMs(nowMs, 10, 0)
      : endedShift === "chieu"
      ? atVnTimeMs(nowMs, 15, 0)
      : atVnTimeMs(nowMs, 19, 0);

  const report = await buildShiftReport(supabase, checkinClient, new Date(midShiftMs));
  for (const adminId of adminIds) {
    try {
      await telegram.sendMessage(adminId, `🕗 [BÁO CÁO CUỐI CA tự động]\n\n${report}`, undefined, "HTML");
    } catch {
      // bỏ qua lỗi gửi 1 admin, không chặn admin còn lại
    }
  }
}

// Claim nguyên tử quyền gửi báo cáo cuối ca cho (ngày, ca). Insert 1 dòng vào
// pending_batches với admin_id = -(YYYYMMDD*10 + chỉ số ca), vd 04/11/2026 ca
// chiều = -202611042. Không đụng -9001/-9002 hay id admin thật (dương).
// Trả true nếu claim thành công (được gửi), false nếu đã có người claim (23505)
// hoặc lỗi (không gửi để tránh trùng; lỗi được log ra).
async function claimShiftReport(
  supabase: SupabaseClient,
  vnDate: string,
  shift: "sang" | "chieu" | "toi"
): Promise<boolean> {
  const idx = shift === "sang" ? 1 : shift === "chieu" ? 2 : 3;
  const claimId = -(Number(vnDate.replace(/-/g, "")) * 10 + idx);
  try {
    const { error } = await supabase
      .from("pending_batches")
      .insert({ admin_id: claimId, items: { shiftReportClaim: `${vnDate}-${shift}` } });
    if (!error) return true;
    if (error.code !== "23505") {
      console.error("Lỗi claim báo cáo cuối ca:", error.message);
    }
    return false;
  } catch (e) {
    console.error("Lỗi claim báo cáo cuối ca:", e);
    return false;
  }
}

// Trả về mốc UTC ms ứng với giờ:phút VN của ngày chứa `nowMs`.
function atVnTimeMs(nowMs: number, vnHour: number, vnMin: number): number {
  const vn = new Date(nowMs + VN_OFFSET_MS);
  return Date.UTC(
    vn.getUTCFullYear(),
    vn.getUTCMonth(),
    vn.getUTCDate(),
    vnHour - 7,
    vnMin,
    0
  );
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
// LỆNH /checkin (admin, chat riêng): liệt kê CTV ĐÃ CHECK-IN THỰC TẾ của CA
// HIỆN TẠI, đọc trực tiếp từ bảng checkin_logs ở PROJECT SUPABASE KHÁC.
//
// Bảng checkin_logs (project check-in): username, loai ("Check in"/"Check out"),
// team ("VHHS"...), created_at timestamptz. LƯU Ý QUAN TRỌNG: created_at lưu
// GIỜ VN nhưng gắn nhãn +00:00 -> KHÔNG cộng offset; đọc thẳng các field UTC
// của chuỗi ISO coi như giờ VN.
//
// Quy tắc: lọc team='VHHS' + loai='Check in' + created_at trong NGÀY VN hôm nay
// + đúng CA hiện tại. Bỏ qua Check out. Dedupe theo username (lowercase).
// Ranh giới ca RIÊNG cho check-in: tối từ 17:00 (xem CHECKIN_TOI_START).
// =====================================================================

// RANH GIỚI CA RIÊNG CHO CHECK-IN (CHỈ áp dụng ở đây, KHÔNG đụng
// getCurrentShiftVn / hệ thống điều phối cũ):
//   Sáng: 08:00 - < 13:00 ; Chiều: 13:00 - < 17:00 ; Tối: >= 17:00.
// (Theo yêu cầu: sáng từ 8g, chiều từ 13g, tối từ 17g. Trước 8h = ngoài ca.)
const CHECKIN_SANG_START = 8; // mốc bắt đầu ca sáng cho check-in (08:00)
const CHECKIN_CHIEU_START = 13; // mốc bắt đầu ca chiều cho check-in (13:00)
const CHECKIN_TOI_START = 17; // mốc bắt đầu ca tối cho check-in (17:00)

function shiftBoundsVn(key: "sang" | "chieu" | "toi"): { lo: number; hi: number } {
  if (key === "sang") return { lo: CHECKIN_SANG_START, hi: CHECKIN_CHIEU_START };
  if (key === "chieu") return { lo: CHECKIN_CHIEU_START, hi: CHECKIN_TOI_START };
  return { lo: CHECKIN_TOI_START, hi: 24 };
}

// Quy ca cho CHECK-IN theo thời điểm `now` (giờ VN), dùng ranh giới riêng
// ở trên. Tách khỏi getCurrentShiftVn để không ảnh hưởng hệ thống cũ.
// Trả null khi NGOÀI giờ ca (trước 08:00 giờ VN) — không ca nào đang diễn ra.
function getCheckinShiftVn(now: Date = new Date()):
  | { key: "sang" | "chieu" | "toi"; label: string }
  | null {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const timeVal = vn.getUTCHours() + vn.getUTCMinutes() / 60;
  if (timeVal < CHECKIN_SANG_START) return null; // trước 8h -> ngoài ca
  if (timeVal < CHECKIN_CHIEU_START) return { key: "sang", label: "Sáng" };
  if (timeVal < CHECKIN_TOI_START) return { key: "chieu", label: "Chiều" };
  return { key: "toi", label: "Tối" };
}

// Lấy danh sách username CTV VHHS đã check-in trong CA HIỆN TẠI của ngày hôm
// nay (theo giờ VN), đã dedupe + lowercase. Trả [] nếu chưa cấu hình client
// hoặc có lỗi (fail-soft, không ném).
export async function getCurrentShiftCheckins(
  checkinClient: SupabaseClient,
  now: Date = new Date()
): Promise<string[]> {
  const shift = getCheckinShiftVn(now);
  if (!shift) return []; // ngoài giờ ca (trước 8h) -> không có ca nào
  const today = getVnDateString(now); // YYYY-MM-DD giờ VN
  const { lo, hi } = shiftBoundsVn(shift.key);

  // created_at là GIỜ VN gắn nhãn +00:00. Nên mốc đầu/cuối CA của ngày hôm nay
  // cũng viết dạng "<today>THH:MM:SS+00:00" (giờ VN) để lọc THẲNG ở tầng DB.
  // Việc này tránh giới hạn mặc định 1000 dòng của Supabase (nếu kéo hết lịch
  // sử rồi lọc JS, các dòng hôm nay có thể bị cắt mất -> trả rỗng sai).
  const toHHMM = (dec: number): string => {
    const h = Math.floor(dec);
    const m = Math.round((dec - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const startIso = `${today}T${toHHMM(lo)}:00+00:00`;
  // hi có thể = 24 (ca tối) -> dùng mốc cuối ngày 23:59:59.999.
  const endIso =
    hi >= 24
      ? `${today}T23:59:59.999+00:00`
      : `${today}T${toHHMM(hi)}:00+00:00`;

  let rows: { username: string | null }[] = [];
  try {
    const { data } = await checkinClient
      .from("checkin_logs")
      .select("username, created_at")
      .eq("team", "VHHS")
      .eq("loai", "Check in")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: false });
    rows = (data as { username: string | null }[] | null) ?? [];
  } catch {
    rows = [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of rows) {
    const uname = (r.username ?? "").trim().replace(/^@/, "").toLowerCase();
    if (uname === "") continue;
    if (seen.has(uname)) continue;
    seen.add(uname);
    result.push(uname);
  }
  return result;
}

// Kiểm tra 1 username có thuộc danh sách CHECK-IN THỰC TẾ của ca hiện tại.
// FAIL-SOFT: nếu không có checkinClient hoặc query lỗi -> trả true (không chặn),
// để việc ghi reply/react không bị mất dữ liệu khi nguồn check-in tạm trục trặc.
async function isCtvOfCurrentCheckinShift(
  checkinClient: SupabaseClient | undefined,
  username: string,
  now: Date
): Promise<boolean> {
  if (!checkinClient) return true; // không cấu hình -> không chặn
  try {
    const list = await getCurrentShiftCheckins(checkinClient, now);
    return list.includes(username);
  } catch {
    return true; // lỗi -> fail-soft, không chặn
  }
}

// Dựng text danh sách CTV đã check-in thực tế cho ca hiện tại.
export async function buildCheckinList(
  checkinClient: SupabaseClient,
  now: Date = new Date()
): Promise<string> {
  const shift = getCheckinShiftVn(now);
  const today = getVnDateString(now);
  if (!shift) {
    return `⏰ Ngoài giờ ca (ca sáng bắt đầu từ 08:00). Chưa có ca nào đang diễn ra.`;
  }
  const list = await getCurrentShiftCheckins(checkinClient, now);

  const lines: string[] = [];
  lines.push(`📋 CTV đã check-in ca [${shift.label.toUpperCase()}] hôm nay (${today}):`);
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
// tại (từ checkin_logs) và trả về chat riêng của admin. Trả true nếu đã xử lý
// lệnh này. checkinClient undefined -> báo tính năng chưa bật.
export async function maybeHandleCheckinCommand(
  message: TelegramMessage,
  telegram: TelegramClient,
  checkinClient: SupabaseClient | undefined,
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
  if (!checkinClient) {
    await telegram.sendMessage(
      message.chat.id,
      "⚠️ Tính năng check-in chưa được cấu hình (thiếu CHECKIN_SUPABASE_URL/KEY)."
    );
    return true;
  }
  const list = await buildCheckinList(checkinClient);
  await telegram.sendMessage(message.chat.id, list);
  return true;
}
