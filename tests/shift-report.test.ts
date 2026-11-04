import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import type { TelegramMessage } from "../lib/types.js";
import {
  buildShiftReport,
  recordCtvReply,
  recordCtvReaction,
  maybeHandleReportCommand,
} from "../lib/monitor.js";

// 12:00 UTC == 19:00 giờ VN -> ca "toi" (Tối).
const NOW_TOI = new Date("2026-10-27T12:00:00.000Z");
const ADMIN_ID = 6532155675;
const GROUP_ID = -1002273179613;

// Config CTV ca: ca Tối gồm @vh_canhnt6, @vh_minhit (dùng cho record* kiểm tra
// "CTV của ca" theo config — logic record KHÔNG đổi).
const CONFIG_ITEMS = {
  sang: "HuyNQ5",
  chieu: "HuyNQ5",
  toi: "HuyNQ5",
  defaultDp: "HuyNQ5",
  ctvUsernames: ["vh_canhnt6", "vh_minhit"],
  ctvSang: [],
  ctvChieu: [],
  ctvToi: ["vh_canhnt6", "vh_minhit"],
  userTitles: {},
};

type InteractionRow = { ctv_username: string; kind: string; message_id: number };

// Mock Supabase (project bot). interactionRows = toàn bộ dòng shift_interactions
// của ca (reply + react).
function makeSupabase(opts: {
  config?: unknown;
  caseExists?: boolean; // qll_tracking maybeSingle for record*
  upsertSpy?: ReturnType<typeof vi.fn>;
  caseCount?: number; // số case QLL (id > 0) cho buildShiftReport
  caseRows?: { message_id: number; content: string }[]; // ghi đè toàn bộ dòng case
  interactionRows?: InteractionRow[];
}): SupabaseClient {
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { items: opts.config ?? CONFIG_ITEMS },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "qll_tracking") {
      const caseRows =
        opts.caseRows ??
        Array.from({ length: opts.caseCount ?? 0 }, (_, i) => ({
          message_id: i + 1,
          content: `case ${i + 1}`,
        }));
      return {
        select: (_cols?: unknown, _o?: unknown) => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.caseExists ? { message_id: 1 } : null,
              error: null,
            }),
            gte: async () => ({ data: caseRows, error: null }),
          }),
        }),
      };
    }
    if (table === "shift_interactions") {
      return {
        upsert: opts.upsertSpy ?? vi.fn(async () => ({ error: null })),
        // buildShiftReport: .select("ctv_username, kind, message_id").eq().eq()
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: opts.interactionRows ?? [],
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
  return { from } as unknown as SupabaseClient;
}

// Mock client check-in: trả danh sách CTV ca hiện tại (getCurrentShiftCheckins
// dùng .from("checkin_logs").select().eq().eq().gte().lt().order()).
function makeCheckinClient(usernames: string[]): SupabaseClient {
  const rows = usernames.map((u, i) => ({
    username: u,
    // created_at ca tối (>=17:00) cùng ngày NOW_TOI (27/10/2026) giờ VN.
    created_at: `2026-10-27T19:0${i}:00.000000+00:00`,
  }));
  const from = vi.fn((table: string) => {
    if (table === "checkin_logs") {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lt: () => builder,
        order: () => builder,
        then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    }
    return {};
  });
  return { from } as unknown as SupabaseClient;
}

describe("recordCtvReply", () => {
  it("records a reply when the replier is a CTV of the current shift and the case exists", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });

    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      replierUsername: "vh_canhnt6",
      checkinClient: makeCheckinClient(["vh_canhnt6", "vh_minhit"]),
      now: NOW_TOI,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>
    ];
    const [row, onConflict] = call;
    expect(row).toMatchObject({
      chat_id: GROUP_ID,
      message_id: 1,
      ctv_username: "vh_canhnt6",
      kind: "reply",
      shift: "toi",
    });
    expect(onConflict).toEqual({ onConflict: "chat_id,message_id,kind" });
  });

  it("does NOT record when the replier is not in today's check-in list", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });
    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      replierUsername: "nguoi_la",
      checkinClient: makeCheckinClient(["vh_canhnt6", "vh_minhit"]), // không có nguoi_la
      now: NOW_TOI,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does NOT record when the replied-to message is not a tracked case", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: false, upsertSpy: upsert });
    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 999,
      replierUsername: "vh_canhnt6",
      checkinClient: makeCheckinClient(["vh_canhnt6"]),
      now: NOW_TOI,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does NOT record when the replier has no username", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });
    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      replierUsername: undefined,
      checkinClient: makeCheckinClient(["vh_canhnt6"]),
      now: NOW_TOI,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fail-soft: vẫn ghi khi KHÔNG có checkinClient (không chặn)", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });
    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      replierUsername: "bat_ky_ai",
      // không truyền checkinClient
      now: NOW_TOI,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("recordCtvReaction", () => {
  it("records a react (kind='react') for a CTV of the shift on a tracked case", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });

    await recordCtvReaction(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      reactorUsername: "vh_minhit",
      checkinClient: makeCheckinClient(["vh_canhnt6", "vh_minhit"]),
      now: NOW_TOI,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>
    ];
    const [row, onConflict] = call;
    expect(row).toMatchObject({
      chat_id: GROUP_ID,
      message_id: 1,
      ctv_username: "vh_minhit",
      kind: "react",
      shift: "toi",
    });
    expect(onConflict).toEqual({ onConflict: "chat_id,message_id,kind" });
  });

  it("does NOT record a react when case is not tracked", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: false, upsertSpy: upsert });
    await recordCtvReaction(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 999,
      reactorUsername: "vh_minhit",
      checkinClient: makeCheckinClient(["vh_minhit"]),
      now: NOW_TOI,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does NOT record a react when reactor not in check-in list", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });
    await recordCtvReaction(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      reactorUsername: "nguoi_la",
      checkinClient: makeCheckinClient(["vh_minhit"]),
      now: NOW_TOI,
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("buildShiftReport", () => {
  it("hiển thị React/Reply/Tổng mỗi CTV, chỉ CTV thuộc danh sách check-in", async () => {
    // vh_canhnt6: react tin 10 + reply tin 10 (cùng tin -> tổng 1) + reply tin 11
    //   => React 1, Reply 2, Tổng 2.
    // vh_minhit: react tin 20 => React 1, Reply 0, Tổng 1.
    // nguoi_la: có tương tác nhưng KHÔNG trong check-in -> bị loại.
    const supabase = makeSupabase({
      caseCount: 5,
      interactionRows: [
        { ctv_username: "vh_canhnt6", kind: "react", message_id: 10 },
        { ctv_username: "vh_canhnt6", kind: "reply", message_id: 10 },
        { ctv_username: "vh_canhnt6", kind: "reply", message_id: 11 },
        { ctv_username: "vh_minhit", kind: "react", message_id: 20 },
        { ctv_username: "nguoi_la", kind: "reply", message_id: 30 },
      ],
    });
    const checkin = makeCheckinClient(["vh_canhnt6", "vh_minhit"]);

    const report = await buildShiftReport(supabase, checkin, NOW_TOI);

    expect(report).toContain("BÁO CÁO HIỆU SUẤT CA [TỐI]");
    expect(report).toContain("CTV trong ca: 2");
    expect(report).toContain("Tổng số case phát sinh: 5");
    expect(report).toContain("@vh_canhnt6 — React: 1 | Reply: 2 | Tổng: 2");
    expect(report).toContain("@vh_minhit — React: 1 | Reply: 0 | Tổng: 1");
    // nguoi_la không thuộc check-in -> không xuất hiện.
    expect(report).not.toContain("@nguoi_la");
  });

  it("báo trống khi không có CTV check-in / không có tương tác", async () => {
    const supabase = makeSupabase({ caseCount: 0, interactionRows: [] });
    const checkin = makeCheckinClient([]);
    const report = await buildShiftReport(supabase, checkin, NOW_TOI);
    expect(report).toContain("Tổng số case phát sinh: 0");
    expect(report).toContain("CTV trong ca: 0");
    expect(report).toContain("Chưa có CTV nào React/Reply");
  });

  it("CTV check-in nhưng chưa tương tác -> không liệt kê (perCtv rỗng)", async () => {
    const supabase = makeSupabase({ caseCount: 3, interactionRows: [] });
    const checkin = makeCheckinClient(["vh_canhnt6"]);
    const report = await buildShiftReport(supabase, checkin, NOW_TOI);
    expect(report).toContain("CTV trong ca: 1");
    expect(report).toContain("Chưa có CTV nào React/Reply");
  });
});

describe("maybeHandleReportCommand", () => {
  function privateMsg(text: string, fromId = ADMIN_ID): TelegramMessage {
    return {
      message_id: 1,
      date: 0,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, first_name: "Admin" },
      text,
    };
  }

  it("replies the report to the admin on /baocao", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
    const telegram = { sendMessage } as unknown as TelegramClient;
    const supabase = makeSupabase({ caseCount: 1, interactionRows: [] });
    const checkin = makeCheckinClient([]);

    const handled = await maybeHandleReportCommand(
      privateMsg("/baocao"),
      telegram,
      supabase,
      [ADMIN_ID],
      checkin
    );

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(call[0]).toBe(ADMIN_ID);
    expect(String(call[1])).toContain("BÁO CÁO HIỆU SUẤT");
  });

  it("ignores non-/baocao text (returns false)", async () => {
    const sendMessage = vi.fn();
    const telegram = { sendMessage } as unknown as TelegramClient;
    const supabase = makeSupabase({});
    const handled = await maybeHandleReportCommand(
      privateMsg("hello"),
      telegram,
      supabase,
      [ADMIN_ID]
    );
    expect(handled).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("swallows /baocao from a non-admin without sending", async () => {
    const sendMessage = vi.fn();
    const telegram = { sendMessage } as unknown as TelegramClient;
    const supabase = makeSupabase({});
    const handled = await maybeHandleReportCommand(
      privateMsg("/baocao", 111),
      telegram,
      supabase,
      [ADMIN_ID]
    );
    expect(handled).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("buildShiftReport - tách QLL/HTKT + gộp mã trùng HTKT", () => {
  it("tách tổng case theo nhóm, HTKT gộp tin cùng mã", async () => {
    const supabase = makeSupabase({
      caseRows: [
        // QLL: 2 case (id dương), kể cả cùng nội dung vẫn là 2 tin riêng.
        { message_id: 101, content: "210049 xin tk" },
        { message_id: 102, content: "210049 xin tk" },
        // HTKT (id âm): "210049" x2 -> 1 case; "207671" -> 1; mã lớp x2 -> 1.
        { message_id: -11, content: "210049 oa" },
        { message_id: -21, content: "210049 oa ạ" },
        { message_id: -31, content: "207671 oa" },
        { message_id: -41, content: "TOAN.2025.1482 ạ" },
        { message_id: -51, content: "HS TOAN.2025.1482 out lớp" },
      ],
      interactionRows: [],
    });
    const report = await buildShiftReport(supabase, makeCheckinClient([]), NOW_TOI);
    expect(report).toContain("Tổng số case phát sinh: 5");
    expect(report).toContain("• QLL: 2");
    expect(report).toContain("• HTKT: 3 (đã gộp mã trùng)");
  });

  it("dòng CTV tách Tổng theo QLL/HTKT", async () => {
    const supabase = makeSupabase({
      caseCount: 1,
      interactionRows: [
        { ctv_username: "vh_canhnt6", kind: "react", message_id: 10 }, // QLL
        { ctv_username: "vh_canhnt6", kind: "reply", message_id: -11 }, // HTKT
        { ctv_username: "vh_canhnt6", kind: "react", message_id: -21 }, // HTKT
      ],
    });
    const report = await buildShiftReport(supabase, makeCheckinClient(["vh_canhnt6"]), NOW_TOI);
    expect(report).toContain(
      "@vh_canhnt6 — React: 2 | Reply: 1 | Tổng: 3 (QLL 1 · HTKT 2)"
    );
  });
});

describe("htktCaseKey", () => {
  it("ưu tiên mã lớp, không phân biệt hoa thường", async () => {
    const { htktCaseKey } = await import("../lib/monitor.js");
    expect(htktCaseKey("#hths MOET.2025.0815 bot gọi bạn Vương")).toBe("MOET.2025.0815");
    expect(htktCaseKey("moet_th.2025.0221, bạn Bảo thoát lớp")).toBe("MOET_TH.2025.0221");
  });

  it("không có mã lớp thì lấy dãy số đầu >= 3 chữ số", async () => {
    const { htktCaseKey } = await import("../lib/monitor.js");
    expect(htktCaseKey("210049 oa")).toBe("210049");
    expect(htktCaseKey("208231  oa ạ")).toBe("208231");
    expect(htktCaseKey("210049 oa")).not.toBe(htktCaseKey("207671 oa"));
  });
});
