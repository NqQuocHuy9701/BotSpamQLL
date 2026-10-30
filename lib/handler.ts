// Core orchestration: classify a Telegram update and run the relay flow.
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.js";

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
  deleteUnsent,
  enqueueMessages,
  insertLog,
  listKnownUsers,
  listUsernames,
  loadPendingBatch,
  savePendingBatch,
  upsertUser,
  insertQllCase,
  markCaseHandled,
} from "./supabase.js";
import {
  handleGroupQllMessage,
  maybeHandleCoordinatorCommands,
  updateConfig,
  loadMonitorConfig, // <-- CHỈ THÊM ĐÚNG 1 CHỮ NÀY VÀO ĐÂY
} from "./monitor.js";


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
  6410818714, // Thêm Admin mới vào đây LinhPT9
];



// The single target group the announcement is posted into (Kiểu 1: pinned).
const SPAMTEST_TARGET_CHAT_ID = -1002273179613; // [BU VUIHOC VH] VH - QLL Support

// --- TÍNH NĂNG FW VẮNG: ID Nhóm gốc hỗ trợ kĩ thuật ---
//const SOURCE_ABSENT_GROUP_ID = -1002458492731; // Nhóm Gốc Hỗ Trợ Kỹ Thuật

// Batch-announcement commands (admin private DM only). On /ok the confirmed
// batch is enqueued into send_queue and drip-sent later by the Vercel cron
// (see api/cron.ts) rather than posted synchronously here.
const BATCH_OK_COMMAND = "/ok";
const BATCH_CANCEL_COMMAND = "/huy";
// Stops a scheduled or in-progress send by clearing all not-yet-sent rows.
const BATCH_STOP_COMMAND = "/cancel";

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
// 0. Bắt sự kiện người dùng thả icon (Reaction) trong nhóm QLL -> Cập nhật handled = true
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const targetMessageId = reaction.message_id;

    if (targetMessageId) {
      await deps.supabase
        .from("qll_tracking")
        .update({ handled: true })
        .eq("message_id", targetMessageId);

      console.log(`✅ Đã thả reaction, set handled = true cho message_id: ${targetMessageId}`);
    }
    return;
  }

  const message = update.message;
  if (!message) {
    return;
  }
  // ==========================================
  // LUỒNG 1: ƯU TIÊN PRIVATE CHAT (ADMIN NHẮN RIÊNG & GỬI FILE)
  // Đưa lên đây để không bị block bởi điều kiện kiểm tra nhóm ở dưới
  // ==========================================
  if (message.chat.type === "private") {
    if (message.text && message.text.startsWith("/start")) {
      await deps.telegram.sendMessage(message.chat.id, START_ACK);
    }
    // /spamtest admin-only
    if (await maybeHandleSpamTest(message, deps)) {
      return;
    }
    // Batch announcement từ file .xlsx
    if (await maybeHandleBatch(message, deps)) {
      return;
    }
    return; // Thoát luôn, tin nhắn riêng không cần chạy xuống logic nhóm
  }

  // ==========================================
  // LUỒNG 2: XỬ LÝ NHÓM CHUNG & NHÓM QLL (-1002273179613)
  // ==========================================
  
  // 🛑 CHẶN TUYỆT ĐỐI: Nếu không phải nhóm QLL thì chỉ chạy các tính năng phụ rồi thoát
  if (message.chat.id !== SPAMTEST_TARGET_CHAT_ID) {
    await collectUsers(message, deps);
    if (await maybeAckAnnouncementReply(message, deps)) return;
    
    if (!deps.relayEnabled) return;
    const replyTo = message.reply_to_message;
    if (!replyTo) return;
    const sensitiveText = message.text ?? "";
    if (!isSensitive(sensitiveText)) return;
    await relay(message, replyTo, deps);
    
    return;
  }

  // --- TỪ ĐIỂM NÀY TRỞ XUỐNG LÀ DÀNH RIÊNG CHO ĐÚNG NHÓM QLL ---
  const text = message.text ?? "";

  // 1. Xử lý Reply -> Đánh dấu tin nhắn gốc đã được phản hồi
  if (message.reply_to_message) {
    await markCaseHandled(deps.supabase, message.reply_to_message.message_id);
  }

  // 2. Kiểm tra tag đích danh để forward nhóm Xếp lớp (-1002493556435)
  if (/@OP_LinhDK6|@OP_LinhDTT1/i.test(text)) {
    const TARGET_GROUP_ID = -1002493556435; 
    const CURRENT_GROUP_ID = message.chat.id;
    const config = loadConfig();

    fetch(`https://api.telegram.org/bot${config.botToken}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CURRENT_GROUP_ID,
        message_id: message.message_id,
        reaction: [{ type: "emoji", emoji: "❤️" }]
      })
    }).catch(console.error);

    fetch(`https://api.telegram.org/bot${config.botToken}/forwardMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TARGET_GROUP_ID,
        from_chat_id: CURRENT_GROUP_ID,
        message_id: message.message_id
      })
    }).catch(console.error);
  }
  
  // 3. Quét và đẩy vào qll_tracking (Chắc chắn 100% chỉ thuộc nhóm -1002273179613)
