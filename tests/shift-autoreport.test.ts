import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import { maybeSendShiftReports } from "../lib/monitor.js";

const ADMINS = [111, 222];

// Mock supabase: loadMonitorConfig (pending_batches) + updateConfig
// (pending_batches .single() + upsert) + qll_tracking/shift_interactions cho
// buildShiftReport.
function makeSupabase(configItems: Record<string, unknown>) {
  const upsert = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { items: configItems }, error: null }),
            single: async () => ({ data: { items: configItems }, error: null }),
          }),
        }),
        upsert,
      };
    }
    if (table === "qll_tracking") {
      return {
        select: (_c?: unknown, _o?: unknown) => ({
          eq: () => ({ gte: async () => ({ count: 0, error: null }) }),
        }),
      };
    }
    if (table === "shift_interactions") {
      return {
        select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
      };
    }
    return {};
  });
  return { client: { from } as unknown as SupabaseClient, upsert };
}

// Mock CÓ STATE: upsert(items) merge vào state, maybeSingle/single trả state
// hiện tại. Dùng để mô phỏng 2 lần cron gọi liên tiếp (claim-then-send).
function makeStatefulSupabase(initial: Record<string, unknown>) {
  const state: Record<string, unknown> = { ...initial };
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { items: state }, error: null }),
            single: async () => ({ data: { items: state }, error: null }),
          }),
        }),
        upsert: async (row: { items?: Record<string, unknown> }) => {
          Object.assign(state, row.items ?? {});
          return { error: null };
        },
      };
    }
    if (table === "qll_tracking") {
      return {
        select: (_c?: unknown, _o?: unknown) => ({
          eq: () => ({ gte: async () => ({ count: 0, error: null }) }),
        }),
      };
    }
    if (table === "shift_interactions") {
      return {
        select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
      };
    }
    return {};
  });
  return { client: { from } as unknown as SupabaseClient };
}

// checkin client rỗng (không cần cho test mốc giờ / dedup).
function makeCheckin(): SupabaseClient {
  const from = vi.fn(() => {
    const b = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      lt: () => b,
      order: () => b,
      then: (res: (v: { data: never[]; error: null }) => unknown) =>
        res({ data: [], error: null }),
    };
    return b;
  });
  return { from } as unknown as SupabaseClient;
}

// Mốc giờ VN -> UTC ms. 21:30 VN = 14:30 UTC.
function vnMs(dateUtc: string): number {
  return new Date(dateUtc).getTime();
}

describe("maybeSendShiftReports - mốc cuối ca", () => {
  it("gửi báo cáo cuối ca TỐI lúc 21:30 VN cho tất cả admin", async () => {
    const { client, upsert } = makeSupabase({});
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    // 21:30 VN = 14:30 UTC ngày 2/11.
    await maybeSendShiftReports(telegram, client, ADMINS, vnMs("2026-11-02T14:30:00Z"), makeCheckin());
    expect(send).toHaveBeenCalledTimes(2); // 2 admin
    const c0 = send.mock.calls[0] as unknown as [number, string];
    const c1 = send.mock.calls[1] as unknown as [number, string];
    expect(c0[0]).toBe(111);
    expect(c1[0]).toBe(222);
    expect(c0[1]).toContain("BÁO CÁO CUỐI CA");
    // lưu dấu chống trùng.
    expect(upsert).toHaveBeenCalled();
  });

  it("KHÔNG gửi ngoài cửa sổ mốc cuối ca (vd 15:00 VN)", async () => {
    const { client } = makeSupabase({});
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await maybeSendShiftReports(telegram, client, ADMINS, vnMs("2026-11-02T08:00:00Z"), makeCheckin());
    expect(send).not.toHaveBeenCalled();
  });

  it("KHÔNG gửi lại nếu ca đã có lastShiftReportKey hôm nay", async () => {
    const { client } = makeSupabase({ lastShiftReportKey: "2026-11-02-toi" });
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await maybeSendShiftReports(telegram, client, ADMINS, vnMs("2026-11-02T14:30:00Z"), makeCheckin());
    expect(send).not.toHaveBeenCalled();
  });

  it("gửi báo cáo cuối ca CHIỀU lúc 17:00 VN (10:00 UTC)", async () => {
    const { client } = makeSupabase({});
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await maybeSendShiftReports(telegram, client, ADMINS, vnMs("2026-11-02T10:00:00Z"), makeCheckin());
    expect(send).toHaveBeenCalledTimes(2);
    const cc = send.mock.calls[0] as unknown as [number, string];
    expect(cc[1]).toContain("CHIỀU");
  });

  it("gửi báo cáo cuối ca SÁNG lúc 12:00 VN (05:00 UTC)", async () => {
    const { client } = makeSupabase({});
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await maybeSendShiftReports(telegram, client, ADMINS, vnMs("2026-11-02T05:00:00Z"), makeCheckin());
    expect(send).toHaveBeenCalledTimes(2);
    const cs = send.mock.calls[0] as unknown as [number, string];
    expect(cs[1]).toContain("SÁNG");
  });

  it("CHỐNG TRÙNG: 2 lần cron liên tiếp cùng mốc -> chỉ gửi 1 lần (claim-then-send)", async () => {
    const { client } = makeStatefulSupabase({});
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const at1700 = vnMs("2026-11-02T10:00:00Z"); // 17:00 VN -> ca chiều
    // Lần 1: gửi (2 admin) + claim key. Lần 2: thấy key -> không gửi.
    await maybeSendShiftReports(telegram, client, ADMINS, at1700, makeCheckin());
    await maybeSendShiftReports(telegram, client, ADMINS, at1700, makeCheckin());
    expect(send).toHaveBeenCalledTimes(2); // CHỈ 2 (1 ca x 2 admin), không phải 4
  });
});
