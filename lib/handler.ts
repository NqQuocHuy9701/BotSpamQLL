// Core orchestration: classify a Telegram update and run the relay flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildGroupedAnnouncement,
  buildSummary,
  groupByUsername,
  parseSheet,
} from "./batch.js";
import { isSensitive } from "./detector.js";
import { buildLogRecord, buildUserRecord, displayName } from "./mapping.js";
import { mapQllByUser } from "./qllmap.js";
import { formatVnDateTime, parseOkCommand } from "./schedule.js";
import {
  addUserManual,
  findUserByUsername,
  deletePendingBatch,
  enqueueMessages,
  insertLog,
  listKnownUsers,
  listUsernames,
  loadPendingBatch,
  savePendingBatch,
  upsertUser,
} from "./supabase.js";
import {
  deleteWithRetry,
  TimeoutError,
  withTimeout,
  type TelegramClient,
} from "./telegram.js";
import type {
  MappedItem,
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

// --- /spam: operator triggers an announcement from the bot's PRIVATE chat. ---
// The operator DMs the bot "/spam"; the bot posts ONE announcement into the
// fixed target group below, tagging the QLL. Locked to an allow-list of admin
// telegram_ids; anyone else is ignored. Independent of RELAY_ENABLED.
const SPAMTEST_COMMAND = "/spam";

// Allow-list of operators permitted to trigger /spam from their private chat.
// Add more telegram_ids here as other managers are authorized.
const SPAMTEST_ADMIN_IDS: number[] = [
  6532155675, // Quốc Huy 🐾 (OP_HuyNQ5)
];

// The single target group the announcement is posted into (Kiểu 1: pinned).
const SPAMTEST_TARGET_CHAT_ID = -1002273179613; // [BU VUIHOC VH] VH - QLL Support

// Batch-announcement commands (admin private DM only). On /ok the confirmed
// batch is enqueued into send_queue and drip-sent later by the Vercel cron
// (see api/cron.ts) rather than posted synchronously here.
const BATCH_OK_COMMAND = "/ok";
const BATCH_CANCEL_COMMAND = "/huy";

// Manual QLL-management commands (admin private DM only). Recognized BEFORE the
// document / /ok / /huy logic so they can never be mis-eaten by those branches.
const ADD_USER_COMMAND = "/adduser";
const FIND_USER_COMMAND = "/finduser";
const LIST_USERS_COMMAND = "/listusers";

// How many usernames to preview in the /listusers reply before truncating.
const LIST_USERS_PREVIEW_CAP = 50;

// The sample announcement form, tagging the fixed target @SA_AnhMTK.
const SPAMTEST_MESSAGE = [
  "✅ Thông tin học của con",
  "Học sinh: Nguyễn Đức Minh",
  "Lịch học: T5 (20:30-21:30)",
  "Thời lượng buổi học : 60 phút",
  "Ngày tham gia lớp học: 15-10-2026",
  "Mã lớp học: TCLC.2025.0207 Khối lớp: 3",
  "",
  "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_AnhMTK",
].join("\n");

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

  // /spamtest: admin-only, one message, independent of the relay switch.
  if (await maybeHandleSpamTest(message, deps)) {
    return;
  }

  // Batch announcement from an .xlsx file (admin private DM only). Independent
  // of the relay switch, exactly like /spam.
  if (await maybeHandleBatch(message, deps)) {
    return;
  }

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

// Handles the operator-only /spam command issued from the bot's PRIVATE chat.
// Returns true if the update WAS a /spam attempt (so the caller stops further
// processing), false otherwise. Only an allow-listed admin in a private chat
// may trigger it; anyone/anywhere else is a silent no-op. On success it posts
// exactly ONE announcement into the fixed target group and sends the operator
// a short confirmation in their private chat.
async function maybeHandleSpamTest(
  message: TelegramMessage,
  deps: Deps
): Promise<boolean> {
  const text = message.text?.trim() ?? "";
  if (text !== SPAMTEST_COMMAND) {
    return false;
  }
  // Must be a PRIVATE chat with an allow-listed operator.
  const fromId = message.from?.id;
  const authorized =
    message.chat.type === "private" &&
    fromId !== undefined &&
    SPAMTEST_ADMIN_IDS.includes(fromId);
  if (!authorized) {
    return true; // swallow: not authorized / wrong chat, post nothing
  }
  // Post exactly one announcement into the fixed target group.
  await deps.telegram.sendMessage(SPAMTEST_TARGET_CHAT_ID, SPAMTEST_MESSAGE);
  // Confirm back to the operator privately.
  await deps.telegram.sendMessage(
    message.chat.id,
    "✅ Đã gửi thông báo vào nhóm."
  );
  return true;
}

// True only for a private-chat message sent by an allow-listed operator.
function isAdminPrivate(message: TelegramMessage): boolean {
  const fromId = message.from?.id;
  return (
    message.chat.type === "private" &&
    fromId !== undefined &&
    SPAMTEST_ADMIN_IDS.includes(fromId)
  );
}

// Batch-announcement dispatcher. Only an admin in a private chat is served;
// everyone/everywhere else returns false so normal processing continues (and
// group documents still get passively collected upstream). Returns true when
// this handler OWNED the update. All downstream errors are caught and reported
// privately — the function never throws, so the webhook always returns 200.
//
// Three owned cases:
//   1. a document (any caption that is not /ok): download + parse + map, save
//      the ready-to-send items to pending_batches, reply with a summary. Posts
//      NOTHING to the group.
//   2. /ok: load the pending batch and enqueue one send_queue row per mapped
//      item (fully-formatted announcement text), delete the pending row, and
//      confirm. Posts NOTHING to the group synchronously — the Vercel cron
//      (api/cron.ts) drip-sends the queued rows ~15-20s apart.
//   3. /huy: delete the pending row and confirm.
// Manual QLL-management commands, admin-private only (the caller already gated
// on isAdminPrivate). Returns true when the message WAS one of /adduser,
// /finduser, /listusers (so the batch dispatcher stops), false otherwise. Every
// reply goes privately to message.chat.id; nothing is posted to the group.
async function maybeHandleQllCommands(
  message: TelegramMessage,
  deps: Deps,
  text: string
): Promise<boolean> {
  const lower = text.toLowerCase();

  // /adduser <username> <full name...>
  if (lower.startsWith(ADD_USER_COMMAND)) {
    const rest = text.slice(ADD_USER_COMMAND.length).trim();
    const match = rest.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /adduser @username Họ Tên"
      );
      return true;
    }
    const username = match[1].replace(/^@/, "");
    const fullName = match[2].trim();
    if (username === "" || fullName === "") {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /adduser @username Họ Tên"
      );
      return true;
    }
    // Reject duplicates: one username = one QLL row. If it already exists
    // (added manually OR auto-collected from the group), do NOT add again.
    const existing = await findUserByUsername(deps.supabase, username);
    if (existing.exists) {
      await deps.telegram.sendMessage(
        message.chat.id,
        `⚠️ QLL @${username} đã có trong hệ thống (${existing.fullName || "?"}). Không thêm trùng.`
      );
      return true;
    }
    await addUserManual(
      deps.supabase,
      username,
      fullName,
      SPAMTEST_TARGET_CHAT_ID
    );
    await deps.telegram.sendMessage(
      message.chat.id,
      `✅ Đã thêm QLL: @${username} (${fullName}).`
    );
    return true;
  }

  // /finduser <full name...>
  if (lower.startsWith(FIND_USER_COMMAND)) {
    const name = text.slice(FIND_USER_COMMAND.length).trim();
    if (name === "") {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Cú pháp: /finduser Họ Tên"
      );
      return true;
    }
    const { users } = await listKnownUsers(deps.supabase);
    const result = mapQllByUser(name, users);
    if (result.kind === "found") {
      await deps.telegram.sendMessage(
        message.chat.id,
        `🔎 ${name} -> @${result.username}`
      );
    } else if (result.kind === "ambiguous") {
      await deps.telegram.sendMessage(
        message.chat.id,
        `⚠️ Có nhiều username khớp cho: ${name}`
      );
    } else {
      await deps.telegram.sendMessage(
        message.chat.id,
        `❌ Không tìm thấy username cho: ${name}`
      );
    }
    return true;
  }

  // /listusers
  if (lower.startsWith(LIST_USERS_COMMAND)) {
    const { usernames } = await listUsernames(deps.supabase);
    const total = usernames.length;
    const preview = usernames.slice(0, LIST_USERS_PREVIEW_CAP);
    const tagged = preview.map((u) => `@${u}`).join(", ");
    const suffix = total > LIST_USERS_PREVIEW_CAP ? ", …" : "";
    await deps.telegram.sendMessage(
      message.chat.id,
      `📋 Đang có ${total} QLL: ${tagged}${suffix}`
    );
    return true;
  }

  return false;
}

