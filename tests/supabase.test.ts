import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deletePendingBatch,
  insertLog,
  listUsernames,
  loadPendingBatch,
  savePendingBatch,
} from "../lib/supabase.js";
import type { LogRecord, MappedItem } from "../lib/types.js";

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

const ADMIN_ID = 6532155675;
const ITEMS: MappedItem[] = [
  {
    tenHS: "Vũ Xuân Kỳ (SID: 189064)",
    maLop: "KHTN.2026.0913",
    ngayHoc: "15/10/2026",
    lichHoc: "T5 20:30-21:30",
    username: "SA_LanNT18",
  },
];

describe("savePendingBatch", () => {
  it("upserts into pending_batches with onConflict admin_id", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ upsert }));
    const client = { from } as unknown as SupabaseClient;

    const result = await savePendingBatch(client, ADMIN_ID, ITEMS);
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("pending_batches");
    expect(upsert).toHaveBeenCalledWith(
      { admin_id: ADMIN_ID, items: ITEMS },
      { onConflict: "admin_id" }
    );
  });

  it("returns { ok: false } on error without throwing", async () => {
    const upsert = vi.fn(async () => ({ error: { message: "upsert failed" } }));
    const from = vi.fn(() => ({ upsert }));
    const client = { from } as unknown as SupabaseClient;
    expect(await savePendingBatch(client, ADMIN_ID, ITEMS)).toEqual({
      ok: false,
      error: "upsert failed",
    });
  });
});

describe("loadPendingBatch", () => {
  function buildClient(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn(async () => result);
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return {
      client: { from } as unknown as SupabaseClient,
      from,
      select,
      eq,
    };
  }

  it("returns the items when a row exists", async () => {
    const { client, from, select, eq } = buildClient({
      data: { items: ITEMS },
      error: null,
    });
    const result = await loadPendingBatch(client, ADMIN_ID);
    expect(result).toEqual({ ok: true, items: ITEMS });
    expect(from).toHaveBeenCalledWith("pending_batches");
    expect(select).toHaveBeenCalledWith("items");
    expect(eq).toHaveBeenCalledWith("admin_id", ADMIN_ID);
  });

  it("returns items null when no row exists", async () => {
    const { client } = buildClient({ data: null, error: null });
    expect(await loadPendingBatch(client, ADMIN_ID)).toEqual({
      ok: true,
      items: null,
    });
  });

  it("returns { ok: false } on error", async () => {
    const { client } = buildClient({
      data: null,
      error: { message: "load failed" },
    });
    expect(await loadPendingBatch(client, ADMIN_ID)).toEqual({
      ok: false,
      items: null,
      error: "load failed",
    });
  });
});

describe("deletePendingBatch", () => {
  function buildClient(result: { error: unknown }) {
    const eq = vi.fn(async () => result);
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    return { client: { from } as unknown as SupabaseClient, from, del, eq };
  }

  it("deletes the admin's row", async () => {
    const { client, from, eq } = buildClient({ error: null });
    expect(await deletePendingBatch(client, ADMIN_ID)).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("pending_batches");
    expect(eq).toHaveBeenCalledWith("admin_id", ADMIN_ID);
  });

  it("returns { ok: false } on error", async () => {
    const { client } = buildClient({ error: { message: "delete failed" } });
    expect(await deletePendingBatch(client, ADMIN_ID)).toEqual({
      ok: false,
      error: "delete failed",
    });
  });
});

describe("listUsernames", () => {
  function buildClient(result: { data: unknown; error: unknown }) {
    const select = vi.fn(async () => result);
    const from = vi.fn(() => ({ select }));
    return { client: { from } as unknown as SupabaseClient, from, select };
  }

  it("returns usernames and drops null/empty values", async () => {
    const { client, from, select } = buildClient({
      data: [
        { username: "SA_LanNT18" },
        { username: null },
        { username: "" },
        { username: "SAAnhPTH5" },
      ],
      error: null,
    });
    const result = await listUsernames(client);
    expect(result).toEqual({
      ok: true,
      usernames: ["SA_LanNT18", "SAAnhPTH5"],
    });
    expect(from).toHaveBeenCalledWith("telegram_users_qll");
    expect(select).toHaveBeenCalledWith("username");
  });

  it("returns { ok: false, usernames: [] } on error", async () => {
    const { client } = buildClient({
      data: null,
      error: { message: "select failed" },
    });
    expect(await listUsernames(client)).toEqual({
      ok: false,
      usernames: [],
      error: "select failed",
    });
  });
});
