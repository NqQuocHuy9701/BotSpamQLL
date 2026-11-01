import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import { checkUnansweredMessages } from "../lib/monitor.js";

const QLL_GROUP = -1002273179613;

// now cố định: 10:00 giờ VN (trong khung 7h-22h) = 03:00 UTC.
const NOW_IN_WINDOW = new Date("2026-11-02T03:00:00.000Z").getTime();
// 23:00 giờ VN (ngoài khung) = 16:00 UTC.
const NOW_LATE = new Date("2026-11-02T16:00:00.000Z").getTime();
// 05:00 giờ VN (trước 7h) = 22:00 UTC hôm trước.
const NOW_EARLY = new Date("2026-11-01T22:00:00.000Z").getTime();

// Mock supabase bot: qll_tracking trả 1 case quá hạn; update reported no-op.
// configItems: override cho loadMonitorConfig (vd slaExclude/slaExcludeDate).
function makeSupabase(
  expired: { message_id: number; created_at: string }[],
  configItems: Record<string, unknown> = { userTitles: { op_huynq5: "anh" } }
) {
  const update = vi.fn(() => ({ in: async () => ({ error: null }) }));
  const from = vi.fn((table: string) => {
    if (table === "qll_tracking") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              lte: async () => ({ data: expired, error: null }),
            }),
          }),
        }),
        update,
      };
    }
    if (table === "pending_batches") {
      // loadMonitorConfig
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { items: configItems },
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
  return { client: { from } as unknown as SupabaseClient, update };
}

// Mock client check-in trả danh sách CTV ca.
function makeCheckinClient(usernames: string[]): SupabaseClient {
  const rows = usernames.map((u, i) => ({
    username: u,
    created_at: `2026-11-02T10:0${i}:00.000000+00:00`, // 10:0x VN -> ca sáng
  }));
  const from = vi.fn((table: string) => {
    if (table === "checkin_logs") {
      const b = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        lt: () => b,
        order: () => b,
        then: (res: (v: { data: typeof rows; error: null }) => unknown) =>
          res({ data: rows, error: null }),
      };
      return b;
    }
    return {};
  });
  return { from } as unknown as SupabaseClient;
}

const EXPIRED = [{ message_id: 555, created_at: "2026-11-02T02:50:00.000Z" }];

describe("checkUnansweredMessages - khung giờ", () => {
  it("KHÔNG tag khi quá 22h (giờ VN)", async () => {
    const { client } = makeSupabase(EXPIRED);
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_LATE, makeCheckinClient(["op_huynq5"]));
    expect(send).not.toHaveBeenCalled();
  });

  it("KHÔNG tag khi trước 7h sáng (giờ VN)", async () => {
    const { client } = makeSupabase(EXPIRED);
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_EARLY, makeCheckinClient(["op_huynq5"]));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("checkUnansweredMessages - nguồn CTV = check-in", () => {
  it("tag CTV check-in khi trong khung giờ + có case quá hạn", async () => {
    const { client } = makeSupabase(EXPIRED);
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_IN_WINDOW, makeCheckinClient(["op_huynq5"]));
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string, number];
    expect(call[0]).toBe(QLL_GROUP);
    expect(call[1]).toContain("@op_huynq5");
    expect(call[2]).toBe(555); // reply vào đúng case
  });

  it("KHÔNG tag khi check-in RỖNG (không fallback điều phối viên)", async () => {
    const { client } = makeSupabase(EXPIRED);
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_IN_WINDOW, makeCheckinClient([]));
    expect(send).not.toHaveBeenCalled();
  });

  it("KHÔNG tag khi không có checkinClient", async () => {
    const { client } = makeSupabase(EXPIRED);
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_IN_WINDOW);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("checkUnansweredMessages - loai tru /slaoff", () => {
  it("KHÔNG tag CTV nằm trong slaExclude của hôm nay", async () => {
    // check-in có op_huynq5; slaExclude hôm nay có op_huynq5 -> còn rỗng -> ko tag.
    const { client } = makeSupabase(EXPIRED, {
      userTitles: { op_huynq5: "anh" },
      slaExclude: ["op_huynq5"],
      slaExcludeDate: "2026-11-02",
    });
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_IN_WINDOW, makeCheckinClient(["op_huynq5"]));
    expect(send).not.toHaveBeenCalled();
  });

  it("tag CTV còn lại sau khi loại trừ", async () => {
    // check-in có 2 người, loại 1 -> tag người còn lại (vh_minhlt).
    const { client } = makeSupabase(EXPIRED, {
      userTitles: {},
      slaExclude: ["op_huynq5"],
      slaExcludeDate: "2026-11-02",
    });
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(
      telegram,
      client,
      NOW_IN_WINDOW,
      makeCheckinClient(["op_huynq5", "vh_minhlt"])
    );
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string, number];
    expect(call[1]).toContain("@vh_minhlt");
    expect(call[1]).not.toContain("@op_huynq5");
  });

  it("slaExclude của NGÀY KHÁC bị bỏ qua (không loại trừ)", async () => {
    const { client } = makeSupabase(EXPIRED, {
      userTitles: { op_huynq5: "anh" },
      slaExclude: ["op_huynq5"],
      slaExcludeDate: "2026-10-30", // ngày cũ -> không áp dụng
    });
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await checkUnansweredMessages(telegram, client, NOW_IN_WINDOW, makeCheckinClient(["op_huynq5"]));
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string, number];
    expect(call[1]).toContain("@op_huynq5");
  });
});
