import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCheckinList,
  maybeHandleCheckinCommand,
} from "../lib/monitor.js";
import type { TelegramClient } from "../lib/telegram.js";
import type { TelegramMessage } from "../lib/types.js";

// Mock supabase: loadMonitorConfig đọc pending_batches -9001.
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

// 01/11/2026 17:27 VN == 10:27 UTC -> ca CHIỀU.
const NOW_CHIEU = new Date("2026-11-01T10:27:00.000Z");
// 01/11/2026 09:00 VN == 02:00 UTC -> ca SÁNG.
const NOW_SANG = new Date("2026-11-01T02:00:00.000Z");

describe("buildCheckinList", () => {
  it("liệt kê CTV đã check-in của ca hiện tại (chiều)", async () => {
    const { client } = makeSupabase({
      ...BASE_CONFIG,
      ctvChieu: ["vh_trangnth20", "vh_minhlt"],
      ctvSang: ["nguoi_ca_sang"],
      ctvShiftDate: "2026-11-01",
    });
    const out = await buildCheckinList(client, NOW_CHIEU);
    expect(out).toContain("CHIỀU");
    expect(out).toContain("@vh_trangnth20");
    expect(out).toContain("@vh_minhlt");
    expect(out).toContain("Tổng: 2 CTV");
    // Không lẫn người của ca khác.
    expect(out).not.toContain("@nguoi_ca_sang");
  });

  it("chỉ lấy list của đúng ca hiện tại (sáng)", async () => {
    const { client } = makeSupabase({
      ...BASE_CONFIG,
      ctvSang: ["nguoi_ca_sang"],
      ctvChieu: ["vh_trangnth20"],
      ctvShiftDate: "2026-11-01",
    });
    const out = await buildCheckinList(client, NOW_SANG);
    expect(out).toContain("SÁNG");
    expect(out).toContain("@nguoi_ca_sang");
    expect(out).not.toContain("@vh_trangnth20");
  });

  it("coi như chưa ai check-in nếu list cũ khác ngày (đã reset)", async () => {
    const { client } = makeSupabase({
      ...BASE_CONFIG,
      ctvChieu: ["nguoi_hom_qua"],
      ctvShiftDate: "2026-10-31", // ngày hôm trước
    });
    const out = await buildCheckinList(client, NOW_CHIEU);
    expect(out).toContain("Chưa có ai check-in");
    expect(out).not.toContain("@nguoi_hom_qua");
  });

  it("báo trống khi ca hiện tại chưa có CTV", async () => {
    const { client } = makeSupabase({
      ...BASE_CONFIG,
      ctvChieu: [],
      ctvShiftDate: "2026-11-01",
    });
    const out = await buildCheckinList(client, NOW_CHIEU);
    expect(out).toContain("Chưa có ai check-in");
  });
});

function makeMsg(partial: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 123, type: "private" },
    from: { id: 6532155675, is_bot: false, first_name: "Admin" },
    text: "/checkin",
    ...partial,
  } as TelegramMessage;
}

describe("maybeHandleCheckinCommand", () => {
  const ADMIN_IDS = [6532155675];

  it("bỏ qua nếu không phải lệnh /checkin", async () => {
    const { client } = makeSupabase({ ...BASE_CONFIG, ctvShiftDate: "2026-11-01" });
    const send = vi.fn(async () => ({}));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const handled = await maybeHandleCheckinCommand(
      makeMsg({ text: "/baocao" }),
      telegram,
      client,
      ADMIN_IDS
    );
    expect(handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("nuốt lệnh (không gửi) nếu không phải admin", async () => {
    const { client } = makeSupabase({ ...BASE_CONFIG, ctvShiftDate: "2026-11-01" });
    const send = vi.fn(async () => ({}));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const handled = await maybeHandleCheckinCommand(
      makeMsg({ from: { id: 999, is_bot: false, first_name: "X" } }),
      telegram,
      client,
      ADMIN_IDS
    );
    expect(handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("nuốt lệnh nếu không phải chat riêng (nhóm)", async () => {
    const { client } = makeSupabase({ ...BASE_CONFIG, ctvShiftDate: "2026-11-01" });
    const send = vi.fn(async () => ({}));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const handled = await maybeHandleCheckinCommand(
      makeMsg({ chat: { id: -100, type: "supergroup" } }),
      telegram,
      client,
      ADMIN_IDS
    );
    expect(handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("admin chat riêng -> gửi danh sách", async () => {
    const { client } = makeSupabase({ ...BASE_CONFIG, ctvShiftDate: "2026-11-01" });
    const send = vi.fn(async () => ({}));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const handled = await maybeHandleCheckinCommand(makeMsg({}), telegram, client, ADMIN_IDS);
    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string];
    expect(call[0]).toBe(123);
    expect(call[1]).toContain("CTV đã check-in");
  });
});
