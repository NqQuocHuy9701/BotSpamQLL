import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countUnsent,
  enqueueMessages,
  fetchNextUnsent,
  markSent,
} from "../lib/supabase.js";
import type { SendQueueRow } from "../lib/types.js";

const ADMIN_ID = 6532155675;
const TARGET_GROUP = -1002273179613;

const ROWS = [
  { admin_id: ADMIN_ID, chat_id: TARGET_GROUP, message_text: "A" },
  { admin_id: ADMIN_ID, chat_id: TARGET_GROUP, message_text: "B" },
];

describe("enqueueMessages", () => {
  it("inserts the rows into send_queue and returns { ok: true }", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as SupabaseClient;

    const result = await enqueueMessages(client, ROWS);
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("send_queue");
    expect(insert).toHaveBeenCalledWith(ROWS);
  });

  it("short-circuits to { ok: true } on an empty array without inserting", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as SupabaseClient;

    expect(await enqueueMessages(client, [])).toEqual({ ok: true });
    expect(from).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns { ok: false } on a Supabase error without throwing", async () => {
    const insert = vi.fn(async () => ({ error: { message: "insert failed" } }));
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as SupabaseClient;

    expect(await enqueueMessages(client, ROWS)).toEqual({
      ok: false,
      error: "insert failed",
    });
  });
});

describe("fetchNextUnsent", () => {
  // Chain: select -> eq(sent,false) -> or(due-filter) -> order -> limit.
  function buildClient(result: { data: unknown; error: unknown }) {
    const limit = vi.fn(async () => result);
    const order = vi.fn(() => ({ limit }));
    const or = vi.fn((_filter: string) => ({ order }));
    const eq = vi.fn(() => ({ or }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return {
      client: { from } as unknown as SupabaseClient,
      from,
      select,
      eq,
      or,
      order,
      limit,
    };
  }

  it("selects due unsent rows ordered by created_at ascending with the limit", async () => {
    const rows: SendQueueRow[] = [
      { id: "1", admin_id: ADMIN_ID, chat_id: TARGET_GROUP, message_text: "A" },
      { id: "2", admin_id: ADMIN_ID, chat_id: TARGET_GROUP, message_text: "B" },
    ];
    const { client, from, select, eq, or, order, limit } = buildClient({
      data: rows,
      error: null,
    });

    const result = await fetchNextUnsent(client, 3);
    expect(result).toEqual({ ok: true, rows });
    expect(from).toHaveBeenCalledWith("send_queue");
    expect(select).toHaveBeenCalledWith("id, admin_id, chat_id, message_text");
    expect(eq).toHaveBeenCalledWith("sent", false);
    // Due filter: no schedule OR the scheduled time already arrived.
    expect(or).toHaveBeenCalledTimes(1);
    const orArg = or.mock.calls[0][0];
    expect(orArg.startsWith("send_after.is.null,send_after.lte.")).toBe(true);
    expect(order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(limit).toHaveBeenCalledWith(3);
  });

  it("coalesces null data to an empty rows array", async () => {
    const { client } = buildClient({ data: null, error: null });
    expect(await fetchNextUnsent(client, 3)).toEqual({ ok: true, rows: [] });
  });

  it("returns { ok: false, rows: [] } on error without throwing", async () => {
    const { client } = buildClient({
      data: null,
      error: { message: "select failed" },
    });
    expect(await fetchNextUnsent(client, 3)).toEqual({
      ok: false,
      rows: [],
      error: "select failed",
    });
  });
});

describe("markSent", () => {
  function buildClient(result: { error: unknown }) {
    const eq = vi.fn(async () => result);
    const update = vi.fn((_payload: { sent: boolean; sent_at: string }) => ({
      eq,
    }));
    const from = vi.fn(() => ({ update }));
    return {
      client: { from } as unknown as SupabaseClient,
      from,
      update,
      eq,
    };
  }

  it("updates sent=true + sent_at where id matches", async () => {
    const { client, from, update, eq } = buildClient({ error: null });
    const result = await markSent(client, "row-1");
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("send_queue");
    const payload = update.mock.calls[0][0];
    expect(payload.sent).toBe(true);
    expect(typeof payload.sent_at).toBe("string");
    expect(eq).toHaveBeenCalledWith("id", "row-1");
  });

  it("returns { ok: false } on error without throwing", async () => {
    const { client } = buildClient({ error: { message: "update failed" } });
    expect(await markSent(client, "row-1")).toEqual({
      ok: false,
      error: "update failed",
    });
  });
});

describe("countUnsent", () => {
  // The query chain is select -> eq(sent) and, when adminId is given, a second
  // eq(admin_id). The LAST eq in the chain must be awaitable (returns the
  // { count, error } result) AND still chainable for the admin filter case.
  function buildClient(result: { count: unknown; error: unknown }) {
    const eqSpy = vi.fn();
    const makeEq = () => {
      const eq = (...args: unknown[]) => {
        eqSpy(...args);
        const thenable = {
          eq,
          then: (
            resolve: (v: { count: unknown; error: unknown }) => unknown
          ) => resolve(result),
        };
        return thenable;
      };
      return eq;
    };
    const select = vi.fn(() => ({ eq: makeEq() }));
    const from = vi.fn(() => ({ select }));
    return {
      client: { from } as unknown as SupabaseClient,
      from,
      select,
      eqSpy,
    };
  }

  it("counts unsent rows (no admin filter)", async () => {
    const { client, from, select, eqSpy } = buildClient({
      count: 5,
      error: null,
    });
    const result = await countUnsent(client);
    expect(result).toEqual({ ok: true, count: 5 });
    expect(from).toHaveBeenCalledWith("send_queue");
    expect(select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(eqSpy).toHaveBeenCalledWith("sent", false);
    expect(eqSpy).toHaveBeenCalledTimes(1);
  });

  it("adds an admin_id filter when adminId is provided", async () => {
    const { client, eqSpy } = buildClient({ count: 0, error: null });
    const result = await countUnsent(client, ADMIN_ID);
    expect(result).toEqual({ ok: true, count: 0 });
    expect(eqSpy).toHaveBeenCalledWith("sent", false);
    expect(eqSpy).toHaveBeenCalledWith("admin_id", ADMIN_ID);
  });

  it("coalesces a null count to 0", async () => {
    const { client } = buildClient({ count: null, error: null });
    expect(await countUnsent(client)).toEqual({ ok: true, count: 0 });
  });

  it("returns { ok: false, count: 0 } on error without throwing", async () => {
    const { client } = buildClient({
      count: null,
      error: { message: "count failed" },
    });
    expect(await countUnsent(client)).toEqual({
      ok: false,
      count: 0,
      error: "count failed",
    });
  });
});
