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
import { maybeHandleAi, type AiConfig } from "./ai.js";
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
  recordCtvReply,
  recordCtvReaction,
  maybeHandleReportCommand,
  maybeHandleCheckinCommand,
  loadMonitorConfig,
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

// Nhóm HTKT (hỗ trợ kỹ thuật) — nhóm THỨ HAI được theo dõi hiệu suất CTV.
// CHỈ dùng cho: đẩy case hợp lệ vào qll_tracking + ghi React/Reply vào
// shift_interactions. KHÔNG relay / forward / auto-ack (khác nhóm QLL).
const HTKT_GROUP_ID = -1002458492731;

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
// Map lại các dòng CHƯA map của danh sách trước đó (không cần gửi lại file).
const REMAP_COMMAND = "/remap";
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
  // OPTIONAL: client tới project Supabase chứa checkin_logs. undefined khi
  // chưa cấu hình env -> lệnh /checkin báo chưa bật tính năng.
  checkinSupabase?: SupabaseClient;
  // OPTIONAL: Bee AI (Groq). undefined = tắt hoàn toàn (xem lib/ai.ts).
  ai?: AiConfig;
}

export async function handleUpdate(
  update: TelegramUpdate,
  deps: Deps
): Promise<void> {
  // 0. Bắt sự kiện người dùng thả icon (Reaction) trong nhóm QLL -> Xóa khỏi danh sách chờ SLA 5 phút
// ==========================================
    // BƯỚC 0: XỬ LÝ SỰ KIỆN REACTION (THẢ TIM/ICON)
    // 0. Bắt sự kiện người dùng thả icon (Reaction) -> Cập nhật handled = true
    // ==========================================
// 0. Bắt sự kiện người dùng thả icon (Reaction) -> Cập nhật handled = true
  if (update.message_reaction) {
    const reactionUpdate = update.message_reaction;
    const targetMessageId = reactionUpdate.message_id;
    const newReaction = reactionUpdate.new_reaction;

    console.log(`📥 [REACTION LOG] Nhận update reaction - MessageID: ${targetMessageId}`);

    const hasValidReaction = Array.isArray(newReaction) && newReaction.length > 0;

    if (targetMessageId && hasValidReaction) {
      console.log(`🔍 [REACTION FLOW] Đang tìm và update handled=true cho message_id: ${targetMessageId}`);

      // Khóa case: QLL giữ nguyên id; HTKT lưu id âm phái sinh (scopedCaseId).
      // Nếu dùng id thô thì reaction ở HTKT không khớp dòng nào (case vẫn "tồn")
      // và còn có thể trùng nhầm một case QLL cùng số id.
      const reactChatForKey = reactionUpdate.chat?.id;
      const caseKey =
        typeof reactChatForKey === "number"
          ? scopedCaseId(reactChatForKey, targetMessageId)
          : targetMessageId;
      const { data, error } = await deps.supabase
        .from("qll_tracking")
        .update({ handled: true })
        .eq("message_id", caseKey)
        .select();

      if (error) {
        console.error("❌ [SUPABASE ERROR] Lỗi cập nhật handled qua reaction:", error);
      } else {
        console.log(`✅ [SUCCESS] Đã cập nhật handled = TRUE qua REACTION thành công cho message_id: ${targetMessageId}`, data);
      }

      // GHI NHẬN HIỆU SUẤT (React) — HOÀN TOÀN TÁCH BIỆT khỏi luồng SLA ở trên.
      // Bọc try/catch riêng + recordCtvReaction fail-soft: mọi lỗi ở đây KHÔNG
      // được ảnh hưởng tới việc cập nhật handled đã chạy xong. Chỉ áp cho nhóm
      // QLL (nơi có case trong qll_tracking).
      try {
        const reactChatId = reactionUpdate.chat?.id;
        // Ghi React cho CẢ HAI nhóm theo dõi: QLL + HTKT. Dùng scopedCaseId để
        // khớp đúng khóa case (HTKT lưu dưới id âm phái sinh).
        if (
          reactChatId === SPAMTEST_TARGET_CHAT_ID ||
          reactChatId === HTKT_GROUP_ID
        ) {
          await recordCtvReaction(deps.supabase, {
            chatId: reactChatId,
            caseMessageId: scopedCaseId(reactChatId, targetMessageId),
            reactorUsername: reactionUpdate.user?.username,
            checkinClient: deps.checkinSupabase,
          });
        }
      } catch (e) {
        console.error("Lỗi ghi React (bỏ qua, không ảnh hưởng SLA):", e);
      }
    } else {
      console.log(`ℹ️ [REACTION INFO] Hành động gỡ reaction hoặc thiếu thông tin, bỏ qua.`);
    }
    return;
  }

const message = update.message;
  if (!message) {
    return;
  }

  // Ghi chú: trước đây có nhánh đọc form check-in trong nhóm VHHS (topic 4),
  // nhưng form đó do một BOT khác đăng, mà Telegram KHÔNG gửi tin của bot khác
  // cho bot này -> nhánh không bao giờ chạy. Đã thay bằng đọc trực tiếp bảng
  // checkin_logs ở project Supabase khác cho lệnh /checkin.

  // --- MỚI THÊM: Ưu tiên xử lý tin nhắn Private (lệnh Admin) ---
  if (message.chat.type === "private") {
      // 7b. /baocao -> gửi báo cáo hiệu suất ca hiện tại cho admin (chat riêng).
      if (
        await maybeHandleReportCommand(
          message,
          deps.telegram,
          deps.supabase,
          SPAMTEST_ADMIN_IDS,
          deps.checkinSupabase
        )
      ) {
          return;
      }
      // 7c. /checkin -> liệt kê CTV đã check-in thực tế ca hiện tại (đọc từ
      // bảng checkin_logs ở project Supabase khác) cho admin (chat riêng).
      if (
        await maybeHandleCheckinCommand(
          message,
          deps.telegram,
          deps.checkinSupabase,
          SPAMTEST_ADMIN_IDS
        )
      ) {
          return;
      }
      // 8. Batch announcement & Các lệnh Admin (/dp, /addctvca, v.v.)
      if (await maybeHandleBatch(message, deps)) {
          return;
      }
      // 9. Bee AI: admin nhắn riêng bằng câu thường (không phải lệnh /). Chỉ chạy
      // khi AI được bật; các tin trên không khớp lệnh nào mới tới đây.
      if (deps.ai && (await maybeHandleAi(message, deps, SPAMTEST_ADMIN_IDS))) {
          return;
      }
      if (!deps.relayEnabled) return;
      if (message.text && message.text.startsWith("/start")) {
          await deps.telegram.sendMessage(message.chat.id, START_ACK);
      }
      return;
  }

  // Bee AI trong nhóm: CHỈ khi tin tag @bot. Không chặn luồng phía dưới (tin tag
  // vẫn được tracking case như thường); lỗi AI đã được nuốt trong maybeHandleAi.
  if (deps.ai) {
    await maybeHandleAi(message, deps, SPAMTEST_ADMIN_IDS);
  }

  // 🛑 CHẶN TUYỆT ĐỐI: Chỉ cho phép LUỒNG QLL (relay/forward/auto-ack) nếu đúng
  // nhóm QLL (-1002273179613). Nhóm khác return ngay, không lọt vào luồng QLL.
  if (message.chat.id !== SPAMTEST_TARGET_CHAT_ID) {
    // NHÓM HTKT: nhóm thứ hai được theo dõi hiệu suất. CHỈ tracking case hợp lệ
    // + ghi Reply vào shift_interactions. TUYỆT ĐỐI KHÔNG relay/forward/auto-ack.
    if (message.chat.id === HTKT_GROUP_ID) {
      // 1) Reply của CTV lên case hợp lệ -> ghi nhận hiệu suất (gộp chung /baocao).
      //    Dùng scopedCaseId để khớp đúng khóa case HTKT trong qll_tracking.
      if (message.reply_to_message) {
        const htktCaseId = scopedCaseId(
          message.chat.id,
          message.reply_to_message.message_id
        );
        await markCaseHandled(deps.supabase, htktCaseId);
        await recordCtvReply(deps.supabase, {
          chatId: message.chat.id,
          caseMessageId: htktCaseId,
          replierUsername: message.from?.username,
          checkinClient: deps.checkinSupabase,
        });
      }
      // 2) Quét & đẩy case vào qll_tracking: CHỈ khi tin là FORWARD + khớp rule.
      //    KHÔNG áp chặn non-CTV ở đây (người forward chính là CTV VHHS). Việc
      //    "chỉ tính CTV VHHS" nằm ở bước đếm React/Reply (lọc theo check-in).
      await trackHtktCase(message, deps);
      // 3) Gom user thụ động (như mọi nhóm).
      await collectUsers(message, deps);
      return;
    }
    // Nhóm khác: chỉ gom user rồi thoát.
    await collectUsers(message, deps);
    return;
  }

  // --- TỪ ĐIỂM NÀY TRỞ XUỐNG LÀ DÀNH RIÊNG CHO ĐÚNG NHÓM QLL ---
  const text = message.text ?? "";

  // 1. Xử lý Reply -> Đánh dấu tin nhắn gốc đã được phản hồi
  if (message.reply_to_message) {
    await markCaseHandled(deps.supabase, message.reply_to_message.message_id);
    // 1b. Ghi nhận hiệu suất: nếu người reply là CTV của ca hiện tại và tin
    // gốc là case hợp lệ, tính cho CTV đó (ghi đè theo case -> CTV reply cuối).
    await recordCtvReply(deps.supabase, {
      chatId: message.chat.id,
      caseMessageId: scopedCaseId(message.chat.id, message.reply_to_message.message_id),
      replierUsername: message.from?.username,
      checkinClient: deps.checkinSupabase,
    });
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
  
  // 3. Quét & đẩy case QLL vào qll_tracking + theo dõi SLA 5 phút.
  //    DÙNG LOGIC CŨ handleGroupQllMessage (insert message_id THẬT, reply SLA
  //    đúng tin). KHÔNG dùng trackQllCase cho QLL — nó ghi trùng/lệch message_id
  //    khiến SLA reply hỏng (chỉ HTKT mới dùng trackHtktCase).
  await handleGroupQllMessage(
    message,
    deps.telegram,
    deps.supabase,
    SPAMTEST_TARGET_CHAT_ID,
    SPAMTEST_ADMIN_IDS
  );

  // 5. Passive user collection chạy trên mọi update nhóm
  await collectUsers(message, deps);

  // 6. Auto-acknowledge khi có người reply thông báo của bot
  if (await maybeAckAnnouncementReply(message, deps)) {
    return;
  }

  // 7. /spamtest admin-only
  if (await maybeHandleSpamTest(message, deps)) {
    return;
  }

  // 8. Batch announcement từ file .xlsx
  if (await maybeHandleBatch(message, deps)) {
    return;
  }

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

  // /remap -> map LẠI các dòng CHƯA map của danh sách TRƯỚC ĐÓ (đã lưu trong
  // pending_batches), dùng danh sách QLL mới nhất. KHÔNG cần gửi lại file.
  if (lower === REMAP_COMMAND || lower.startsWith(REMAP_COMMAND + " ")) {
    const adminId = message.from!.id;
    const pending = await loadPendingBatch(deps.supabase, adminId);
    const allItems = pending.items ?? [];
    if (!pending.ok || allItems.length === 0) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không có danh sách nào đang chờ để map lại. Gửi file trước nhé."
      );
      return true;
    }
    const pendingRows = allItems.filter((it) => it.pending);
    if (pendingRows.length === 0) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "✅ Danh sách hiện tại đã map hết, không còn dòng nào cần map lại. Gõ /ok để gửi."
      );
      return true;
    }

    const { users: knownUsers } = await listKnownUsers(deps.supabase);
    const mappedSummary: { tenHS: string; username: string }[] = [];
    const stillUnmapped: string[] = [];
    const updated: MappedItem[] = allItems.map((it) => {
      if (!it.pending) return it; // dòng đã map giữ nguyên
      const match = mapQllByUser(it.qll ?? "", knownUsers);
      if (match.kind === "found") {
        mappedSummary.push({ tenHS: it.tenHS, username: match.username });
        return { ...it, username: match.username, pending: false };
      }
      stillUnmapped.push(it.qll ?? "");
      return it; // vẫn pending
    });

    await savePendingBatch(deps.supabase, adminId, updated);
    const mappedCount = allItems.filter((it) => !it.pending).length + mappedSummary.length;
    await deps.telegram.sendMessage(
      message.chat.id,
      buildSummary(allItems.length, mappedSummary, stillUnmapped) +
        `\n\n(Map lại: +${mappedSummary.length} dòng. Tổng đã map: ${mappedCount}/${allItems.length}.)`
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
      const base = {
        tenHS: row.tenHS,
        maLop: row.maLop,
        ngayHoc: row.ngayHoc,
        lichHoc: row.lichHoc,
        cauNhan: cauNhan === "" ? undefined : cauNhan,
        qll: row.qll, // lưu tên QLL gốc để /remap dùng lại
      };
      if (match.kind === "found") {
        items.push({ ...base, username: match.username });
        mappedSummary.push({ tenHS: row.tenHS, username: match.username });
      } else {
        // Dòng CHƯA map: vẫn LƯU (pending) để /remap thử lại sau khi /adduser,
        // không cần gửi lại file.
        items.push({ ...base, username: "", pending: true });
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
    const allItems = pending.items ?? [];
    if (!pending.ok || allItems.length === 0) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Không có danh sách nào đang chờ."
      );
      return true;
    }

    // Chỉ gửi dòng ĐÃ map. Dòng còn pending (chưa map) -> bỏ qua, báo rõ.
    const items = allItems.filter((it) => !it.pending && it.username);
    const stillPending = allItems.filter((it) => it.pending);
    if (items.length === 0) {
      await deps.telegram.sendMessage(
        message.chat.id,
        `⚠️ Chưa có dòng nào map được (còn ${stillPending.length} dòng chưa map). Dùng /adduser rồi /remap trước khi /ok.`
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
    // Xóa phần đã gửi; GIỮ lại các dòng chưa map để còn /remap sau. Hết pending
    // thì xóa hẳn batch.
    if (stillPending.length > 0) {
      await savePendingBatch(deps.supabase, adminId, stillPending);
    } else {
      await deletePendingBatch(deps.supabase, adminId);
    }

    const msgCount = groups.size;
    let confirmation =
      parsed.kind === "at"
        ? `✅ Đã lên lịch gửi ${msgCount} tin lúc ${formatVnDateTime(
            parsed.sendAfterIso
          )} (giờ VN). Bot sẽ tự gửi khi tới giờ.`
        : `✅ Đã xếp ${msgCount} tin vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong.`;
    if (stillPending.length > 0) {
      const names = Array.from(new Set(stillPending.map((it) => it.qll ?? "").filter(Boolean)));
      confirmation += `\n\n⚠️ Bỏ qua ${stillPending.length} dòng CHƯA map (${names.join(", ")}). Nếu cần gửi: /adduser rồi /remap, sau đó /ok lại cho phần này.`;
    }
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

// Tin có PHẢI forward không. Hỗ trợ cả field mới (forward_origin, Bot API>=7.0)
// lẫn field cũ (forward_date / forward_from / forward_from_chat / sender_name).
export function isForwarded(message: TelegramMessage): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_date !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined
  );
}

