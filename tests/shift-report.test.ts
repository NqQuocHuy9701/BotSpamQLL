import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import type { TelegramMessage } from "../lib/types.js";
import {
  buildShiftReport,
  recordCtvReply,
  maybeHandleReportCommand,
} from "../lib/monitor.js";

// 12:00 UTC == 19:00 giờ VN -> ca "toi" (Tối).
const NOW_TOI = new Date("2026-10-27T12:00:00.000Z");
const ADMIN_ID = 6532155675;
const GROUP_ID = -1002273179613;

// Config CTV ca: ca Tối gồm @vh_canhnt6, @vh_minhit.
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

// Builds a Supabase mock whose per-table behavior is driven by the given
// handlers. Only the chains actually used by the code under test are stubbed.
function makeSupabase(opts: {
  config?: unknown;
  caseExists?: boolean; // qll_tracking maybeSingle for recordCtvReply
  upsertSpy?: ReturnType<typeof vi.fn>;
  caseCount?: number; // qll_tracking count for buildShiftReport
  interactionRows?: { ctv_username: string }[]; // shift_interactions rows
}): SupabaseClient {
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      // loadMonitorConfig: .select("items").eq("admin_id",-9001).maybeSingle()
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
      const countResult = { count: opts.caseCount ?? 0, error: null };
      return {
        // recordCtvReply: .select("message_id").eq("message_id",x).maybeSingle()
        // buildShiftReport: .select(...,{count,head}).eq("shift_name",label).gte("created_at",iso)
        select: (_cols?: unknown, _o?: unknown) => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.caseExists ? { message_id: 1 } : null,
              error: null,
            }),
            // buildShiftReport now chains .gte(...) after .eq(...) for the count.
            gte: async () => countResult,
          }),
        }),
      };
    }
    if (table === "shift_interactions") {
      return {
        upsert: opts.upsertSpy ?? vi.fn(async () => ({ error: null })),
        // buildShiftReport: .select("ctv_username").eq().eq().eq()
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: async () => ({
                data: opts.interactionRows ?? [],
                error: null,
              }),
            }),
          }),
        }),
      };
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
    // Ghi đè theo case: conflict theo (chat_id,message_id,kind).
    expect(onConflict).toEqual({ onConflict: "chat_id,message_id,kind" });
  });

  it("does NOT record when the replier is not a CTV of this shift", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabase({ caseExists: true, upsertSpy: upsert });

    await recordCtvReply(supabase, {
      chatId: GROUP_ID,
      caseMessageId: 1,
      replierUsername: "nguoi_la", // không thuộc ctvToi
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
      now: NOW_TOI,
    });

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("buildShiftReport", () => {
  it("renders the shift header, per-CTV reply counts, and coverage %", async () => {
    const supabase = makeSupabase({
      caseCount: 4,
      interactionRows: [
        { ctv_username: "vh_canhnt6" },
        { ctv_username: "vh_canhnt6" },
        { ctv_username: "vh_minhit" },
      ],
    });

    const report = await buildShiftReport(supabase, NOW_TOI);

    expect(report).toContain("BÁO CÁO HIỆU SUẤT CA [TỐI] (17:30 - 21:30)");
    expect(report).toContain("Tổng số case phát sinh: 4");
    expect(report).toContain("@vh_canhnt6: 2 Reply");
    expect(report).toContain("@vh_minhit: 1 Reply");
    // 3 case có CTV reply / 4 tổng = 75%.
    expect(report).toContain("Tỷ lệ bao phủ: 75%");
  });

  it("handles zero cases without dividing by zero", async () => {
    const supabase = makeSupabase({ caseCount: 0, interactionRows: [] });
    const report = await buildShiftReport(supabase, NOW_TOI);
    expect(report).toContain("Tổng số case phát sinh: 0");
    expect(report).toContain("Tỷ lệ bao phủ: 0%");
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

    const handled = await maybeHandleReportCommand(
      privateMsg("/baocao"),
      telegram,
      supabase,
      [ADMIN_ID]
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