async function maybeHandleBatch(
  message: TelegramMessage,
  deps: Deps
): Promise<boolean> {
  if (!isAdminPrivate(message)) {
    return false;
  }
  const adminId = message.from!.id;
  const text = message.text?.trim() ?? "";

  // Manual QLL-management commands come FIRST so they can never be mis-eaten by
  // the document / /ok / /huy branches. None of them share a prefix with /ok,
  // /huy, or /spam, so ordering them first is safe.
  if (await maybeHandleQllCommands(message, deps, text)) {
    return true;
  }

  // Case 1: a document upload (unless the caption is exactly /ok, which we let
  // the /ok text path own — in practice /ok arrives as text, not a caption).
  if (message.document && message.caption?.trim() !== BATCH_OK_COMMAND) {
    const download = await deps.telegram.downloadFile(message.document.file_id);
    if (!download.ok) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không tải được file. Thử gửi lại nhé."
      );
      return true;
    }

    let rows;
    try {
      rows = parseSheet(download.buffer);
    } catch {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không đọc được file Excel. Kiểm tra lại định dạng .xlsx."
      );
      return true;
    }

    const { users: knownUsers } = await listKnownUsers(deps.supabase);

    // The file caption (if any) becomes the custom closing line for this batch.
    // An empty caption means "use the default closing line".
    const cauNhan = message.caption?.trim() ?? "";

    const items: MappedItem[] = [];
    const mappedSummary: { tenHS: string; username: string }[] = [];
    const unmapped: string[] = [];

    for (const row of rows) {
      const match = mapQllByUser(row.qll, knownUsers);
      if (match.kind === "found") {
        items.push({
          tenHS: row.tenHS,
          maLop: row.maLop,
          ngayHoc: row.ngayHoc,
          lichHoc: row.lichHoc,
          username: match.username,
          cauNhan: cauNhan === "" ? undefined : cauNhan,
        });
        mappedSummary.push({ tenHS: row.tenHS, username: match.username });
      } else {
        unmapped.push(row.qll);
      }
    }

    await savePendingBatch(deps.supabase, adminId, items);
    await deps.telegram.sendMessage(
      message.chat.id,
      buildSummary(rows.length, mappedSummary, unmapped)
    );
    return true;
  }

  // Case 2: /ok [HH:MM | dd/mm HH:MM] -> enqueue the pending batch for slow
  // drip-sending by the cron. A bare /ok sends immediately (send_after=null); a
  // time/date-time schedules the batch (send_after=ISO on every row). Matched
  // by prefix so the optional time argument is recognised; /huy never starts
  // with /ok so it is unaffected.
  if (text.toLowerCase().startsWith(BATCH_OK_COMMAND)) {
    const parsed = parseOkCommand(text);
    if (parsed.kind === "invalid") {
      await deps.telegram.sendMessage(message.chat.id, parsed.reason);
      return true;
    }

    const pending = await loadPendingBatch(deps.supabase, adminId);
    const items = pending.items ?? [];
    if (!pending.ok || items.length === 0) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không có danh sách nào đang chờ."
      );
      return true;
    }

    const sendAfter = parsed.kind === "at" ? parsed.sendAfterIso : null;

    // Group all students sharing a QLL into ONE announcement per QLL so each
    // QLL is tagged exactly once. Store the fully-formatted text (incl. the
    // @username tag) so the cron sends message_text verbatim. send_after is
    // null for immediate sends and the scheduled ISO for a hẹn-giờ batch.
    const groups = groupByUsername(items);
    const rows = Array.from(groups.entries()).map(([username, students]) => ({
      admin_id: adminId,
      chat_id: SPAMTEST_TARGET_CHAT_ID,
      message_text: buildGroupedAnnouncement(
        username,
        students,
        students[0]?.cauNhan
      ),
      send_after: sendAfter,
    }));
    await enqueueMessages(deps.supabase, rows);
    await deletePendingBatch(deps.supabase, adminId);

    const groupCount = groups.size;
    const confirmation =
      parsed.kind === "at"
        ? `✅ Đã lên lịch gửi ${groupCount} tin cho ${groupCount} QLL lúc ${formatVnDateTime(
            parsed.sendAfterIso
          )} (giờ VN). Bot sẽ tự gửi khi tới giờ.`
        : `✅ Đã xếp ${groupCount} tin cho ${groupCount} QLL vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong.`;
    await deps.telegram.sendMessage(message.chat.id, confirmation);
    return true;
  }

  // Case 3: /huy -> drop the pending batch.
  if (text === BATCH_CANCEL_COMMAND) {
    await deletePendingBatch(deps.supabase, adminId);
    await deps.telegram.sendMessage(
      message.chat.id,
      "Đã huỷ danh sách đang chờ."
    );
    return true;
  }

  // Anything else from the admin private chat (e.g. /start) is not ours.
  return false;
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
