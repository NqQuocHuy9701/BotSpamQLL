import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  SendResult,
  TelegramClient,
} from "../lib/telegram.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SendQueueRow } from "../lib/types.js";

// Mock the supabase queue helpers so runCron's behavior is fully driven by the
// test. getClient is stubbed too (used only by the HTTP handler path).
const fetchNextUnsent =
  vi.fn<(client: unknown, limit: number) => Promise<unknown>>();
const markSent =
  vi.fn<(client: unknown, id: string) => Promise<{ ok: boolean }>>(
    async () => ({ ok: true })
  );
const countUnsent =
  vi.fn<
    (client: unknown, adminId?: number) => Promise<{ ok: boolean; count: number }>
  >(async () => ({ ok: true, count: 0 }));
const getClient = vi.fn(() => ({}) as unknown as SupabaseClient);
const loadConfig = vi.fn();
const createTelegramClient = vi.fn(() => ({}) as unknown as TelegramClient);

vi.mock("../lib/supabase.js", () => ({
  fetchNextUnsent,
  markSent,
  countUnsent,
  getClient,
}));
vi.mock("../lib/config.js", () => ({ loadConfig }));
vi.mock("../lib/telegram.js", () => ({ createTelegramClient }));

const { default: handler, runCron, CRON_DELAY_MS } = await import(
  "../api/cron.js"
);

const ADMIN_ID = 6532155675;
const TARGET_GROUP = -1002273179613;

function row(id: string, message_text: string, admin_id = ADMIN_ID): SendQueueRow {
  return { id, admin_id, chat_id: TARGET_GROUP, message_text };
}

// A fake telegram client whose sendMessage returns a programmable result per
// call (defaults to success) and records calls.
function fakeTelegram(results: Record<number, SendResult> = {}): {
  telegram: TelegramClient;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const sendMessage = vi.fn(async (_chatId: number, _text: string) => {
    const r = results[i] ?? ({ ok: true, messageId: 1 } as SendResult);
    i++;
    return r;
  });
  const telegram = {
    sendMessage,
    deleteMessage: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as TelegramClient;
  return { telegram, sendMessage };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCron — drip send", () => {
  it("sends 3 rows in order, marks each sent, and sleeps only between sends", async () => {
    const rows = [row("1", "A"), row("2", "B"), row("3", "C")];
    fetchNextUnsent.mockResolvedValue({ ok: true, rows });
    // Queue still has rows after this batch -> no completion DM, so the only
    // sends are the three drip sends.
    countUnsent.mockResolvedValue({ ok: true, count: 2 });
    const { telegram, sendMessage } = fakeTelegram();
    const sleep = vi.fn(async () => {});

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep,
      batchSize: 3,
    });

    // All three announcements sent to their chat_id in created_at order.
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(1, TARGET_GROUP, "A");
    expect(sendMessage).toHaveBeenNthCalledWith(2, TARGET_GROUP, "B");
    expect(sendMessage).toHaveBeenNthCalledWith(3, TARGET_GROUP, "C");

    // Each successful send is marked sent.
    expect(markSent).toHaveBeenCalledTimes(3);
    expect(markSent).toHaveBeenNthCalledWith(1, expect.anything(), "1");
    expect(markSent).toHaveBeenNthCalledWith(2, expect.anything(), "2");
    expect(markSent).toHaveBeenNthCalledWith(3, expect.anything(), "3");

    // Sleep fires between sends only (2 times for 3 rows), at CRON_DELAY_MS.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(CRON_DELAY_MS);
  });

  it("uses an injected delayMs when provided", async () => {
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [row("1", "A"), row("2", "B")] });
    const { telegram } = fakeTelegram();
    const sleep = vi.fn(async () => {});

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep,
      delayMs: 50,
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });
});

describe("runCron — scheduled (hẹn giờ) due-filter contract", () => {
  it("sends exactly the DUE rows fetchNextUnsent returns and no others", async () => {
    // The DB applies the send_after due-filter (asserted in supabase-queue
    // tests); at the cron level, runCron must send precisely what it is given.
    const dueRows = [row("1", "A"), row("2", "B")];
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: dueRows });
    countUnsent.mockResolvedValue({ ok: true, count: 1 });
    const { telegram, sendMessage } = fakeTelegram();

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, TARGET_GROUP, "A");
    expect(sendMessage).toHaveBeenNthCalledWith(2, TARGET_GROUP, "B");
  });

  it("gates the completion DM on countUnsent for the admin (ignores scheduling)", async () => {
    // countUnsent counts ALL of an admin's unsent rows regardless of
    // send_after, so a still-pending scheduled row keeps count > 0 and the
    // completion DM is withheld.
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [row("1", "A")] });
    countUnsent.mockResolvedValue({ ok: true, count: 3 });
    const { telegram, sendMessage } = fakeTelegram();

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    expect(countUnsent).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
    // Only the group send; no premature completion DM while rows remain.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(TARGET_GROUP, "A");
  });
});

