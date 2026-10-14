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
  deleteResults?: DeleteResult[];
}): {
  deps: Deps;
  trace: string[];
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const trace: string[] = [];
  let sendIdx = 0;
  let deleteIdx = 0;

  const sendResults = options.sendResults ?? [];
  const sendThrows = options.sendThrows ?? [];
  const deleteResults = options.deleteResults ?? [];

  const sendMessage = vi.fn(async (chatId: number, _text: string) => {
    const i = sendIdx++;
    trace.push(`send:${chatId}`);
    if (sendThrows[i]) {
      throw sendThrows[i];
    }
    return sendResults[i] ?? ({ ok: true, messageId: 1 } as SendResult);
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
  const supabase = {
    from: vi.fn(() => ({ insert })),
  } as unknown as SupabaseClient;

  return { deps: { telegram, supabase }, trace, sendMessage, deleteMessage, insert };
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

    // Inbox send carries the exact sensitive text to the QLL.
    expect(sendMessage).toHaveBeenNthCalledWith(1, QLL_ID, "TK: user / MK: pass");
    // Confirmation line with the CTV display name.
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      GROUP_ID,
      "🔒 Minh CTV đã gửi thông tin Tài khoản / Mật khẩu vào Inbox cá nhân của QLL."
    );
    expect(deleteMessage).toHaveBeenCalledTimes(1);
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
    expect(sendMessage).toHaveBeenNthCalledWith(2, GROUP_ID, WARNING);
  });
});

describe("handleUpdate — timeout behaves like 403", () => {
  it("treats a 10s timeout identically to 403", async () => {
    const { deps, trace, sendMessage } = makeDeps({
      sendThrows: [new Error("timed out")],
      deleteResults: [{ ok: true }],
    });

    await handleUpdate(sensitiveReply(), deps);

    expect(trace).toEqual([
      `send:${QLL_ID}`,
      `delete:${GROUP_ID}:${REPLY_MSG_ID}`,
      "log:Lỗi chưa start bot",
      `send:${GROUP_ID}`,
    ]);
    expect(sendMessage).toHaveBeenNthCalledWith(2, GROUP_ID, WARNING);
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

describe("handleUpdate — ignore branches", () => {
  it("ignores a group message that is not a reply (zero calls)", async () => {
    const { deps, sendMessage, deleteMessage, insert } = makeDeps({});
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
  });

  it("ignores a group reply that is not sensitive (zero calls)", async () => {
    const { deps, sendMessage, deleteMessage, insert } = makeDeps({});
    const update = sensitiveReply("Chào bạn nhé");
    await handleUpdate(update, deps);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("handleUpdate — private /start", () => {
  it("acknowledges the inbox and does nothing else", async () => {
    const { deps, sendMessage, deleteMessage, insert } = makeDeps({});
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
