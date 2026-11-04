import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import type { TelegramMessage } from "../lib/types.js";
import { handleGroupQllMessage } from "../lib/monitor.js";
import { URGENT_TEMPLATES } from "../lib/messages.js";

const QLL = -1002273179613;

// Mock: pending_batches -9001 (config) / -9002 (watched), qll_tracking insert.
function makeSupabase() {
  const config = {
    sang: "OP_HuyNQ5",
    chieu: "OP_HuyNQ5",
    toi: "OP_HuyNQ5",
    defaultDp: "OP_HuyNQ5",
    ctvUsernames: ["vh_minhlt"],
    userTitles: { op_huynq5: "anh" },
  };
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: (_c: string, id: number) => ({
            maybeSingle: async () => ({
              data: { items: id === -9001 ? config : [] },
              error: null,
            }),
          }),
        }),
        upsert: async () => ({ error: null }),
      };
    }
    if (table === "qll_tracking") return { insert };
    return {};
  });
  return { client: { from } as unknown as SupabaseClient, insert };
}

function msg(text: string): TelegramMessage {
  return {
    message_id: 777,
    date: 0,
    chat: { id: QLL, type: "supergroup" },
    from: { id: 9001, is_bot: false, first_name: "Thu", last_name: "Hảo", username: "qll_thuhao" },
    text,
  };
}

describe("handleGroupQllMessage - tin khẩn v5", () => {
  it("tag điều phối bằng mẫu câu khẩn mới, điền tên QLL, reply đúng tin", async () => {
    const { client } = makeSupabase();
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await handleGroupQllMessage(msg("123456 hỗ trợ gấp giúp em"), telegram, client, QLL, [111]);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as unknown as [number, string, number];
    expect(call[0]).toBe(QLL);
    expect(call[2]).toBe(777); // reply đúng tin case
    expect(call[1]).toContain("@OP_HuyNQ5");
    expect(call[1]).not.toMatch(/[{}]/);
    expect(call[1]).not.toContain("cần hỗ trợ ạ !"); // câu cố định cũ đã thay
    const matched = URGENT_TEMPLATES.some((t) => {
      const re = new RegExp(
        "^" +
          t
            .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
            .replace(/\{title\}/g, "anh")
            .replace(/\{user\}/g, "OP_HuyNQ5")
            .replace(/\{qll\}/g, "Thu Hảo") +
          "$"
      );
      return re.test(call[1]);
    });
    expect(matched).toBe(true);
  });

  it("tin thường (không khẩn) KHÔNG tag điều phối", async () => {
    const { client } = makeSupabase();
    const send = vi.fn(async () => ({ ok: true }));
    const telegram = { sendMessage: send } as unknown as TelegramClient;
    await handleGroupQllMessage(msg("123456 cho em xin tk lớp này"), telegram, client, QLL, [111]);
    expect(send).not.toHaveBeenCalled();
  });
});
