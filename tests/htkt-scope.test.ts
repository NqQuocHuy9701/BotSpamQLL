import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scopedCaseId, isForwarded } from "../lib/handler.js";
import { purgeOldPerformanceData } from "../lib/supabase.js";
import type { TelegramMessage } from "../lib/types.js";

const QLL = -1002273179613;
const HTKT = -1002458492731;

describe("scopedCaseId", () => {
  it("giữ nguyên message_id cho nhóm QLL (dương)", () => {
    expect(scopedCaseId(QLL, 139533)).toBe(139533);
  });

  it("đổi sang id ÂM phái sinh cho nhóm HTKT", () => {
    expect(scopedCaseId(HTKT, 139533)).toBe(-(139533 * 10 + 1));
  });

  it("QLL và HTKT KHÔNG bao giờ va chạm dù cùng message_id", () => {
    const mid = 42;
    expect(scopedCaseId(QLL, mid)).not.toBe(scopedCaseId(HTKT, mid));
    // QLL dương, HTKT âm.
    expect(scopedCaseId(QLL, mid)).toBeGreaterThan(0);
    expect(scopedCaseId(HTKT, mid)).toBeLessThan(0);
  });

  it("đảo ngược được id HTKT về message_id gốc", () => {
    const mid = 98765;
    const scoped = scopedCaseId(HTKT, mid); // -(mid*10+1)
    const recovered = (-scoped - 1) / 10;
    expect(recovered).toBe(mid);
  });
});

describe("isForwarded", () => {
  function msg(extra: Partial<TelegramMessage>): TelegramMessage {
    return {
      message_id: 1,
      date: 0,
      chat: { id: -1002458492731, type: "supergroup" },
      text: "#hths TCLC.2025.0002 ...",
      ...extra,
    } as TelegramMessage;
  }

  it("true khi có forward_origin (Bot API >= 7.0)", () => {
    expect(isForwarded(msg({ forward_origin: { type: "user" } }))).toBe(true);
  });

  it("true với field forward cũ (forward_date / forward_from)", () => {
    expect(isForwarded(msg({ forward_date: 123 }))).toBe(true);
    expect(isForwarded(msg({ forward_from: { id: 9 } }))).toBe(true);
    expect(isForwarded(msg({ forward_sender_name: "X" }))).toBe(true);
  });

  it("false với tin thường (không forward)", () => {
    expect(isForwarded(msg({}))).toBe(false);
  });
});

describe("purgeOldPerformanceData", () => {
  it("xóa shift_interactions > 2 ngày và qll_tracking > 3 ngày (lọc created_at)", async () => {
    const cutoffs: Record<string, string> = {};
    const deleted: Record<string, number> = {
      shift_interactions: 5,
      qll_tracking: 3,
    };
    const from = vi.fn((table: string) => ({
      delete: () => ({
        lt: (_col: string, v: string) => {
          cutoffs[table] = v;
          return {
            select: async () => ({
              data: Array.from({ length: deleted[table] ?? 0 }, (_, i) => ({
                message_id: i,
              })),
              error: null,
            }),
          };
        },
      }),
    }));
    const client = { from } as unknown as SupabaseClient;

    const now = new Date("2026-11-10T00:00:00.000Z");
    const res = await purgeOldPerformanceData(client, now);

    expect(res.ok).toBe(true);
    expect(res.interactions).toBe(5);
    expect(res.cases).toBe(3);
    // Cutoff shift_interactions = now - 2 ngày; qll_tracking = now - 3 ngày.
    expect(cutoffs["shift_interactions"]).toBe("2026-11-08T00:00:00.000Z");
    expect(cutoffs["qll_tracking"]).toBe("2026-11-07T00:00:00.000Z");
  });
});
