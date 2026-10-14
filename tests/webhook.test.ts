import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const loadConfig = vi.fn();
const handleUpdate = vi.fn();
const createTelegramClient = vi.fn(() => ({}));
const getClient = vi.fn(() => ({}));

vi.mock("../lib/config.js", () => ({ loadConfig }));
vi.mock("../lib/handler.js", () => ({ handleUpdate }));
vi.mock("../lib/telegram.js", () => ({ createTelegramClient }));
vi.mock("../lib/supabase.js", () => ({ getClient }));

const { default: handler } = await import("../api/webhook.js");

function mockRes(): VercelResponse & {
  statusCode: number;
  body: unknown;
} {
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
  return res as unknown as VercelResponse & { statusCode: number; body: unknown };
}

describe("api/webhook", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 for a valid update", async () => {
    loadConfig.mockReturnValue({
      botToken: "t",
      supabaseUrl: "u",
      supabaseKey: "k",
    });
    handleUpdate.mockResolvedValue(undefined);

    const req = { body: { update_id: 1 } } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when config is missing", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("Missing required environment variable: BOT_TOKEN");
    });

    const req = { body: { update_id: 1 } } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it("still returns 200 when the handler throws (handled outcome)", async () => {
    loadConfig.mockReturnValue({
      botToken: "t",
      supabaseUrl: "u",
      supabaseKey: "k",
    });
    handleUpdate.mockRejectedValue(new Error("boom"));

    const req = { body: { update_id: 1 } } as unknown as VercelRequest;
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });
});