// 3. Quét và đẩy vào qll_tracking (Chắc chắn 100% chỉ thuộc nhóm -1002273179613)
  if (isQllCase(text)) {
    // Tải cấu hình chứa danh sách CTV từ database
    const monitorConfig = await loadMonitorConfig(deps.supabase);
    
    const senderUname = (message.from?.username ?? "").trim().toLowerCase();
    const listCtv = (monitorConfig.ctvUsernames || []).map((u: string) => u.replace(/^@/, "").toLowerCase());
    const listSang = (monitorConfig.ctvSang || []).map((u: string) => u.replace(/^@/, "").toLowerCase());
    const listChieu = (monitorConfig.ctvChieu || []).map((u: string) => u.replace(/^@/, "").toLowerCase());
    const listToi = (monitorConfig.ctvToi || []).map((u: string) => u.replace(/^@/, "").toLowerCase());

    const isAllCtvShift = listSang.includes(senderUname) || listChieu.includes(senderUname) || listToi.includes(senderUname);

    const isCtvOrAdmin = 
      (message.from && SPAMTEST_ADMIN_IDS.includes(message.from.id)) || 
      (senderUname !== "" && (listCtv.includes(senderUname) || isAllCtvShift));

    // CHỈ ĐẨY VÀO TRACKING NẾU KHÔNG PHẢI LÀ CTV HOẶC ADMIN
    if (!isCtvOrAdmin) {
      await insertQllCase(deps.supabase, {
        message_id: message.message_id,
        content: text,
        sender_name: message.from?.first_name || message.from?.username || "QLL",
        shift_name: getCurrentShift()
      });
    }
  }

  await handleGroupQllMessage(
    message,
    deps.telegram,
    deps.supabase,
    SPAMTEST_TARGET_CHAT_ID,
    SPAMTEST_ADMIN_IDS
  );

  // 4. Passive user collection chạy trên mọi update nhóm
  await collectUsers(message, deps);

  // 5. Auto-acknowledge khi có người reply thông báo của bot
  if (await maybeAckAnnouncementReply(message, deps)) {
    return;
  }

  // 6. Xử lý Relay cho nhóm QLL
  if (!deps.relayEnabled) {
    return;
  }

  const replyTo = message.reply_to_message;
  if (!replyTo) {
    return;
  }

  const sensitiveText = message.text ?? "";
  if (!isSensitive(sensitiveText)) {
    return;
  }

  await relay(message, replyTo, deps);
}
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

// Marker that identifies one of the bot's HS announcements (grouped or single).
const ANNOUNCEMENT_MARKER = "✅ Thông tin học của con";
// The ack the bot posts when a QLL replies to an announcement.
const ACK_REPLY = "Dạ em ghi nhận chuyển anh/chị bên em kiểm tra nha ạ.";

