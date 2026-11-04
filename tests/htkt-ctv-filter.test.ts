import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { trackHtktCase, type Deps } from "../lib/handler.js";
import type { TelegramMessage } from "../lib/types.js";

const HTKT = -1002458492731;

function makeDeps() {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                items: {
                  ctvUsernames: ["vh_tienh1"],
                  ctvToi: ["@VH_VanTTT"],
                },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "qll_tracking") return { insert };
    return {};
  });
  const deps = {
    telegram: {},
    supabase: { from } as unknown as SupabaseClient,
    relayEnabled: false,
  } as unknown as Deps;
  return { deps, insert };
}

function msg(username: string, extra: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 500,
    date: 0,
    chat: { id: HTKT, type: "supergroup" },
    from: { id: 1, is_bot: false, first_name: "X", username },
    text: "210049 oa ạ",
    ...extra,
  };
}

describe("trackHtktCase - loại tin CTV", () => {
  it("người ngoài (không phải CTV) -> lưu case", async () => {
    const { deps, insert } = makeDeps();
    await trackHtktCase(msg("qll_yen"), deps);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("CTV vận hành (ctvUsernames) -> KHÔNG lưu", async () => {
    const { deps, insert } = makeDeps();
    await trackHtktCase(msg("VH_TienH1"), deps);
    expect(insert).not.toHaveBeenCalled();
  });

  it("CTV trực ca (ctvToi, có @) -> KHÔNG lưu", async () => {
    const { deps, insert } = makeDeps();
    await trackHtktCase(msg("vh_vanttt"), deps);
    expect(insert).not.toHaveBeenCalled();
  });

  it("CTV nhưng là tin FORWARD -> vẫn lưu", async () => {
    const { deps, insert } = makeDeps();
    await trackHtktCase(msg("vh_vanttt", { forward_date: 123 }), deps);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("tin không khớp rule -> không lưu", async () => {
    const { deps, insert } = makeDeps();
    await trackHtktCase(msg("qll_yen", { text: "ok cảm ơn ạ" }), deps);
    expect(insert).not.toHaveBeenCalled();
  });
});
