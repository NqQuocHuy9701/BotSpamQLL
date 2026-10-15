// Shared TypeScript types for the subset of Telegram objects used by the bot
// plus the Supabase log row shape.

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

// A document attachment on a Telegram message (used by the batch-announcement
// feature when the admin DMs the bot an .xlsx file).
export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number; // Unix seconds
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  // Present when the message carries a file attachment (batch feature).
  document?: TelegramDocument;
  // Present when one or more users join the group. Used by the passive
  // user-collection mode to capture newly-joined members.
  new_chat_members?: TelegramUser[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// The three enumerated glossary statuses — Vietnamese strings kept exact.
export type LogStatus = "Đã gửi Inbox" | "Lỗi chưa start bot" | "Đã thu hồi";

// One row in the telegram_users_qll table (passive user-collection mode).
export interface UserRecord {
  telegram_id: number;
  username: string | null;
  full_name: string;
  chat_id: number;
  chat_title: string | null;
}

// One parsed data row from the batch-announcement Excel sheet. All five
// columns are trimmed strings; lichHoc may be "" (blank schedule allowed).
export interface BatchRow {
  tenHS: string;
  maLop: string;
  ngayHoc: string;
  qll: string;
  lichHoc: string;
}

// A ready-to-send batch item: a row whose QLL name was successfully mapped to
// a Telegram username. These are what get persisted to pending_batches and
// posted to the group on /ok.
export interface MappedItem {
  tenHS: string;
  maLop: string;
  ngayHoc: string;
  lichHoc: string;
  username: string;
}

// One row in the pending_batches table, keyed by the admin's telegram_id.
export interface PendingBatch {
  admin_id: number;
  items: MappedItem[];
}

export interface LogRecord {
  created_at: string; // ISO UTC
  qll_telegram_id: string;
  qll_name: string;
  request_content: string;
  ctv_name: string;
  response_content: string;
  // The three glossary LogStatus values on the happy/403 paths, plus internal
  // audit markers (delivery-failure / deletion-failure) on the error paths.
  status: LogStatus | string;
}
