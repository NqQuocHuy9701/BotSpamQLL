// Core orchestration: classify a Telegram update and run the relay flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSensitive } from "./detector.js";
import { buildLogRecord, displayName } from "./mapping.js";
import { insertLog } from "./supabase.js";
import {
  deleteWithRetry,
  withTimeout,
  type TelegramClient,
} from "./telegram.js";
import type { TelegramMessage, TelegramUpdate } from "./types.js";

// User-facing Vietnamese strings — kept byte-for-byte exact.
const WARNING_NOT_STARTED =
  "⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox.";

function confirmationLine(ctvName: string): string {
  return `🔒 ${ctvName} đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL.`;
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
}

export async function handleUpdate(
  update: TelegramUpdate,
  deps: Deps
): Promise<void> {
  const message = update.message;
  if (!message) {
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

async function relay(
  message: TelegramMessage,
  replyTo: TelegramMessage,
  deps: Deps
): Promise<void> {
  const groupChatId = message.chat.id;
  const replyMessageId = message.message_id;
  const sensitiveText = message.text ?? "";
  const ctvName = message.from ? displayName(message.from) : "";
  const qllId = replyTo.from?.id;

  // Step 1: deliver to the QLL inbox FIRST, with a 10s timeout.
  let sendResult:
    | { ok: true; messageId: number }
    | { ok: false; forbidden: boolean; description: string };
  let timedOut = false;

  try {
    sendResult = await withTimeout(
      deps.telegram.sendMessage(qllId as number, sensitiveText),
      SEND_TIMEOUT_MS
    );
  } catch {
    // Timeout (or send threw) is treated identically to a 403.
    timedOut = true;
    sendResult = { ok: false, forbidden: false, description: "timeout" };
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
      await deps.telegram.sendMessage(groupChatId, WARNING_NOT_STARTED);
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
    await deps.telegram.sendMessage(groupChatId, confirmationLine(ctvName));
  } else {
    // Delivered to inbox but all 3 delete retries failed.
    await insertLog(
      deps.supabase,
      buildLogRecord(message, STATUS_DELETION_FAILURE)
    );
  }
}
