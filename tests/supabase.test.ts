import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { insertLog } from "../lib/supabase.js";
import type { LogRecord } from "../lib/types.js";

const record: LogRecord = {
  created_at: "2023-11-14T22:13:20.000Z",
  qll_telegram_id: "1",
  qll_name: "QLL Boss",
  request_content: "Cho mình xin tài khoản",
  ctv_name: "CTV User",
  response_content: "TK: user / MK: pass",
  status: "Đã gửi Inbox",
};

function mockClient(insertImpl: () => Promise<unknown>): {
  client: SupabaseClient;
  insert: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn(insertImpl);
  const from = vi.fn(() => ({ insert }));
  return { client: { from } as unknown as SupabaseClient, insert, from };
}

describe("insertLog", () => {
  it("returns { ok: true } on a successful insert", async () => {
    const { client, from, insert } = mockClient(async () => ({ error: null }));
    const result = await insertLog(client, record);
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("bot_account_logs");
    expect(insert).toHaveBeenCalledWith(record);
  });

  it("returns { ok: false } when Supabase reports an error, without throwing", async () => {
    const { client } = mockClient(async () => ({
      error: { message: "insert failed" },
    }));
    const result = await insertLog(client, record);
    expect(result).toEqual({ ok: false, error: "insert failed" });
  });

  it("returns { ok: false } when the insert rejects, without throwing", async () => {
    const { client } = mockClient(async () => {
      throw new Error("network down");
    });
    const result = await insertLog(client, record);
    expect(result).toEqual({ ok: false, error: "network down" });
  });
});
