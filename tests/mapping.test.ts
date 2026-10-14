import { describe, expect, it } from "vitest";
import { buildLogRecord, displayName } from "../lib/mapping.js";
import type { TelegramMessage } from "../lib/types.js";

describe("displayName", () => {
  it("returns first + last when both present", () => {
    expect(displayName({ id: 1, first_name: "Nguyen", last_name: "An" })).toBe(
      "Nguyen An"
    );
  });

  it("returns first only when last is absent", () => {
    expect(displayName({ id: 1, first_name: "Nguyen" })).toBe("Nguyen");
  });

  it("falls back to username when no names present", () => {
    expect(displayName({ id: 1, username: "nguyenan" })).toBe("nguyenan");
  });

  it("returns empty string when nothing is present", () => {
    expect(displayName({ id: 1 })).toBe("");
  });
});

describe("buildLogRecord", () => {
  const baseMessage: TelegramMessage = {
    message_id: 200,
    date: 1_700_000_100,
    chat: { id: -100, type: "supergroup" },
    from: { id: 2, first_name: "CTV", last_name: "User" },
    text: "TK: user / MK: pass",
    reply_to_message: {
      message_id: 100,
      date: 1_700_000_000,
      chat: { id: -100, type: "supergroup" },
      from: { id: 1, first_name: "QLL", last_name: "Boss" },
      text: "Cho mình xin tài khoản",
    },
  };

  it("maps all fields from message and reply_to_message", () => {
    const record = buildLogRecord(baseMessage, "Đã gửi Inbox");
    expect(record).toEqual({
      created_at: new Date(1_700_000_000 * 1000).toISOString(),
      qll_telegram_id: "1",
      qll_name: "QLL Boss",
      request_content: "Cho mình xin tài khoản",
      ctv_name: "CTV User",
      response_content: "TK: user / MK: pass",
      status: "Đã gửi Inbox",
    });
  });

  it("sets created_at to the reply_to_message timestamp as ISO UTC", () => {
    const record = buildLogRecord(baseMessage, "Đã gửi Inbox");
    expect(record.created_at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("uses empty string when the replied-to message has no text", () => {
    const msg: TelegramMessage = {
      ...baseMessage,
      reply_to_message: {
        ...baseMessage.reply_to_message!,
        text: undefined,
      },
    };
    expect(buildLogRecord(msg, "Đã gửi Inbox").request_content).toBe("");
  });

  it("preserves an explicit empty-string replied-to text as ''", () => {
    const msg: TelegramMessage = {
      ...baseMessage,
      reply_to_message: {
        ...baseMessage.reply_to_message!,
        text: "",
      },
    };
    expect(buildLogRecord(msg, "Đã gửi Inbox").request_content).toBe("");
  });

  it("falls back to username in qll_name / ctv_name", () => {
    const msg: TelegramMessage = {
      ...baseMessage,
      from: { id: 2, username: "ctvuser" },
      reply_to_message: {
        ...baseMessage.reply_to_message!,
        from: { id: 1, username: "qlluser" },
      },
    };
    const record = buildLogRecord(msg, "Đã gửi Inbox");
    expect(record.qll_name).toBe("qlluser");
    expect(record.ctv_name).toBe("ctvuser");
  });
});
