import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleUpdate, type Deps } from "../lib/handler.js";
import * as XLSX from "xlsx";
import type {
  SendResult,
  DeleteResult,
  DownloadResult,
  TelegramClient,
} from "../lib/telegram.js";
import type { MappedItem, TelegramUpdate } from "../lib/types.js";
import { buildGroupedAnnouncement } from "../lib/batch.js";

const WARNING =
  "⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox.";

// Records an ordered trace of every mock interaction so we can assert ordering.
function makeDeps(options: {
  sendResults?: SendResult[];
  sendThrows?: Error[]; // index-aligned; if set, that send call throws
  // index-aligned; if true, that send returns a promise that never settles
  // (used with fake timers to drive the real 10s withTimeout boundary)
  sendPending?: boolean[];
  deleteResults?: DeleteResult[];
  relayEnabled?: boolean;
  // Batch feature: control downloadFile and the pending_batches / username
  // queries used by maybeHandleBatch.
  downloadResult?: DownloadResult;
  pendingItems?: MappedItem[] | null;
  knownUsernames?: string[];
  // When set, a username lookup (findUserByUsername / dedup) returns this as an
  // already-existing QLL row, so /adduser reports "đã có".
  existingUser?: { username: string; fullName: string };
}): {
  deps: Deps;
  trace: string[];
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  pendingUpsert: ReturnType<typeof vi.fn>;
  pendingDeleteEq: ReturnType<typeof vi.fn>;
  sendQueueInsert: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
} {
  const trace: string[] = [];
  let sendIdx = 0;
  let deleteIdx = 0;

  const sendResults = options.sendResults ?? [];
  const sendThrows = options.sendThrows ?? [];
  const sendPending = options.sendPending ?? [];
  const deleteResults = options.deleteResults ?? [];

  const sendMessage = vi.fn((chatId: number, _text: string) => {
    const i = sendIdx++;
    trace.push(`send:${chatId}`);
    if (sendPending[i]) {
      // A promise that never settles; the handler's withTimeout must fire.
      return new Promise<SendResult>(() => {});
    }
    if (sendThrows[i]) {
      return Promise.reject(sendThrows[i]);
    }
    return Promise.resolve(
      sendResults[i] ?? ({ ok: true, messageId: 1 } as SendResult)
    );
  });

  const deleteMessage = vi.fn(async (chatId: number, messageId: number) => {
    const i = deleteIdx++;
    trace.push(`delete:${chatId}:${messageId}`);
    return deleteResults[i] ?? ({ ok: true } as DeleteResult);
  });

  const downloadFile = vi.fn(async (_fileId: string) => {
    trace.push("download");
    return (
      options.downloadResult ??
      ({ ok: false, description: "no download set" } as DownloadResult)
    );
  });

  const telegram: TelegramClient = { sendMessage, deleteMessage, downloadFile };

  // Records each inserted log row in the trace.
  const insert = vi.fn(async (record: { status: string }) => {
    trace.push(`log:${record.status}`);
    return { error: null };
  });
  // User upserts (passive collection) are asserted via the `upsert` spy, not
  // via the ordered `trace`, so relay-ordering assertions stay focused.
  const upsert = vi.fn(async (_record: { telegram_id: number }) => {
    return { error: null };
  });

  // pending_batches query-builder stubs.
  const pendingUpsert = vi.fn(async () => {
    trace.push("savePending");
    return { error: null };
  });
  const pendingDeleteEq = vi.fn(async () => {
    trace.push("deletePending");
    return { error: null };
  });
  const pendingSelectMaybeSingle = vi.fn(async () => ({
    data:
      options.pendingItems === undefined || options.pendingItems === null
        ? null
        : { items: options.pendingItems },
    error: null,
  }));

  // telegram_users_qll .select(...) is used two ways:
  //  - listUsernames: `await select("username")` -> the injected known list.
  //  - findUserByUsername / upsertUser dedup: `select(...).ilike(...).limit(...)`
  //    -> rows matching an existing username (empty unless options.existingUser
  //    is set, so by default a /adduser is treated as NEW).
  const existingRows =
    options.existingUser === undefined
      ? []
      : [{ username: options.existingUser.username, full_name: options.existingUser.fullName, telegram_id: 1 }];
  const usernameSelect = vi.fn(() => {
    const listResult = {
      data: (options.knownUsernames ?? []).map((username) => ({ username })),
      error: null,
    };
    // Thenable so `await select("username")` resolves to the known list.
    const chain = {
      ilike: () => ({ limit: async () => ({ data: existingRows, error: null }) }),
      then: (resolve: (v: typeof listResult) => unknown) => resolve(listResult),
    };
    return chain;
  });
  // upsertUser's UPDATE-when-exists path: .update(...).ilike(...)
  const userUpdate = vi.fn(() => ({ ilike: async () => ({ error: null }) }));

  // send_queue: /ok uses .insert(rows); the other chainable methods are stubbed
  // so the queue helpers never throw even though /ok only exercises insert.
  const sendQueueInsert = vi.fn(async () => {
    trace.push("enqueue");
    return { error: null };
  });

  // Route .from(table) to the right query-builder stub by table name.
  const from = vi.fn((table: string) => {
    if (table === "telegram_users_qll") {
      // Passive collection + manual add use .upsert/.update; batch mapping and
      // dedup use .select (chainable with .ilike().limit()).
      return { upsert, select: usernameSelect, update: userUpdate };
    }
    if (table === "pending_batches") {
      return {
        upsert: pendingUpsert,
        select: () => ({
          eq: () => ({ maybeSingle: pendingSelectMaybeSingle }),
        }),
        delete: () => ({ eq: pendingDeleteEq }),
      };
    }
    if (table === "send_queue") {
      return {
        insert: sendQueueInsert,
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    return { insert };
  });
  const supabase = {
    from,
  } as unknown as SupabaseClient;

  return {
    deps: {
      telegram,
      supabase,
      relayEnabled: options.relayEnabled ?? true,
    },
    trace,
    sendMessage,
    deleteMessage,
    downloadFile,
    insert,
    upsert,
    pendingUpsert,
    pendingDeleteEq,
    sendQueueInsert,
    from,
  };
}

const GROUP_ID = -1001;
const REPLY_MSG_ID = 500;
const QLL_ID = 111;

function sensitiveReply(text = "TK: user / MK: pass"): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: REPLY_MSG_ID,
      date: 1_700_000_100,
      chat: { id: GROUP_ID, type: "supergroup" },
      from: { id: 222, first_name: "Minh", last_name: "CTV" },
      text,
      reply_to_message: {
        message_id: 400,
        date: 1_700_000_000,
        chat: { id: GROUP_ID, type: "supergroup" },
        from: { id: QLL_ID, first_name: "Boss", last_name: "QLL" },
        text: "Cho mình xin tài khoản",
      },
    },
  };
}

