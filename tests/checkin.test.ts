import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCheckinForm, addCtvFromCheckin } from "../lib/monitor.js";

// Form check-in mẫu (như bot VHHS gửi). Giờ 17:27 -> ca chiều.
const FORM_CHIEU = [
  "✨ 📚 TEAM: VHHS",
  "━━━━━━━━━━━━━━━━",
  "📌 Check in",
  "🎟 Mã Ticket: TK-076F14",
  "👤 CTV: @VH_TrangNTH20",
  "⏰ Thời gian: 17:27 | 01/11/2026",
].join("\n");

describe("parseCheckinForm", () => {
  it("trích username + quy ca CHIỀU cho giờ 17:27", () => {
    expect(parseCheckinForm(FORM_CHIEU)).toEqual({
      username: "vh_trangnth20",
      shiftKey: "chieu",
    });
  });

  it("quy ca SÁNG cho giờ trước 13:30", () => {
    const form = FORM_CHIEU.replace("17:27", "08:15");
    expect(parseCheckinForm(form)?.shiftKey).toBe("sang");
  });

  it("quy ca TỐI cho giờ >= 17:30", () => {
    const form = FORM_CHIEU.replace("17:27", "17:30");
    expect(parseCheckinForm(form)?.shiftKey).toBe("toi");
    const form2 = FORM_CHIEU.replace("17:27", "19:05");
    expect(parseCheckinForm(form2)?.shiftKey).toBe("toi");
  });

  it("ranh giới 13:30 là CHIỀU (không phải sáng)", () => {
    const form = FORM_CHIEU.replace("17:27", "13:30");
    expect(parseCheckinForm(form)?.shiftKey).toBe("chieu");
  });

  it("bỏ qua form không có key VHHS", () => {
    const form = FORM_CHIEU.replace("TEAM: VHHS", "TEAM: KHAC");
    expect(parseCheckinForm(form)).toBeNull();
  });

  it("bỏ qua Check out", () => {
    const form = FORM_CHIEU.replace("Check in", "Check out");
    expect(parseCheckinForm(form)).toBeNull();
  });

  it("bỏ qua form thiếu CTV", () => {
    const form = FORM_CHIEU.replace("👤 CTV: @VH_TrangNTH20", "👤 CTV:");
    expect(parseCheckinForm(form)).toBeNull();
  });

  it("bỏ qua form thiếu giờ", () => {
    const form = FORM_CHIEU.replace("⏰ Thời gian: 17:27 | 01/11/2026", "⏰ Thời gian:");
    expect(parseCheckinForm(form)).toBeNull();
  });

  it("chấp nhận username không có @", () => {
    const form = FORM_CHIEU.replace("@VH_TrangNTH20", "VH_TrangNTH20");
    expect(parseCheckinForm(form)?.username).toBe("vh_trangnth20");
  });
});

// Mock supabase: loadMonitorConfig đọc pending_batches -9001; saveMonitorConfig upsert.
function makeSupabase(configItems: Record<string, unknown>) {
  const upsert = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { items: configItems }, error: null }),
          }),
        }),
        upsert,
      };
    }
    return {};
  });
  return { client: { from } as unknown as SupabaseClient, upsert };
}

const BASE_CONFIG = {
  sang: "HuyNQ5",
  chieu: "HuyNQ5",
  toi: "HuyNQ5",
  defaultDp: "HuyNQ5",
  ctvUsernames: [],
  ctvSang: [],
  ctvChieu: [],
  ctvToi: [],
  userTitles: {},
};

// Ngày VN cho "now": 01/11/2026 17:27 VN == 10:27 UTC.
const NOW = new Date("2026-11-01T10:27:00.000Z");

describe("addCtvFromCheckin", () => {
  it("thêm CTV vào đúng ca (chiều) và lưu config", async () => {
    const { client, upsert } = makeSupabase({ ...BASE_CONFIG, ctvShiftDate: "2026-11-01" });
    const handled = await addCtvFromCheckin(client, FORM_CHIEU, NOW);
    expect(handled).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0] as unknown as [{ items: { ctvChieu: string[] } }];
    expect(call[0].items.ctvChieu).toContain("vh_trangnth20");
  });

  it("reset toàn bộ list ca khi sang ngày mới", async () => {
    // Config cũ của ngày hôm trước, có người ở ctvToi.
    const { client, upsert } = makeSupabase({
      ...BASE_CONFIG,
      ctvToi: ["nguoi_cu"],
      ctvShiftDate: "2026-10-31",
    });
    await addCtvFromCheckin(client, FORM_CHIEU, NOW);
    const call = upsert.mock.calls[0] as unknown as [
      { items: { ctvToi: string[]; ctvChieu: string[]; ctvShiftDate: string } }
    ];
    const saved = call[0].items;
    // List cũ bị xoá, chỉ còn người check-in mới ở ca chiều.
    expect(saved.ctvToi).toEqual([]);
    expect(saved.ctvChieu).toEqual(["vh_trangnth20"]);
    expect(saved.ctvShiftDate).toBe("2026-11-01");
  });

  it("không thêm trùng nếu CTV đã có trong ca hôm nay", async () => {
    const { client, upsert } = makeSupabase({
      ...BASE_CONFIG,
      ctvChieu: ["vh_trangnth20"],
      ctvShiftDate: "2026-11-01",
    });
    await addCtvFromCheckin(client, FORM_CHIEU, NOW);
    // Đã có sẵn -> không cần lưu lại.
    expect(upsert).not.toHaveBeenCalled();
  });

  it("trả false và không lưu nếu không phải form check-in", async () => {
    const { client, upsert } = makeSupabase({ ...BASE_CONFIG });
    const handled = await addCtvFromCheckin(client, "tin nhắn thường", NOW);
    expect(handled).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
