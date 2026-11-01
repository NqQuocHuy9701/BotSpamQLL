import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCheckinList,
  getCurrentShiftCheckins,
  maybeHandleCheckinCommand,
} from "../lib/monitor.js";
import type { TelegramClient } from "../lib/telegram.js";
import type { TelegramMessage } from "../lib/types.js";

type CheckinRow = {
  username: string | null;
  loai?: string;
  team?: string;
  created_at: string | null;
};

// Mock client cho project checkin_logs. getCurrentShiftCheckins gọi:
//   .from("checkin_logs").select(...).eq("team","VHHS").eq("loai","Check in")
// Mock bỏ qua điều kiện team/loai ở tầng JS (giả định đã lọc), trả thẳng rows
// ta cấp -> nên rows ta cấp PHẢI là các dòng đã team=VHHS & loai=Check in.
function makeCheckinClient(rows: CheckinRow[]) {
  const from = vi.fn((table: string) => {
    if (table === "checkin_logs") {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (v: { data: CheckinRow[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    }
    return {};
  });
  return { client: { from } as unknown as SupabaseClient };
}

// 01/11/2026 các mốc giờ VN (bảng checkin_logs lưu giờ VN gắn +00:00).
const TS_TOI_2252 = "2026-11-01T22:52:13.000000+00:00"; // ca tối
const TS_TOI_2244 = "2026-11-01T22:44:33.000000+00:00"; // ca tối
const TS_CHIEU_1500 = "2026-11-01T15:00:00.000000+00:00"; // ca chiều
const TS_SANG_0900 = "2026-11-01T09:00:00.000000+00:00"; // ca sáng
const TS_HOMQUA_TOI = "2026-10-31T20:00:00.000000+00:00"; // tối hôm qua

// "now" cố định để quy ca xác định. getCurrentShiftVn cộng +7h vào now.
// 01/11/2026 20:00 VN == 13:00 UTC -> ca TỐI.
const NOW_TOI = new Date("2026-11-01T13:00:00.000Z");
// 01/11/2026 09:00 VN == 02:00 UTC -> ca SÁNG.
const NOW_SANG = new Date("2026-11-01T02:00:00.000Z");

describe("getCurrentShiftCheckins", () => {
  it("lấy CTV VHHS check-in ĐÚNG ca hiện tại (tối), dedupe", async () => {
    const { client } = makeCheckinClient([
      { username: "OP_HuyNQ5", created_at: TS_TOI_2252 },
      { username: "OP_HuyNQ5", created_at: TS_TOI_2244 }, // trùng -> 1 lần
      { username: "VH_MinhLT", created_at: TS_CHIEU_1500 }, // ca chiều -> loại
      { username: "VH_ThuNB", created_at: TS_SANG_0900 }, // ca sáng -> loại
    ]);
    const out = await getCurrentShiftCheckins(client, NOW_TOI);
    expect(out).toEqual(["op_huynq5"]);
  });

  it("loại check-in của NGÀY KHÁC (hôm qua)", async () => {
    const { client } = makeCheckinClient([
      { username: "OP_HuyNQ5", created_at: TS_HOMQUA_TOI }, // tối hôm qua
    ]);
    const out = await getCurrentShiftCheckins(client, NOW_TOI);
    expect(out).toEqual([]);
  });

  it("quy ca theo created_at (ca sáng)", async () => {
    const { client } = makeCheckinClient([
      { username: "VH_ThuNB", created_at: TS_SANG_0900 },
      { username: "OP_HuyNQ5", created_at: TS_TOI_2252 }, // tối -> loại khi now sáng
    ]);
    const out = await getCurrentShiftCheckins(client, NOW_SANG);
    expect(out).toEqual(["vh_thunb"]);
  });

  it("chuẩn hóa username bỏ @ + lowercase", async () => {
    const { client } = makeCheckinClient([
      { username: "@OP_HuyNQ5", created_at: TS_TOI_2244 },
    ]);
    const out = await getCurrentShiftCheckins(client, NOW_TOI);
    expect(out).toEqual(["op_huynq5"]);
  });
});

describe("buildCheckinList", () => {
  it("liệt kê CTV đã check-in ca hiện tại (tối)", async () => {
    const { client } = makeCheckinClient([
      { username: "OP_HuyNQ5", created_at: TS_TOI_2244 },
      { username: "VH_TrangNTH20", created_at: TS_TOI_2252 },
    ]);
    const out = await buildCheckinList(client, NOW_TOI);
    expect(out).toContain("TỐI");
    expect(out).toContain("@op_huynq5");
    expect(out).toContain("@vh_trangnth20");
    expect(out).toContain("Tổng: 2 CTV");
  });

  it("báo trống khi ca hiện tại chưa có ai", async () => {
    const { client } = makeCheckinClient([]);
    const out = await buildCheckinList(client, NOW_TOI);
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
    const { client } = makeCheckinClient([]);
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
    const { client } = makeCheckinClient([]);
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
    const { client } = makeCheckinClient([]);
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

  it("báo chưa cấu hình khi client check-in undefined", async () => {
    const send = vi.fn(async () => ({}));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    const handled = await maybeHandleCheckinCommand(
      makeMsg({}),
      telegram,
      undefined,
      ADMIN_IDS
    );
    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string];
    expect(call[1]).toContain("chưa được cấu hình");
  });

  it("admin chat riêng -> gửi danh sách", async () => {
    const { client } = makeCheckinClient([
      { username: "OP_HuyNQ5", created_at: TS_TOI_2244 },
    ]);
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
