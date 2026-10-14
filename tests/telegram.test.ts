import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramClient,
  deleteWithRetry,
  withTimeout,
  TimeoutError,
  type TelegramClient,
} from "../lib/telegram.js";

function mockFetchOnce(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => payload,
    })) as unknown as typeof fetch
  );
}

describe("createTelegramClient.sendMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a successful send", async () => {
    mockFetchOnce({ ok: true, result: { message_id: 42 } });
    const client = createTelegramClient("token");
    const result = await client.sendMessage(1, "hi");
    expect(result).toEqual({ ok: true, messageId: 42 });
  });

  it("classifies a 403 as forbidden", async () => {
    mockFetchOnce({ ok: false, error_code: 403, description: "Forbidden" });
    const client = createTelegramClient("token");
    const result = await client.sendMessage(1, "hi");
    expect(result).toEqual({
      ok: false,
      forbidden: true,
      description: "Forbidden",
    });
  });

  it("classifies a non-403 failure as not forbidden", async () => {
    mockFetchOnce({ ok: false, error_code: 400, description: "Bad Request" });
    const client = createTelegramClient("token");
    const result = await client.sendMessage(1, "hi");
    expect(result).toEqual({
      ok: false,
      forbidden: false,
      description: "Bad Request",
    });
  });

  it("sends the exact text byte-for-byte", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    const client = createTelegramClient("token");
    await client.sendMessage(99, "TK: user / MK: pass");
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ chat_id: 99, text: "TK: user / MK: pass" });
  });
});

describe("createTelegramClient.deleteMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a successful delete", async () => {
    mockFetchOnce({ ok: true });
    const client = createTelegramClient("token");
    expect(await client.deleteMessage(1, 2)).toEqual({ ok: true });
  });

  it("classifies a failed delete", async () => {
    mockFetchOnce({ ok: false, description: "message not found" });
    const client = createTelegramClient("token");
    expect(await client.deleteMessage(1, 2)).toEqual({
      ok: false,
      description: "message not found",
    });
  });
});

describe("withTimeout", () => {
  it("resolves when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejects with TimeoutError when the promise is too slow", async () => {
    vi.useFakeTimers();
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    const guarded = withTimeout(slow, 10);
    const assertion = expect(guarded).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    vi.useRealTimers();
  });
});

describe("deleteWithRetry", () => {
  it("returns on the first successful attempt", async () => {
    const client: TelegramClient = {
      sendMessage: vi.fn(),
      deleteMessage: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await deleteWithRetry(client, 1, 2);
    expect(result).toEqual({ ok: true });
    expect(client.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("stops after 3 attempts when deletes keep failing", async () => {
    const client: TelegramClient = {
      sendMessage: vi.fn(),
      deleteMessage: vi.fn(async () => ({
        ok: false as const,
        description: "fail",
      })),
    };
    const result = await deleteWithRetry(client, 1, 2);
    expect(result).toEqual({ ok: false, description: "fail" });
    expect(client.deleteMessage).toHaveBeenCalledTimes(3);
  });

  it("retries until success within the attempt budget", async () => {
    const deleteMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, description: "fail" })
      .mockResolvedValueOnce({ ok: true });
    const client: TelegramClient = {
      sendMessage: vi.fn(),
      deleteMessage,
    };
    const result = await deleteWithRetry(client, 1, 2);
    expect(result).toEqual({ ok: true });
    expect(deleteMessage).toHaveBeenCalledTimes(2);
  });
});
