// Core orchestration: classify a Telegram update and run the relay flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSensitive } from "./detector.js";
import { buildLogRecord, buildUserRecord, displayName } from "./mapping.js";
import { insertLog, upsertUser } from "./supabase.js";
import {
  deleteWithRetry,
  TimeoutError,
  withTimeout,
  type TelegramClient,
} from "./telegram.js";
import type {
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

// User-facing Vietnamese strings — kept byte-for-byte exact.
const WARNING_NOT_STARTED =
  "⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox.";

function confirmationLine(_ctvName: string): string {
  return `🔒 Em đã gửi tin nhắn cho mình rồi ạ. Anh/chị kiểm tra tin nhắn nha ạ`;
}

// Builds the inbox payload delivered to the QLL: the QLL's own request first,
// then the credential text the CTV replied with. When the request has no text,
// only the credential text is sent (no empty header line).
function buildInboxText(requestText: string, credentialText: string): string {
  const request = requestText.trim();
  if (request === "") {
    return credentialText;
  }
  return `📩 Yêu cầu của bạn: ${request}\n\n${credentialText}`;
}

const START_ACK =
  "✅ Inbox đã sẵn sàng. Bot sẽ gửi thông tin Tài khoản / Mật khẩu vào đây.";

// Internal (non-glossary) audit markers written to the status column.
const STATUS_DELIVERY_FAILURE = "Lỗi gửi Inbox";
const STATUS_DELETION_FAILURE = "Lỗi thu hồi";

// Timeout budget for the inbox delivery, per spec.
const SEND_TIMEOUT_MS = 10_000;

export interface Deps {
  telegram: TelegramClient;
  supabase: SupabaseClient;
  // When false, the credential relay flow is fully disabled: the bot never
  // deletes, sends to inbox, or replies. It only passively collects users.
  relayEnabled: boolean;
}

export async function handleUpdate(
  update: TelegramUpdate,
  deps: Deps
): Promise<void> {
  const message = update.message;
  if (!message) {
    return;
  }

  // Passive user collection runs on EVERY group update, regardless of the
  // relay switch: capture the sender and any newly-joined members.
  await collectUsers(message, deps);

  // HARD STOP when relay is disabled. The bot must not delete, send to inbox,
  // or reply to anyone while collecting users. This is the "nằm vùng" mode.
  if (!deps.relayEnabled) {
    return;
  }

  // Branch (a): private-chat /start -> acknowledge inbox is open.
  if (message.chat.type === "private") {
    if (message.text && message.text.startsWith("/start")) {
      await deps.telegram.sendMessage(message.chat.id, START_ACK);
    }
    return;
  }

  // Branch (d): group message that is NOT a reply -> ignore.
  const replyTo = message.reply_to_message;
  if (!replyTo) {
    return;
  }

  const sensitiveText = message.text ?? "";

  // Branch (c): group reply that is NOT sensitive -> ignore.
  if (!isSensitive(sensitiveText)) {
    return;
  }

  // Branch (b): sensitive group reply -> relay flow.
  await relay(message, replyTo, deps);
}

// Passively records users seen in a group chat into telegram_users_qll.
// Captures the message sender and any newly-joined members. Never touches
// private chats, and skips bot accounts and the "sender" of a join event
// (the message.from on a join event is whoever added them / the joiner).
async function collectUsers(
  message: TelegramMessage,
  deps: Deps
): Promise<void> {
  const chat = message.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  // De-duplicate within this single update by telegram_id.
  const seen = new Map<number, TelegramUser>();

  if (message.from && !isBot(message.from)) {
    seen.set(message.from.id, message.from);
  }
  for (const member of message.new_chat_members ?? []) {
    if (!isBot(member)) {
      seen.set(member.id, member);
    }
  }

  for (const user of seen.values()) {
    await upsertUser(deps.supabase, buildUserRecord(user, chat));
  }
}

function isBot(user: TelegramUser): boolean {
  return user.is_bot === true;
}

async function relay(
  message: TelegramMessage,
  replyTo: TelegramMessage,
  deps: Deps
): Promise<void> {
  const groupChatId = message.chat.id;
  const replyMessageId = message.message_id;
  const sensitiveText = message.text ?? "";
  const inboxText = buildInboxText(replyTo.text ?? "", sensitiveText);
  const ctvName = message.from ? displayName(message.from) : "";
  const qllId = replyTo.from?.id;

  // Step 1: deliver to the QLL inbox FIRST, with a 10s timeout.
  let sendResult:
    | { ok: true; messageId: number }
    | { ok: false; forbidden: boolean; description: string };
  let timedOut = false;

  try {
    sendResult = await withTimeout(
      deps.telegram.sendMessage(qllId as number, inboxText),
      SEND_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      // No response within 10s (Requirement 4.5) -> treat identically to 403.
      timedOut = true;
      sendResult = { ok: false, forbidden: false, description: "timeout" };
    } else {
      // Any other transport rejection is a non-403 delivery failure
      // (Requirement 2.3): retain the reply, do NOT take the destructive path.
      sendResult = {
        ok: false,
        forbidden: false,
        description: error instanceof Error ? error.message : "send error",
      };
    }
  }

  // Security path: 403 Forbidden OR 10s timeout — delete FIRST, then warn.
  if (timedOut || (!sendResult.ok && sendResult.forbidden)) {
    const deleteResult = await deleteWithRetry(
      deps.telegram,
      groupChatId,
      replyMessageId
    );

    if (deleteResult.ok) {
      await insertLog(
        deps.supabase,
        buildLogRecord(message, "Lỗi chưa start bot")
      );
      await deps.telegram.sendMessage(
        groupChatId,
        WARNING_NOT_STARTED,
        replyTo.message_id
      );
    } else {
      // Deletes failed; log the delete failure. The warning stays pending
      // until the reply is confirmed deleted.
      await insertLog(
        deps.supabase,
        buildLogRecord(message, STATUS_DELETION_FAILURE)
      );
    }
    return;
  }

  // Non-403 delivery failure: retain the reply, do NOT delete.
  if (!sendResult.ok) {
    await insertLog(
      deps.supabase,
      buildLogRecord(message, STATUS_DELIVERY_FAILURE)
    );
    return;
  }

  // Success path: delete the group reply, then log and confirm.
  const deleteResult = await deleteWithRetry(
    deps.telegram,
    groupChatId,
    replyMessageId
  );

  if (deleteResult.ok) {
    await insertLog(deps.supabase, buildLogRecord(message, "Đã gửi Inbox"));
    await deps.telegram.sendMessage(
      groupChatId,
      confirmationLine(ctvName),
      replyTo.message_id
    );
  } else {
    // Delivered to inbox but all 3 delete retries failed.
    await insertLog(
      deps.supabase,
      buildLogRecord(message, STATUS_DELETION_FAILURE)
    );
  }
}