describe("handleUpdate — happy path", () => {
  it("sends to inbox first, deletes, logs 'Đã gửi Inbox', then posts confirmation", async () => {
    const { deps, trace, sendMessage, deleteMessage } = makeDeps({
      sendResults: [{ ok: true, messageId: 9 }],
      deleteResults: [{ ok: true }],
    });

    await handleUpdate(sensitiveReply(), deps);

    // Order: inbox send -> delete -> log -> confirmation send.
    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Đã gửi Inbox",
      `send:${GROUP_ID}`,
    ]);

    // Inbox send carries the QLL's own request followed by the credential text.
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      QLL_ID,
      "📩 Yêu cầu của bạn: Cho mình xin tài khoản\n\nTK: user / MK: pass"
    );
    // Friendly confirmation line, posted as a REPLY to the QLL's original
    // request message (message_id 400).
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      GROUP_ID,
      "🔒 Em đã gửi tin nhắn cho mình rồi ạ. Anh/chị kiểm tra tin nhắn nha ạ",
      400
    );
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("sends only the credential text when the QLL request has no text", async () => {
    const { deps, sendMessage } = makeDeps({
      sendResults: [{ ok: true, messageId: 9 }],
      deleteResults: [{ ok: true }],
    });

    // A sensitive reply whose replied-to QLL request carries no text.
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: REPLY_MSG_ID,
        date: 1_700_000_100,
        chat: { id: GROUP_ID, type: "supergroup" },
        from: { id: 222, first_name: "Minh", last_name: "CTV" },
        text: "TK: user / MK: pass",
        reply_to_message: {
          message_id: 400,
          date: 1_700_000_000,
          chat: { id: GROUP_ID, type: "supergroup" },
          from: { id: QLL_ID, first_name: "Boss", last_name: "QLL" },
          // no text
        },
      },
    };

    await handleUpdate(update, deps);

    // No empty "📩 Yêu cầu của bạn:" header line when there is no request text.
    expect(sendMessage).toHaveBeenNthCalledWith(1, QLL_ID, "TK: user / MK: pass");
  });
});

describe("handleUpdate — 403 security path", () => {
  it("deletes BEFORE warning, logs 'Lỗi chưa start bot', posts the warning", async () => {
    const { deps, trace, sendMessage } = makeDeps({
      sendResults: [{ ok: false, forbidden: true, description: "Forbidden" }],
      deleteResults: [{ ok: true }],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Lỗi chưa start bot",
      `send:${GROUP_ID}`,
    ]);
    expect(sendMessage).toHaveBeenNthCalledWith(2, GROUP_ID, WARNING, 400);
  });
});

describe("handleUpdate — real 10s timeout behaves like 403", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives the actual 10,000ms timeout, then deletes -> logs -> warns in order", async () => {
    vi.useFakeTimers();
    const { deps, trace, sendMessage } = makeDeps({
      sendPending: [true], // inbox send never settles -> withTimeout fires at 10s
      deleteResults: [{ ok: true }],
    });

    const done = handleUpdate(sensitiveReply(), deps);
    // Nothing destructive should happen before the 10s boundary.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(trace).toEqual([`send:${QLL_ID}`]);

    // Cross the 10,000ms budget; the timeout now drives the security path.
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Lỗi chưa start bot",
      `send:${GROUP_ID}`,
    ]);
    expect(sendMessage).toHaveBeenNthCalledWith(2, GROUP_ID, WARNING, 400);
  });
});

