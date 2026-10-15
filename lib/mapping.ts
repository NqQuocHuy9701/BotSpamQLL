// Display-name and LogRecord field-mapping helpers.

import type {
  LogRecord,
  TelegramChat,
  TelegramMessage,
  TelegramUser,
  UserRecord,
} from "./types.js";

// first + " " + last when last present, else first, else username, else "".
export function displayName(user: TelegramUser): string {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return user.username ?? "";
}

// Builds a telegram_users_qll row from a seen user and the chat they were seen
// in. username is null when the user has not set one; full_name uses the same
// first/last/username fallback as displayName.
export function buildUserRecord(
  user: TelegramUser,
  chat: TelegramChat
): UserRecord {
  return {
    telegram_id: user.id,
    username: user.username ?? null,
    full_name: displayName(user),
    chat_id: chat.id,
    chat_title: chat.title ?? null,
  };
}

// Derives a LogRecord from the sensitive reply (`message`) and the request it
// replies to (`message.reply_to_message`). The replied-to author is the QLL;
// the reply author is the CTV.
export function buildLogRecord(
  message: TelegramMessage,
  status: LogRecord["status"]
): LogRecord {
  const replyTo = message.reply_to_message;

  const createdAt = replyTo
    ? new Date(replyTo.date * 1000).toISOString()
    : new Date(message.date * 1000).toISOString();

  const qllUser = replyTo?.from;
  const ctvUser = message.from;

  return {
    created_at: createdAt,
    qll_telegram_id: qllUser ? String(qllUser.id) : "",
    qll_name: qllUser ? displayName(qllUser) : "",
    request_content: replyTo?.text ?? "",
    ctv_name: ctvUser ? displayName(ctvUser) : "",
    response_content: message.text ?? "",
    status,
  };
}