// qll_tracking dùng khóa message_id ĐƠN (không có chat_id). Telegram đánh
// message_id RIÊNG theo từng nhóm -> HTKT có thể trùng id với QLL. Để tách
// không gian khóa mà KHÔNG đổi schema: nhóm QLL giữ NGUYÊN message_id (dương),
// nhóm HTKT ghi dưới dạng ÂM phái sinh = -(messageId*10 + 1). QLL luôn dương,
// HTKT luôn âm -> không bao giờ va chạm. Xác định + đảo ngược được. Hàm phụ
// recordCtvReply/recordCtvReaction cũng quy cùng công thức này khi tra case.
export function scopedCaseId(chatId: number, messageId: number): number {
  if (chatId === SPAMTEST_TARGET_CHAT_ID) return messageId; // QLL: giữ nguyên
  if (chatId === HTKT_GROUP_ID) return -(messageId * 10 + 1); // HTKT: âm phái sinh
  return messageId; // nhóm khác (không dùng tới) — giữ nguyên
}

// (Đã gỡ trackQllCase: nhóm QLL dùng handleGroupQllMessage như logic cũ để
//  insert message_id THẬT + SLA reply đúng tin. Chỉ HTKT dùng trackHtktCase.)

// Tracking case riêng cho NHÓM HTKT. Case ở HTKT có thể là tin FORWARD (đa số,
// CTV forward lại từ bot "Trợ Lý Lớp Học") HOẶC tin người thật gõ tay. Vì vậy:
//  - Tạo case khi khớp rule (isQllCase) — KHÔNG bắt buộc forward.
//  - KHÔNG chặn theo người gửi (người đăng/forward thường là CTV VHHS). Việc
//    chỉ-tính-CTV VHHS được áp ở bước đếm React/Reply (lọc theo check-in VHHS).
//  - Khóa case dùng scopedCaseId (HTKT -> id âm, không đụng QLL).
export async function trackHtktCase(message: TelegramMessage, deps: Deps): Promise<void> {
  const text = message.text ?? message.caption ?? "";
  if (!isQllCase(text)) return;

  // Loại tin của CTV giống nhóm QLL (username nằm trong danh sách CTV vận hành
  // hoặc CTV trực ca). NGOẠI LỆ: tin FORWARD vẫn giữ, vì case HTKT chủ yếu là
  // CTV forward lại từ bot "Trợ Lý Lớp Học".
  if (!isForwarded(message)) {
    const sender = (message.from?.username ?? "").replace(/^@/, "").trim().toLowerCase();
    if (sender !== "") {
      try {
        const cfg = await loadMonitorConfig(deps.supabase);
        const norm = (l: string[] | undefined) =>
          (l ?? []).map((u) => u.replace(/^@/, "").trim().toLowerCase());
        const ctvs = new Set([
          ...norm(cfg.ctvUsernames),
          ...norm(cfg.ctvSang),
          ...norm(cfg.ctvChieu),
          ...norm(cfg.ctvToi),
        ]);
        if (ctvs.has(sender)) return;
      } catch {
        // lỗi đọc config -> không chặn (giữ hành vi cũ)
      }
    }
  }

  await insertQllCase(deps.supabase, {
    message_id: scopedCaseId(message.chat.id, message.message_id),
    content: text,
    sender_name: message.from?.first_name || message.from?.username || "HTKT",
    shift_name: getCurrentShift(),
  });
  console.log(
    `✅ [HTKT TRACKING] Đã lưu case (msg ${message.message_id}, fw=${isForwarded(message)}).`
  );
}