describe("handleUpdate — non-403 delivery failure", () => {
  it("retains the reply (no delete) and logs a delivery-failure status", async () => {
    const { deps, trace, deleteMessage } = makeDeps({
      sendResults: [{ ok: false, forbidden: false, description: "Bad Request" }],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(trace).toEqual([`send:${QLL_ID}`, "log:Lỗi gửi Inbox"]);
  });

  it("retains the reply when the inbox send rejects with a transport error (not a timeout)", async () => {
    const { deps, trace, deleteMessage } = makeDeps({
      // A bare network rejection (DNS/socket/JSON) is NOT a 10s timeout and
      // must NOT take the destructive delete-first path (Requirement 2.3).
      sendThrows: [new Error("getaddrinfo ENOTFOUND")],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(trace).toEqual([`send:${QLL_ID}`, "log:Lỗi gửi Inbox"]);
  });
});

describe("handleUpdate — delete-retry exhaustion on success path", () => {
  it("logs a deletion-failure status after 3 failed deletes", async () => {
    const { deps, trace, deleteMessage } = makeDeps({
      sendResults: [{ ok: true, messageId: 9 }],
      deleteResults: [
        { ok: false, description: "x" },
        { ok: false, description: "x" },
        { ok: false, description: "x" },
      ],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Lỗi thu hồi",
    ]);
    // No confirmation posted when the reply could not be removed.
  });
});

describe("handleUpdate — delete-retry exhaustion on 403 security path", () => {
  it("tries delete 3 times, logs 'Lỗi thu hồi', and posts NO warning", async () => {
    const { deps, trace, sendMessage, deleteMessage } = makeDeps({
      sendResults: [{ ok: false, forbidden: true, description: "Forbidden" }],
      deleteResults: [
        { ok: false, description: "x" },
        { ok: false, description: "x" },
        { ok: false, description: "x" },
      ],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Lỗi thu hồi",
    ]);
    // The warning stays pending until the reply is confirmed deleted:
    // only the inbox send happened, no group warning was posted.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("handleUpdate — removal timing contract (send-before-delete)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The Req 2.2 (delete only AFTER confirmed inbox delivery) vs. Req 10.1
  // (issue delete within 500ms of webhook receipt) conflict is resolved in the
  // AUTHORITATIVE spec: design.md "Critical action ordering" > "Timing
  // precedence" and the amended requirements.md Req 10.1 both make
  // confirmed-delivery-before-delete take precedence on the success path, so
  // credentials are never removed from the group before they reach the QLL.
  // The receipt-relative 500ms is, on the success path, a best-effort target
  // bounded by Telegram's own sendMessage latency — NOT a hard guarantee the
  // handler can meet when the upstream send is slow.
  //
  // This test proves the contract the resolved spec actually guarantees on the
  // success path: once delivery confirms, the delete is issued PROMPTLY (same
  // invocation, no extra wait), i.e. not blocked behind the 10s timeout budget.
  // It intentionally does NOT claim a 500ms-from-receipt SLA on the success
  // path, because that is bounded by Telegram, not by the handler.
  it("issues the group delete promptly after delivery confirms (no extra wait past the send)", async () => {
    vi.useFakeTimers();

    // The inbox send stays in flight; the delete must follow right after
    // confirmed delivery within the same invocation.
    let resolveSend: ((r: SendResult) => void) | undefined;
    const trace: string[] = [];
    const times: Record<string, number> = {};

    const sendMessage = vi.fn((chatId: number, _text: string) => {
      trace.push(`send:${chatId}`);
      if (!resolveSend) {
        return new Promise<SendResult>((resolve) => {
          resolveSend = resolve;
        });
      }
      return Promise.resolve({ ok: true, messageId: 2 } as SendResult);
    });
    const deleteMessage = vi.fn(async (chatId: number, messageId: number) => {
      trace.push(`delete:${chatId}:${messageId}`);
      times.delete = Date.now();
      return { ok: true } as DeleteResult;
    });
    const insert = vi.fn(async (record: { status: string }) => {
      trace.push(`log:${record.status}`);
      return { error: null };
    });
    const upsert = vi.fn(async () => ({ error: null }));
    const downloadFile = vi.fn();
    const deps: Deps = {
      telegram: { sendMessage, deleteMessage, downloadFile },
      supabase: {
        from: vi.fn((table: string) =>
          table === "telegram_users_qll" ? { upsert } : { insert }
        ),
      } as unknown as SupabaseClient,
      relayEnabled: true,
    };

    const done = handleUpdate(sensitiveReply(), deps);

    // The upstream send is slow (900ms, i.e. already past any 500ms window);
    // no delete may happen yet because delivery is not confirmed.
    await vi.advanceTimersByTimeAsync(900);
    expect(trace).toEqual([`send:${QLL_ID}`]);
    expect(deleteMessage).not.toHaveBeenCalled();

    // Delivery confirms. From this instant, the delete must be issued without
    // advancing the clock at all (prompt, same invocation).
    const confirmAt = Date.now();
    resolveSend?.({ ok: true, messageId: 2 });
    await vi.advanceTimersByTimeAsync(0); // drain microtasks only, 0ms elapsed
    await done;

    expect(trace[0]).toBe(`send:${QLL_ID}`);
    expect(trace[1]).toBe(`delete:${GROUP_ID}:${REPLY_MSG_ID}`);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    // Elapsed time from delivery confirmation to the delete call is zero —
    // the delete is NOT blocked behind the remaining 10s timeout budget.
    expect(times.delete! - confirmAt).toBe(0);
  });
});

describe("handleUpdate — ignore branches", () => {
  it("ignores a group message that is not a reply (no relay side effects)", async () => {
    const { deps, sendMessage, deleteMessage, insert, upsert } = makeDeps({});
    await handleUpdate(
      {
        update_id: 2,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: GROUP_ID, type: "supergroup" },
          from: { id: 1, first_name: "X" },
          text: "TK: 12345678",
        },
      },
      deps
    );
    // No relay actions on a non-reply message...
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // ...but the sender is still collected into telegram_users_qll.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("ignores a group reply that is not sensitive (no relay side effects)", async () => {
    const { deps, sendMessage, deleteMessage, insert, upsert } = makeDeps({});
    const update = sensitiveReply("Chào bạn nhé");
    await handleUpdate(update, deps);
    // No relay actions on a non-sensitive reply...
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // ...but the replier is still collected.
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("handleUpdate — private /start", () => {
  it("acknowledges the inbox and does nothing else", async () => {
    const { deps, sendMessage, deleteMessage, insert, from } = makeDeps({});
    await handleUpdate(
      {
        update_id: 3,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: QLL_ID, type: "private" },
          from: { id: QLL_ID, first_name: "Boss" },
          text: "/start",
        },
      },
      deps
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(QLL_ID);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — /spam (operator DM -> post to fixed group)", () => {
  const ADMIN_ID = 6532155675;
  const TARGET_GROUP = -1002273179613;
  const EXPECTED_MESSAGE = [
    "✅ Thông tin học của con",
    "Học sinh: Nguyễn Đức Minh",
    "Lịch học: T5 (20:30-21:30)",
    "Thời lượng buổi học : 60 phút",
    "Ngày tham gia lớp học: 15-10-2026",
    "Mã lớp học: TCLC.2025.0207 Khối lớp: 3",
    "",
    "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_AnhMTK",
  ].join("\n");

  // A private-chat /spam from the given user (chat.id == user id for DMs).
  function spamDm(fromId: number, text = "/spam"): TelegramUpdate {
    return {
      update_id: 50,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: fromId, type: "private" },
        from: { id: fromId, first_name: "Operator" },
        text,
      },
    };
  }

  it("posts to the fixed target group and confirms privately when an operator DMs /spam", async () => {
    // relay stays OFF — /spam is independent of the relay switch.
    const { deps, sendMessage, deleteMessage, insert } = makeDeps({
      relayEnabled: false,
    });

    await handleUpdate(spamDm(ADMIN_ID), deps);

    // 1) announcement into the fixed group, 2) private confirmation.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, TARGET_GROUP, EXPECTED_MESSAGE);
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      ADMIN_ID,
      "✅ Đã gửi thông báo vào nhóm."
    );
    // Pure announcement: no deletes, no credential logging.
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("ignores /spam from a non-authorized user (posts nothing)", async () => {
    const { deps, sendMessage } = makeDeps({ relayEnabled: false });
    await handleUpdate(spamDm(999999), deps);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores /spam sent inside a group (must be a private DM)", async () => {
    const { deps, sendMessage } = makeDeps({ relayEnabled: false });
    await handleUpdate(
      {
        update_id: 51,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: GROUP_ID, type: "supergroup", title: "Nhóm QLL" },
          from: { id: ADMIN_ID, first_name: "Operator" },
          text: "/spam",
        },
      },
      deps
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still works when relay is enabled, without running the relay flow", async () => {
    const { deps, sendMessage, deleteMessage } = makeDeps({
      relayEnabled: true,
    });
    await handleUpdate(spamDm(ADMIN_ID), deps);
    expect(sendMessage).toHaveBeenNthCalledWith(1, TARGET_GROUP, EXPECTED_MESSAGE);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — passive collection mode (relay disabled)", () => {
  it("collects the sender but performs NO relay action when relay is off", async () => {
    // Even a sensitive reply must not be deleted, relayed, or replied to while
    // relay is disabled — only the user is collected.
    const { deps, sendMessage, deleteMessage, insert, upsert } = makeDeps({
      relayEnabled: false,
    });

    await handleUpdate(sensitiveReply("TK: 0988573647 / MK: 0938347328"), deps);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // The CTV (message sender) is upserted into telegram_users_qll.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      telegram_id: 222,
      username: null,
      full_name: "Minh CTV",
      chat_id: GROUP_ID,
    });
  });

  it("collects newly-joined members from new_chat_members", async () => {
    const { deps, upsert } = makeDeps({ relayEnabled: false });

    await handleUpdate(
      {
        update_id: 9,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: GROUP_ID, type: "supergroup", title: "Nhóm QLL" },
          from: { id: 500, first_name: "Admin" },
          new_chat_members: [
            { id: 601, first_name: "An", username: "an_qll" },
            { id: 602, first_name: "Bình", last_name: "Trần" },
            { id: 999, is_bot: true, first_name: "SomeBot" },
          ],
        },
      },
      deps
    );

    // Admin (sender) + An + Bình are collected; the bot member is skipped.
    const ids = upsert.mock.calls.map((c) => (c[0] as { telegram_id: number }).telegram_id);
    expect(ids.sort()).toEqual([500, 601, 602]);
    // Chat title is captured.
    expect(upsert.mock.calls[0][0]).toMatchObject({ chat_title: "Nhóm QLL" });
  });

  it("does NOT collect users from a private chat", async () => {
    const { deps, upsert, sendMessage } = makeDeps({ relayEnabled: false });

    await handleUpdate(
      {
        update_id: 10,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: QLL_ID, type: "private" },
          from: { id: QLL_ID, first_name: "Boss" },
          text: "/start",
        },
      },
      deps
    );

    // Private chat is out of scope for collection, and relay is off so no ack.
    expect(upsert).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — batch announcement (admin DM .xlsx -> /ok -> group)", () => {
  const ADMIN_ID = 6532155675;
  const TARGET_GROUP = -1002273179613;
  const KNOWN = ["SA_LanNT18", "SAAnhPTH5"];

  // Builds an .xlsx buffer with the standard 5-column header and the given rows.
  function makeXlsx(rows: unknown[][]): Buffer {
    const aoa = [["Tên", "Mã lớp", "Ngày học", "QLL", "Lịch học"], ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  function docDm(fromId: number, chatType = "private"): TelegramUpdate {
    return {
      update_id: 70,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: fromId, type: chatType as "private" | "supergroup" },
        from: { id: fromId, first_name: "Operator" },
        document: {
          file_id: "file-123",
          file_name: "lophoc.xlsx",
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      },
    };
  }

  function textDm(fromId: number, text: string): TelegramUpdate {
    return {
      update_id: 71,
      message: {
        message_id: 2,
        date: 1_700_000_000,
        chat: { id: fromId, type: "private" },
        from: { id: fromId, first_name: "Operator" },
        text,
      },
    };
  }

  it("downloads, parses, maps, saves pending, replies summary, posts NOTHING to the group", async () => {
    const buf = makeXlsx([
      ["Vũ Xuân Kỳ (SID: 189064)", "KHTN.2026.0913", "15/10/2026", "Nông Thị Lan 18", "T5 20:30-21:30"],
      ["Đặng Mai Vy (SID: 213054)", "KHTN.2026.1972", "15/10/2026", "Phạm Thị Hải Anh 5", ""],
      ["Ai Đó", "L9", "15/10/2026", "Trần Văn Khoa 9", "T6"],
    ]);
    const { deps, sendMessage, pendingUpsert, downloadFile } = makeDeps({
      relayEnabled: false,
      downloadResult: { ok: true, buffer: buf },
      knownUsernames: KNOWN,
    });

    await handleUpdate(docDm(ADMIN_ID), deps);

    expect(downloadFile).toHaveBeenCalledWith("file-123");
    // Pending saved with exactly the two mapped items.
    expect(pendingUpsert).toHaveBeenCalledTimes(1);
    const saved = pendingUpsert.mock.calls[0][0] as {
      admin_id: number;
      items: MappedItem[];
    };
    expect(saved.admin_id).toBe(ADMIN_ID);
    expect(saved.items).toEqual([
      {
        tenHS: "Vũ Xuân Kỳ (SID: 189064)",
        maLop: "KHTN.2026.0913",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_LanNT18",
      },
      {
        tenHS: "Đặng Mai Vy (SID: 213054)",
        maLop: "KHTN.2026.1972",
        ngayHoc: "15/10/2026",
        lichHoc: "",
        username: "SAAnhPTH5",
      },
    ]);

    // Exactly one message back to the admin (the summary); nothing to the group.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(ADMIN_ID);
    const summary = sendMessage.mock.calls[0][1] as string;
    expect(summary).toContain("Tổng số dòng: 3");
    expect(summary).toContain("Đã map (2):");
    expect(summary).toContain("Không tìm thấy (1):");
    expect(summary).toContain("- Trần Văn Khoa 9");
    expect(summary).toContain("Gõ /ok để gửi, /huy để huỷ.");
    // Never posts to the target group during the preview step.
    const postedToGroup = sendMessage.mock.calls.some(
      (c) => c[0] === TARGET_GROUP
    );
    expect(postedToGroup).toBe(false);
  });

  it("/ok enqueues one row per item, deletes pending, confirms, and posts NOTHING to the group", async () => {
    const items: MappedItem[] = [
      {
        tenHS: "Vũ Xuân Kỳ (SID: 189064)",
        maLop: "KHTN.2026.0913",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_LanNT18",
      },
      {
        tenHS: "Đặng Mai Vy (SID: 213054)",
        maLop: "KHTN.2026.1972",
        ngayHoc: "15/10/2026",
        lichHoc: "",
        username: "SAAnhPTH5",
      },
    ];
    const { deps, sendMessage, sendQueueInsert, pendingDeleteEq } = makeDeps({
      relayEnabled: false,
      pendingItems: items,
    });

    await handleUpdate(textDm(ADMIN_ID, "/ok"), deps);

    // The two items map to two DISTINCT usernames, so grouping yields one row
    // per QLL: fixed target group chat_id, message_text identical to the
    // grouped announcement for that QLL's single student.
    expect(sendQueueInsert).toHaveBeenCalledTimes(1);
    const enqueued = sendQueueInsert.mock.calls[0][0] as {
      admin_id: number;
      chat_id: number;
      message_text: string;
      send_after: string | null;
    }[];
    expect(enqueued).toEqual([
      {
        admin_id: ADMIN_ID,
        chat_id: TARGET_GROUP,
        message_text: buildGroupedAnnouncement("SA_LanNT18", [items[0]]),
        send_after: null,
      },
      {
        admin_id: ADMIN_ID,
        chat_id: TARGET_GROUP,
        message_text: buildGroupedAnnouncement("SAAnhPTH5", [items[1]]),
        send_after: null,
      },
    ]);

    // Pending batch cleared.
    expect(pendingDeleteEq).toHaveBeenCalledTimes(1);

    // Exactly one message back to the admin: the "đã xếp hàng" confirmation.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "✅ Đã xếp 2 tin cho 2 QLL vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong."
    );
    // Nothing is posted synchronously to the target group.
    const postedToGroup = sendMessage.mock.calls.some(
      (c) => c[0] === TARGET_GROUP
    );
    expect(postedToGroup).toBe(false);
  });

  it("/ok 21:00 schedules: every row carries a non-null send_after and the reply confirms the VN time", async () => {
    const items: MappedItem[] = [
      {
        tenHS: "Vũ Xuân Kỳ (SID: 189064)",
        maLop: "KHTN.2026.0913",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_LanNT18",
      },
      {
        tenHS: "Đặng Mai Vy (SID: 213054)",
        maLop: "KHTN.2026.1972",
        ngayHoc: "15/10/2026",
        lichHoc: "",
        username: "SAAnhPTH5",
      },
    ];
    const { deps, sendMessage, sendQueueInsert, pendingDeleteEq } = makeDeps({
      relayEnabled: false,
      pendingItems: items,
    });

    await handleUpdate(textDm(ADMIN_ID, "/ok 21:00"), deps);

    // Enqueued once; every row has a non-null ISO send_after, all identical.
    expect(sendQueueInsert).toHaveBeenCalledTimes(1);
    const enqueued = sendQueueInsert.mock.calls[0][0] as {
      send_after: string | null;
    }[];
    expect(enqueued).toHaveLength(2);
    for (const r of enqueued) {
      expect(typeof r.send_after).toBe("string");
    }
    expect(enqueued[0].send_after).toBe(enqueued[1].send_after);

    // Pending cleared, nothing posted to the group synchronously.
    expect(pendingDeleteEq).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.some((c) => c[0] === TARGET_GROUP)).toBe(false);

    // Exactly one scheduled-confirmation reply to the admin.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reply = sendMessage.mock.calls[0][1] as string;
    expect(sendMessage.mock.calls[0][0]).toBe(ADMIN_ID);
    expect(reply).toContain("Đã lên lịch gửi 2 tin cho 2 QLL");
    expect(reply).toContain("(giờ VN)");
  });

  it("/ok with an invalid time replies the parser reason and does NOT enqueue or delete", async () => {
    const items: MappedItem[] = [
      {
        tenHS: "Vũ Xuân Kỳ (SID: 189064)",
        maLop: "KHTN.2026.0913",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_LanNT18",
      },
    ];
    const { deps, sendMessage, sendQueueInsert, pendingDeleteEq } = makeDeps({
      relayEnabled: false,
      pendingItems: items,
    });

    await handleUpdate(textDm(ADMIN_ID, "/ok 99:99"), deps);

    expect(sendQueueInsert).not.toHaveBeenCalled();
    expect(pendingDeleteEq).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reply = sendMessage.mock.calls[0][1] as string;
    expect(reply).toContain("không hợp lệ");
  });

  it("/OK (uppercase, no arg) behaves as an immediate send (send_after null)", async () => {
    const items: MappedItem[] = [
      {
        tenHS: "Vũ Xuân Kỳ (SID: 189064)",
        maLop: "KHTN.2026.0913",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_LanNT18",
      },
    ];
    const { deps, sendMessage, sendQueueInsert } = makeDeps({
      relayEnabled: false,
      pendingItems: items,
    });

    await handleUpdate(textDm(ADMIN_ID, "/OK"), deps);

    expect(sendQueueInsert).toHaveBeenCalledTimes(1);
    const enqueued = sendQueueInsert.mock.calls[0][0] as {
      send_after: string | null;
    }[];
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].send_after).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "✅ Đã xếp 1 tin cho 1 QLL vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong."
    );
  });

  it("/ok groups students sharing a QLL into one row with a single @tag", async () => {
    const items: MappedItem[] = [
      {
        tenHS: "HS Một",
        maLop: "KHTN.2026.0001",
        ngayHoc: "15/10/2026",
        lichHoc: "T5 20:30-21:30",
        username: "SA_X",
      },
      {
        tenHS: "HS Hai",
        maLop: "TOAN.2026.0002",
        ngayHoc: "16/10/2026",
        lichHoc: "",
        username: "SA_X",
      },
      {
        tenHS: "HS Ba",
        maLop: "MOET.2026.0003",
        ngayHoc: "17/10/2026",
        lichHoc: "T6",
        username: "SA_Y",
      },
    ];
    const { deps, sendMessage, sendQueueInsert } = makeDeps({
      relayEnabled: false,
      pendingItems: items,
    });

    await handleUpdate(textDm(ADMIN_ID, "/ok"), deps);

    // Exactly two rows: one per QLL (two students collapse into @SA_X).
    expect(sendQueueInsert).toHaveBeenCalledTimes(1);
    const enqueued = sendQueueInsert.mock.calls[0][0] as {
      chat_id: number;
      message_text: string;
      send_after: string | null;
    }[];
    expect(enqueued).toHaveLength(2);

    const [rowX, rowY] = enqueued;
    expect(rowX.chat_id).toBe(TARGET_GROUP);
    // The shared-username row lists BOTH students and tags @SA_X once.
    expect(rowX.message_text).toContain("1. HS Một");
    expect(rowX.message_text).toContain("2. HS Hai");
    expect(rowX.message_text.match(/@SA_X/g)).toHaveLength(1);
    expect(rowX.message_text).toContain("#KHTN #TOAN");
    // The other QLL is its own row with a single student.
    expect(rowY.message_text).toContain("1. HS Ba");
    expect(rowY.message_text.match(/@SA_Y/g)).toHaveLength(1);

    // Grouped confirmation: 2 tin cho 2 QLL.
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "✅ Đã xếp 2 tin cho 2 QLL vào hàng đợi. Bot sẽ gửi rải ~15-20s/tin, sẽ báo lại khi xong."
    );
  });

  it("/ok with no pending batch replies 'Không có danh sách nào đang chờ.' and posts nothing", async () => {
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      pendingItems: null,
    });
    await handleUpdate(textDm(ADMIN_ID, "/ok"), deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "Không có danh sách nào đang chờ."
    );
  });

  it("/huy deletes the pending batch and confirms (not swallowed by the /ok branch)", async () => {
    const { deps, sendMessage, pendingDeleteEq, sendQueueInsert } = makeDeps({
      relayEnabled: false,
    });
    await handleUpdate(textDm(ADMIN_ID, "/huy"), deps);
    expect(pendingDeleteEq).toHaveBeenCalledTimes(1);
    expect(sendQueueInsert).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "Đã huỷ danh sách đang chờ."
    );
  });

  it("ignores a document from a non-admin private chat", async () => {
    const { deps, sendMessage, downloadFile } = makeDeps({
      relayEnabled: false,
      downloadResult: { ok: true, buffer: makeXlsx([]) },
    });
    await handleUpdate(docDm(999999), deps);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a document sent in a group (still passively collects the sender)", async () => {
    const { deps, sendMessage, downloadFile, upsert } = makeDeps({
      relayEnabled: false,
      downloadResult: { ok: true, buffer: makeXlsx([]) },
    });
    await handleUpdate(
      {
        update_id: 72,
        message: {
          message_id: 3,
          date: 1_700_000_000,
          chat: { id: GROUP_ID, type: "supergroup", title: "Nhóm QLL" },
          from: { id: ADMIN_ID, first_name: "Operator" },
          document: { file_id: "file-123", file_name: "x.xlsx" },
        },
      },
      deps
    );
    expect(downloadFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    // Group document still triggers passive collection of the sender.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("reports a download failure privately and posts nothing to the group", async () => {
    const { deps, sendMessage, pendingUpsert } = makeDeps({
      relayEnabled: false,
      downloadResult: { ok: false, description: "boom" },
    });
    await handleUpdate(docDm(ADMIN_ID), deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(ADMIN_ID);
    expect(pendingUpsert).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — manual QLL commands (admin DM)", () => {
  const ADMIN_ID = 6532155675;
  const TARGET_GROUP = -1002273179613;

  function textDm(fromId: number, text: string): TelegramUpdate {
    return {
      update_id: 80,
      message: {
        message_id: 9,
        date: 1_700_000_000,
        chat: { id: fromId, type: "private" },
        from: { id: fromId, first_name: "Operator" },
        text,
      },
    };
  }

  it("/adduser @SA_HaNH3 Nguyễn Hải Hà 3 upserts and confirms", async () => {
    const { deps, sendMessage, upsert, pendingUpsert, sendQueueInsert } =
      makeDeps({ relayEnabled: false });
    await handleUpdate(textDm(ADMIN_ID, "/adduser @SA_HaNH3 Nguyễn Hải Hà 3"), deps);

    expect(upsert).toHaveBeenCalledTimes(1);
    const record = upsert.mock.calls[0][0] as {
      telegram_id: number;
      username: string;
      full_name: string;
      chat_title: string;
      chat_id: number;
    };
    expect(record.username).toBe("SA_HaNH3");
    expect(record.full_name).toBe("Nguyễn Hải Hà 3");
    expect(record.chat_title).toBe("manual");
    expect(record.chat_id).toBe(TARGET_GROUP);
    expect(record.telegram_id).toBeLessThan(0);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "✅ Đã thêm QLL: @SA_HaNH3 (Nguyễn Hải Hà 3)."
    );
    // Never touches the pending/send queue, never posts to the group.
    expect(pendingUpsert).not.toHaveBeenCalled();
    expect(sendQueueInsert).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.some((c) => c[0] === TARGET_GROUP)).toBe(false);
  });

  it("/adduser UPDATES the registered name when the username already exists", async () => {
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      existingUser: { username: "SA_HaNH3", fullName: "Ha Nguyen" },
    });
    await handleUpdate(
      textDm(ADMIN_ID, "/adduser @SA_HaNH3 Nguyễn Hải Hà 3"),
      deps
    );

    // One row per username is preserved; the admin is told the name was updated.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reply = sendMessage.mock.calls[0] as [number, string];
    expect(reply[0]).toBe(ADMIN_ID);
    expect(reply[1]).toContain("@SA_HaNH3");
    expect(reply[1]).toContain("cập nhật");
    expect(reply[1]).toContain("Nguyễn Hải Hà 3");
  });

  it("/adduser without the leading @ still upserts the bare username", async () => {
    const { deps, sendMessage, upsert } = makeDeps({ relayEnabled: false });
    await handleUpdate(textDm(ADMIN_ID, "/adduser SA_HaNH3 Nguyễn Hải Hà 3"), deps);
    expect((upsert.mock.calls[0][0] as { username: string }).username).toBe(
      "SA_HaNH3"
    );
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "✅ Đã thêm QLL: @SA_HaNH3 (Nguyễn Hải Hà 3)."
    );
  });

  it("/adduser with a missing name replies the usage hint and does NOT upsert", async () => {
    const { deps, sendMessage, upsert } = makeDeps({ relayEnabled: false });
    await handleUpdate(textDm(ADMIN_ID, "/adduser SA_HaNH3"), deps);
    expect(upsert).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "Cú pháp: /adduser @username Họ Tên"
    );
  });

  it("/finduser replies the mapped username when found", async () => {
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      knownUsernames: ["SA_LanNT18"],
    });
    await handleUpdate(textDm(ADMIN_ID, "/finduser Nông Thị Lan 18"), deps);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "🔎 Nông Thị Lan 18 -> @SA_LanNT18"
    );
  });

  it("/finduser replies not-found when no username matches", async () => {
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      knownUsernames: ["SA_LanNT18"],
    });
    await handleUpdate(textDm(ADMIN_ID, "/finduser Không Có Ai"), deps);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "❌ Không tìm thấy username cho: Không Có Ai"
    );
  });

  it("/finduser replies ambiguous when 2+ usernames match", async () => {
    // Two usernames with the same core -> ambiguous.
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      knownUsernames: ["SA_LanNT18", "OP_LanNT18"],
    });
    await handleUpdate(textDm(ADMIN_ID, "/finduser Nông Thị Lan 18"), deps);
    expect(sendMessage).toHaveBeenCalledWith(
      ADMIN_ID,
      "⚠️ Có nhiều username khớp cho: Nông Thị Lan 18"
    );
  });

  it("/listusers replies the count and lists the known usernames", async () => {
    const { deps, sendMessage } = makeDeps({
      relayEnabled: false,
      knownUsernames: ["SA_LanNT18", "SAAnhPTH5"],
    });
    await handleUpdate(textDm(ADMIN_ID, "/listusers"), deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reply = sendMessage.mock.calls[0][1] as string;
    expect(reply).toContain("📋 Đang có 2 QLL:");
    expect(reply).toContain("@SA_LanNT18");
    expect(reply).toContain("@SAAnhPTH5");
  });

  it("ignores /adduser from a non-admin (no upsert, no reply)", async () => {
    const { deps, sendMessage, upsert } = makeDeps({ relayEnabled: false });
    await handleUpdate(textDm(999999, "/adduser @SA_X Nguyễn Văn A"), deps);
    expect(upsert).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — single-log invariant", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("writes exactly one log row on the happy path", async () => {
    const { deps, insert } = makeDeps({
      sendResults: [{ ok: true, messageId: 9 }],
      deleteResults: [{ ok: true }],
    });
    await handleUpdate(sensitiveReply(), deps);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
