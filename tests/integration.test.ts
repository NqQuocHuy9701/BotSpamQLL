import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Mock only the external edges: Supabase client and native fetch. The webhook,
// handler, detector, telegram wrapper, config, and mapping all run for real.
const insert = vi.fn(async (_record: { status: string }) => ({ error: null }));
const upsert = vi.fn(async (_record: { telegram_id: number }) => ({ error: null }));
const supabaseFrom = vi.fn((table: string) =>
  table === "telegram_users_qll" ? { upsert } : { insert }
);
vi.mock("../lib/supabase.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/supabase.js")>();
  return {
    ...actual,
    getClient: vi.fn(() => ({ from: supabaseFrom })),
  };
});

const { default: handler } = await import("../api/webhook.js");

function mockRes(): VercelResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as VercelResponse & {
    statusCode: number;
    body: unknown;
  };
}

const GROUP_ID = -1001;
const QLL_ID = 111;

function sensitiveUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 500,
      date: 1_700_000_100,
      chat: { id: GROUP_ID, type: "supergroup" },
      from: { id: 222, first_name: "Minh", last_name: "CTV" },
      text: "TK: user / MK: pass",
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

// Builds a fetch mock whose response depends on the Telegram method called.
function stubFetch(sendPayload: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/sendMessage")) {
      return { json: async () => sendPayload };
    }
    // deleteMessage
    return { json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

describe("integration: api/webhook end-to-end", () => {
  beforeEach(() => {
    process.env.BOT_TOKEN = "test-token";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_KEY = "test-key";
    // These end-to-end cases exercise the relay flow, so enable it explicitly.
    process.env.RELAY_ENABLED = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BOT_TOKEN;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;
    delete process.env.RELAY_ENABLED;
  });

  it("happy path: relays, deletes, logs, confirms and returns 200", async () => {
    const fetchSpy = stubFetch({ ok: true, result: { message_id: 9 } });
    const res = mockRes();

    await handler(
      { body: sensitiveUpdate() } as unknown as VercelRequest,
      res
    );

    expect(res.statusCode).toBe(200);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // Inbox send, then delete, then group confirmation.
    expect(calls[0]).toContain("/sendMessage");
    expect(calls[1]).toContain("/deleteMessage");
    expect(calls[2]).toContain("/sendMessage");

    const confirmBody = JSON.parse(
      (fetchSpy.mock.calls[2][1] as RequestInit).body as string
    );
    expect(confirmBody.text).toBe(
      "🔒 Em đã gửi tin nhắn cho mình rồi ạ. Anh/chị kiểm tra tin nhắn nha ạ"
    );

    expect(supabaseFrom).toHaveBeenCalledWith("bot_account_logs");
    expect(insert.mock.calls[0][0]).toMatchObject({ status: "Đã gửi Inbox" });
  });

  it("403 path: deletes first, logs 'Lỗi chưa start bot', warns and returns 200", async () => {
    const fetchSpy = stubFetch({
      ok: false,
      error_code: 403,
      description: "Forbidden",
    });
    const res = mockRes();

    await handler(
      { body: sensitiveUpdate() } as unknown as VercelRequest,
      res
    );

    expect(res.statusCode).toBe(200);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toContain("/sendMessage"); // inbox attempt
    expect(calls[1]).toContain("/deleteMessage"); // delete FIRST
    expect(calls[2]).toContain("/sendMessage"); // warning

    const warnBody = JSON.parse(
      (fetchSpy.mock.calls[2][1] as RequestInit).body as string
    );
    expect(warnBody.text).toBe(
      "⚠️ Đã ẩn thông tin! QLL cần bấm /start ở khung chat riêng với Bot để nhận Inbox."
    );
    expect(insert.mock.calls[0][0]).toMatchObject({
      status: "Lỗi chưa start bot",
    });
  });
});