describe("runCron — empty queue", () => {
  it("sends nothing, marks nothing, and does not sleep or notify", async () => {
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [] });
    const { telegram, sendMessage } = fakeTelegram();
    const sleep = vi.fn(async () => {});

    await runCron({ telegram, supabase: {} as unknown as SupabaseClient, sleep });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(countUnsent).not.toHaveBeenCalled();
  });
});

describe("runCron — a failed send stays unsent", () => {
  it("does not mark the failed row but still processes the rest", async () => {
    const rows = [row("1", "A"), row("2", "B"), row("3", "C")];
    fetchNextUnsent.mockResolvedValue({ ok: true, rows });
    countUnsent.mockResolvedValue({ ok: true, count: 1 });
    // The middle send fails.
    const { telegram, sendMessage } = fakeTelegram({
      1: { ok: false, forbidden: false, description: "Bad Request" },
    });
    const sleep = vi.fn(async () => {});

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep,
      batchSize: 3,
    });

    // All three were attempted.
    expect(sendMessage).toHaveBeenCalledTimes(3);
    // markSent called for the two successes (ids 1 and 3), NOT the failed id 2.
    const markedIds = markSent.mock.calls.map((c) => c[1]);
    expect(markedIds).toEqual(["1", "3"]);
  });

  it("does not mark a row whose send throws, and keeps going", async () => {
    const rows = [row("1", "A"), row("2", "B")];
    fetchNextUnsent.mockResolvedValue({ ok: true, rows });
    countUnsent.mockResolvedValue({ ok: true, count: 1 });
    const sendMessage = vi.fn(async (_chatId: number, text: string) => {
      if (text === "A") {
        throw new Error("network down");
      }
      return { ok: true, messageId: 1 } as SendResult;
    });
    const telegram = {
      sendMessage,
      deleteMessage: vi.fn(),
      downloadFile: vi.fn(),
    } as unknown as TelegramClient;

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const markedIds = markSent.mock.calls.map((c) => c[1]);
    expect(markedIds).toEqual(["2"]);
  });
});

describe("runCron — per-admin completion notice", () => {
  it("DMs the admin when their queue is now empty", async () => {
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [row("1", "A")] });
    countUnsent.mockResolvedValue({ ok: true, count: 0 });
    const { telegram, sendMessage } = fakeTelegram();

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    expect(countUnsent).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
    // 1 group send + 1 completion DM to the admin.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      ADMIN_ID,
      "✅ Đã gửi xong toàn bộ danh sách vào nhóm."
    );
  });

  it("does NOT DM the admin when rows remain", async () => {
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [row("1", "A")] });
    countUnsent.mockResolvedValue({ ok: true, count: 4 });
    const { telegram, sendMessage } = fakeTelegram();

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    // Only the group send; no completion DM.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(TARGET_GROUP, "A");
  });

  it("notifies each admin independently when multiple admins are drained", async () => {
    const OTHER_ADMIN = 999;
    fetchNextUnsent.mockResolvedValue({
      ok: true,
      rows: [row("1", "A", ADMIN_ID), row("2", "B", OTHER_ADMIN)],
    });
    // ADMIN_ID drained (0), OTHER_ADMIN still has rows (2).
    countUnsent.mockImplementation(async (_c, adminId) =>
      adminId === ADMIN_ID ? { ok: true, count: 0 } : { ok: true, count: 2 }
    );
    const { telegram, sendMessage } = fakeTelegram();

    await runCron({
      telegram,
      supabase: {} as unknown as SupabaseClient,
      sleep: vi.fn(async () => {}),
    });

    const completionDMs = sendMessage.mock.calls.filter(
      (c) => c[1] === "✅ Đã gửi xong toàn bộ danh sách vào nhóm."
    );
    expect(completionDMs).toHaveLength(1);
    expect(completionDMs[0][0]).toBe(ADMIN_ID);
  });
});

describe("api/cron — auth guard", () => {
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

  beforeEach(() => {
    loadConfig.mockReturnValue({
      botToken: "t",
      supabaseUrl: "u",
      supabaseKey: "k",
      relayEnabled: false,
    });
    delete process.env.CRON_SECRET;
  });

  it("does nothing (but returns 200) for a non-cron request", async () => {
    const req = { headers: {} } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ skipped: true });
    expect(fetchNextUnsent).not.toHaveBeenCalled();
  });

  it("proceeds for a genuine Vercel cron request (reads the queue)", async () => {
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [] });
    const req = {
      headers: { "x-vercel-cron": "1" },
    } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(fetchNextUnsent).toHaveBeenCalledTimes(1);
  });

  it("accepts an Authorization bearer matching CRON_SECRET", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    fetchNextUnsent.mockResolvedValue({ ok: true, rows: [] });
    const req = {
      headers: { authorization: "Bearer s3cr3t" },
    } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(fetchNextUnsent).toHaveBeenCalledTimes(1);
    delete process.env.CRON_SECRET;
  });

  it("always returns 200 even if the queue read throws", async () => {
    fetchNextUnsent.mockRejectedValue(new Error("boom"));
    const req = {
      headers: { "x-vercel-cron": "1" },
    } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });
});