// If a group message is a REPLY to one of the bot's HS announcements, post a
// short acknowledgement as a reply to the replier. Returns true when handled.
// Independent of the relay switch. We require the replied-to message to be
// authored by a bot AND to contain the announcement marker, so ordinary chat
// and replies to other messages are never answered.
async function maybeAckAnnouncementReply(
  message: TelegramMessage,
  deps: Deps
): Promise<boolean> {
  const chat = message.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return false;
  }
  const repliedTo = message.reply_to_message;
  if (!repliedTo) {
    return false;
  }
  const repliedIsBotAnnouncement =
    repliedTo.from?.is_bot === true &&
    (repliedTo.text ?? "").includes(ANNOUNCEMENT_MARKER);
  if (!repliedIsBotAnnouncement) {
    return false;
  }
  // Don't answer the bot replying to itself.
  if (message.from?.is_bot === true) {
    return true;
  }
  // 1) Public ack to the QLL in the group.
  await deps.telegram.sendMessage(chat.id, ACK_REPLY, message.message_id);

  // 2) Private notice to every admin so they can follow up. Includes who
  // replied, what they said, and a short excerpt of the announcement they
  // replied to (so the admin knows which HS/QLL it concerns).
  const who = message.from ? displayName(message.from) : "QLL";
  const uname = message.from?.username ? ` (@${message.from.username})` : "";
  const said = (message.text ?? "").trim() || "(không có nội dung)";
  const excerptSource = (repliedTo.text ?? "").split("\n").slice(0, 2).join(" ").trim();
  const excerpt =
    excerptSource.length > 160
      ? `${excerptSource.slice(0, 160)}…`
      : excerptSource;
  const notice = [
    "🔔 QLL phản hồi thông báo:",
    `👤 ${who}${uname}`,
    `💬 ${said}`,
    `📋 ${excerpt}`,
  ].join("\n");
  for (const adminId of SPAMTEST_ADMIN_IDS) {
    await deps.telegram.sendMessage(adminId, notice);
  }
  return true;
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
    // One username = one QLL row. If the username already exists (added
    // manually OR auto-collected), UPDATE its registered full name to the new
    // one (so mapping-by-full-name works for the sheet's name); otherwise add a
    // fresh row. Either way there is never a duplicate row for a username.
    const existing = await findUserByUsername(deps.supabase, username);
    await addUserManual(
      deps.supabase,
      username,
      fullName,
      SPAMTEST_TARGET_CHAT_ID
    );
    await deps.telegram.sendMessage(
      message.chat.id,
      existing.exists
        ? `♻️ Đã cập nhật tên QLL: @${username} -> ${fullName}.`
        : `✅ Đã thêm QLL: @${username} (${fullName}).`
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

  // 0. Nhận các lệnh quản lý ca trực (/dp, /đp) và CTV vận hành (/addctv, /delctv)
  if (
    await maybeHandleCoordinatorCommands(
      message,
      deps.telegram,
      deps.supabase,
      text
    )
  ) {
    return true;
  }

  // Bổ sung: Lệnh /tatsla để tạm dừng/tắt chế độ giám sát SLA 5 phút
  if (text.toLowerCase().startsWith('/tatsla')) {
    await updateConfig(deps.supabase, { slaEnabled: false });
    await deps.telegram.sendMessage(message.chat.id, "🔴 Đã TẮT chế độ giám sát SLA 5 phút.");
    return true;
  }

  // Bổ sung: Lệnh /batsla để bật lại chế độ giám sát SLA 5 phút
  if (text.toLowerCase().startsWith('/batsla')) {
    await updateConfig(deps.supabase, { slaEnabled: true });
    await deps.telegram.sendMessage(message.chat.id, "🟢 Đã BẬT lại chế độ giám sát SLA 5 phút.");
    return true;
  }

  // Case 0.5: Import hàng loạt CTV qua file Excel kèm caption /addctv
  if (message.document && message.caption?.trim().toLowerCase().startsWith('/addctv')) {
    const download = await deps.telegram.downloadFile(message.document.file_id);
    if (!download.ok) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không tải được file danh sách CTV. Thử gửi lại nhé."
      );
      return true;
    }

    let rows;
    try {
      rows = parseSheet(download.buffer);
    } catch {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không đọc được file Excel CTV. Kiểm tra lại định dạng .xlsx."
      );
      return true;
    }

    const newCtvUsernames: string[] = [];
    for (const row of rows) {
      const uname = (row.qll || "").replace(/^@/, "").trim().toLowerCase();
      if (uname) {
        newCtvUsernames.push(uname);
      }
    }

    await updateConfig(deps.supabase, { ctvUsernames: newCtvUsernames });

    await deps.telegram.sendMessage(
      message.chat.id,
      `✅ Đã cập nhật thành công ${newCtvUsernames.length} tài khoản CTV vào danh sách miễn trừ SLA!`
    );
    return true;
  }

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
    // One message per (QLL + subject): same QLL + same subject is combined; a
    // QLL with students in two subjects gets one message per subject (a QLL is
    // never tagged for two subjects in one message). The username is taken from
    // the bucket's items, not the composite key.
    const groups = groupByUsername(items);
    const rows = Array.from(groups.values()).map((students) => ({
      admin_id: adminId,
      chat_id: SPAMTEST_TARGET_CHAT_ID,
      message_text: buildGroupedAnnouncement(
        students[0].username,
        students,
        students[0]?.cauNhan
      ),
      send_after: sendAfter,
    }));
    await enqueueMessages(deps.supabase, rows);
    await deletePendingBatch(deps.supabase, adminId);

    const msgCount = groups.size;
    const confirmation =
      parsed.kind === "at"
        ? `✅ Đã lên lịch gửi ${msgCount} tin lúc ${formatVnDateTime(
            parsed.sendAfterIso
          )} (giờ VN). Bot sẽ tự gửi khi tới giờ.`
        : `✅ Đã xếp ${msgCount} tin vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong.`;
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

  // Case 4: /cancel -> stop a scheduled (hẹn giờ) batch AND an in-progress
  // drip by deleting every not-yet-sent row for this admin from send_queue.
  // Already-sent messages are not affected. Also clears any pending draft.
  if (text.toLowerCase() === BATCH_STOP_COMMAND) {
    await deletePendingBatch(deps.supabase, adminId);
    const res = await deleteUnsent(deps.supabase, adminId);
    await deps.telegram.sendMessage(
      message.chat.id,
      res.ok
        ? `🛑 Đã huỷ ${res.count} tin chưa gửi trong hàng đợi (gồm cả tin đã hẹn giờ). Các tin đã gửi không bị ảnh hưởng.`
        : "Không huỷ được hàng đợi, thử lại sau nhé."
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

function getCurrentShift(): string {
  const vnTime = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const hour = vnTime.getUTCHours();
  const minute = vnTime.getUTCMinutes();
  const time = hour + minute / 60;

  if (time >= 8 && time <= 12) return "Sáng";
  if (time >= 13.5 && time <= 17) return "Chiều";
  if (time >= 17.5 && time <= 21.5) return "Tối";
  return "Ngoài ca";
}

function isQllCase(text: string): boolean {
  const hasNumber = /\d{3,}/.test(text); 
  const hasClassCode = /(TOAN|MOET|KHTN|TCLC|TA|TVTTH)/i.test(text); 
  return hasNumber || hasClassCode;
}