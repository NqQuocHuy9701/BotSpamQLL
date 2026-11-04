import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import { maybeSendShiftReports } from "../lib/monitor.js";

const ADMINS = [111, 222];

// Mock supabase. pending_batches.insert mô phỏng KHÓA CHÍNH admin_id: id đã có
// -> trả lỗi 23505 (giống Postgres). qll_tracking/shift_interactions phục vụ
// buildShiftReport. `claimed` có thể khởi tạo sẵn để mô phỏng ca đã gửi.
function makeSupabase(opts: { claimed?: number[]; insertError?: { code: string; message: string } } = {}) {
  const claimed = new Set<number>(opts.claimed ?? []);
  const insert = vi.fn(async (row: { admin_id: number }) => {
    if (opts.insertError) return { error: opts.insertError };
    if (claimed.has(row.admin_id)) {
      return { error: { code: "23505", message: "duplicate key" } };
    }
    claimed.add(row.admin_id);
    return { error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return { insert };
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
  return { client: { from } as unknown as SupabaseClient, insert, claimed };
}

// checkin client rỗng (không cần cho test mốc giờ / chống trùng).
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

function fakeTelegram() {
  const send = vi.fn(async () => ({ ok: true }));
  return { send, telegram: { sendMessage: send } as unknown as TelegramClient };
}

const AT_1200 = new Date("2026-11-02T05:00:00Z").getTime(); // 12:00 VN
const AT_1500 = new Date("2026-11-02T08:00:00Z").getTime(); // 15:00 VN
const AT_1700 = new Date("2026-11-02T10:00:00Z").getTime(); // 17:00 VN
const AT_2130 = new Date("2026-11-02T14:30:00Z").getTime(); // 21:30 VN

describe("maybeSendShiftReports - mốc cuối ca", () => {
  it("gửi báo cáo cuối ca TỐI lúc 21:30 VN cho tất cả admin + claim đúng id", async () => {
    const { client, insert } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_2130, makeCheckin());
    expect(send).toHaveBeenCalledTimes(2);
    const c0 = send.mock.calls[0] as unknown as [number, string];
    const c1 = send.mock.calls[1] as unknown as [number, string];
    expect(c0[0]).toBe(111);
    expect(c1[0]).toBe(222);
    expect(c0[1]).toContain("BÁO CÁO CUỐI CA");
    // claim id cho 02/11/2026 ca tối = -(20261102*10 + 3).
    const row = insert.mock.calls[0] as unknown as [{ admin_id: number }];
    expect(row[0].admin_id).toBe(-202611023);
  });

  it("gửi báo cáo cuối ca CHIỀU lúc 17:00 VN", async () => {
    const { client } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin());
    expect(send).toHaveBeenCalledTimes(2);
    const c = send.mock.calls[0] as unknown as [number, string];
    expect(c[1]).toContain("CHIỀU");
  });

  it("gửi báo cáo cuối ca SÁNG lúc 12:00 VN", async () => {
    const { client } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1200, makeCheckin());
    expect(send).toHaveBeenCalledTimes(2);
    const c = send.mock.calls[0] as unknown as [number, string];
    expect(c[1]).toContain("SÁNG");
  });

  it("KHÔNG gửi ngoài cửa sổ mốc cuối ca (15:00 VN) và không claim", async () => {
    const { client, insert } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1500, makeCheckin());
    expect(send).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("KHÔNG gửi nếu ca đã được claim trước đó", async () => {
    const { client } = makeSupabase({ claimed: [-202611023] });
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_2130, makeCheckin());
    expect(send).not.toHaveBeenCalled();
  });

  it("CHỐNG TRÙNG: 2 lần cron liên tiếp cùng mốc -> chỉ gửi 1 lần", async () => {
    const { client } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin());
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin());
    expect(send).toHaveBeenCalledTimes(2); // 1 ca x 2 admin
  });

  it("CHỐNG TRÙNG: 2 lần cron chạy ĐỒNG THỜI -> chỉ gửi 1 lần", async () => {
    const { client } = makeSupabase();
    const { send, telegram } = fakeTelegram();
    await Promise.all([
      maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin()),
      maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin()),
    ]);
    expect(send).toHaveBeenCalledTimes(2); // không phải 4
  });

  it("KHÔNG gửi khi claim lỗi DB (không phải 23505) để tránh trùng", async () => {
    const { client } = makeSupabase({ insertError: { code: "500", message: "db down" } });
    const { send, telegram } = fakeTelegram();
    await maybeSendShiftReports(telegram, client, ADMINS, AT_1700, makeCheckin());
    expect(send).not.toHaveBeenCalled();
  });
});
