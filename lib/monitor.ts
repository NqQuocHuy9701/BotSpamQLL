// lib/monitor.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "./telegram.js";
import type { TelegramMessage, TelegramMessageReaction } from "./types.js";

const CONFIG_ROW_ID = -9001;
const WATCH_ROW_ID = -9002;
export const SLA_TIMEOUT_MS = 5 * 60 * 1000; // 5 phút
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface ShiftCoordinatorConfig {
  sang: string;
  chieu: string;
  toi: string;
  defaultDp: string;
  ctvUsernames: string[];
}

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

export function getCurrentShiftVn(now: Date = new Date()): {
  key: "sang" | "chieu" | "toi";
  label: string;
} {
  const vnTime = new Date(now.getTime() + VN_OFFSET_MS);
  const hour = vnTime.getUTCHours();
  if (hour < 12) return { key: "sang", label: "Sáng" };
  if (hour < 18) return { key: "chieu", label: "Chiều" };
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

// Xử lý các lệnh quản lý /dp, /đp, /addctv, /delctv
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
      await telegram.sendMessage(
        message.chat.id,
        [
          "📋 Cấu hình Điều phối viên theo ca:",
          `• Ca Sáng (00h-12h): @${config.sang}`,
          `• Ca Chiều (12h-18h): @${config.chieu}`,
          `• Ca Tối (18h-24h): @${config.toi}`,
          `👉 Hiện tại đang là ca ${active.shiftLabel} -> Tag: @${active.username}`,
          "",
          `👥 Danh sách CTV Vận hành (${config.ctvUsernames.length}): ${ctvList}`,
          "",
          "💡 Cú pháp đổi điều phối:",
          "/đp sáng HuyNQ5 | /đp chiều HuyNQ5 | /đp tối HuyNQ5",
          "💡 Cú pháp thêm/xóa CTV vận hành:",
          "/addctv @user1 @user2 | /delctv @user1",
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

// Bắt sự kiện thả Icon (Reaction) trong nhóm để giải phóng SLA 5 phút
export async function handleGroupReaction(
  reaction: TelegramMessageReaction,
  supabase: SupabaseClient,
  targetChatId: number
): Promise<void> {
  if (reaction.chat.id !== targetChatId) return;
  if (!Array.isArray(reaction.new_reaction) || reaction.new_reaction.length === 0) {
    return;
  }
  const watched = await loadWatchedMessages(supabase);
  const filtered = watched.filter((w) => w.messageId !== reaction.message_id);
  if (filtered.length !== watched.length) {
    await saveWatchedMessages(supabase, filtered);
  }
}

// Xử lý tin nhắn trong nhóm QLL (Bắt từ khóa gấp hoặc đưa vào hàng đợi 5 phút)
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

  const config = await loadMonitorConfig(supabase);
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

  const senderUname = (message.from.username ?? "").trim().toLowerCase();
  const isCtvOrAdmin =
    adminIds.includes(message.from.id) ||
    (senderUname !== "" && config.ctvUsernames.includes(senderUname));

  if (isCtvOrAdmin) {
    if (watchedChanged) {
      await saveWatchedMessages(supabase, watched);
    }
    return;
  }

  const text = (message.text ?? message.caption ?? "").trim();
  if (text === "") {
    if (watchedChanged) await saveWatchedMessages(supabase, watched);
    return;
  }

  // RULE 1: Từ khóa khẩn cấp -> Tag ngay với mẫu câu yêu cầu
  if (isUrgentQllMessage(text)) {
    const { username } = getActiveCoordinator(config);
    await telegram.sendMessage(
      message.chat.id,
      `@${username} Anh/chị ơi, hỗ trợ case này ạ!`,
      message.message_id
    );
    if (watchedChanged) {
      await saveWatchedMessages(supabase, watched);
    }
    return;
  }

  // RULE 2: Tin nhắn thường của QLL -> Đưa vào danh sách đếm ngược 5 phút
  watched.push({
    messageId: message.message_id,
    chatId: message.chat.id,
    senderId: message.from.id,
    createdAtMs: Date.now(),
  });
  await saveWatchedMessages(supabase, watched);
}

// Hàm kiểm tra SLA 5 phút (Chạy trong Cron mỗi phút)
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

  const remaining: WatchedGroupMessage[] = [];
  let changed = false;

  for (const item of watched) {
    const ageMs = nowMs - item.createdAtMs;
    if (ageMs > 12 * 60 * 60 * 1000) {
      changed = true;
      continue;
    }

    if (ageMs >= SLA_TIMEOUT_MS) {
      // Quá 5 phút không ai nhận -> Tag điều phối với mẫu câu yêu cầu
      await telegram.sendMessage(
        item.chatId,
        `@${username} Anh/chị ơi, hỗ trợ case này ạ!`,
        item.messageId
      );
      changed = true;
    } else {
      remaining.push(item);
    }
  }

  if (changed) {
    await saveWatchedMessages(supabase, remaining);
  }
}
// Hàm lưu cấu hình chung (ví dụ: trạng thái bật/tắt SLA) vào dòng ID -9001
export async function updateConfig(supabase: SupabaseClient, newConfig: Record<string, any>): Promise<void> {
  const CONFIG_ROW_ID = -9001;
  
  // Đọc dữ liệu cũ đang có ở dòng -9001
  const { data } = await supabase
    .from('pending_batches')
    .select('items')
    .eq('admin_id', CONFIG_ROW_ID)
    .single();

  let existingItems = data?.items || {};
  if (typeof existingItems !== 'object') {
    existingItems = {};
  }

  // Trộn cấu hình mới vào cấu hình cũ
  const updatedItems = { ...existingItems, ...newConfig };

  // Ghi đè ngược lại vào bảng pending_batches
  await supabase
    .from('pending_batches')
    .upsert({
      admin_id: CONFIG_ROW_ID,
      items: updatedItems,
      created_at: new Date().toISOString(),
    }, { onConflict: 'admin_id' });
}