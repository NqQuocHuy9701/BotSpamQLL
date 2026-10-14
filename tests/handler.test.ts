import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleUpdate, type Deps } from "../lib/handler.js";
import type {
  SendResult,
  DeleteResult,
  TelegramClient,
} from "../lib/telegram.js";
import type { TelegramUpdate } from "../lib/types.js";

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
}): {
  deps: Deps;
  trace: string[];
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
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

  const telegram: TelegramClient = { sendMessage, deleteMessage };

  // Records each inserted log row in the trace.
  const insert = vi.fn(async (record: { status: string }) => {
    trace.push(`log:${record.status}`);
    return { error: null };
  });
  const from = vi.fn(() => ({ insert }));
  const supabase = {
    from,
  } as unknown as SupabaseClient;

  return { deps: { telegram, supabase }, trace, sendMessage, deleteMessage, insert, from };
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
    // Confirmation line with the CTV display name, posted as a REPLY to the
    // QLL's original request message (message_id 400).
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      GROUP_ID,
      "🔒 Minh CTV đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL.",
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
    const deps: Deps = {
      telegram: { sendMessage, deleteMessage },
      supabase: { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient,
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
  it("ignores a group message that is not a reply (zero calls)", async () => {
    const { deps, sendMessage, deleteMessage, insert, from } = makeDeps({});
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
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // The Supabase query builder must not even be consulted for an ignored update.
    expect(from).not.toHaveBeenCalled();
  });

  it("ignores a group reply that is not sensitive (zero calls)", async () => {
    const { deps, sendMessage, deleteMessage, insert, from } = makeDeps({});
    const update = sensitiveReply("Chào bạn nhé");
    await handleUpdate(update, deps);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    // The Supabase query builder must not even be consulted for an ignored update.
    expect(from).not.toHaveBeenCalled();
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
