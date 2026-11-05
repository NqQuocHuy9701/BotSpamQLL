import { describe, expect, it, vi } from "vitest";
import { handleUpdate, type Deps } from "../lib/handler.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramClient } from "../lib/telegram.js";
import type { MappedItem, TelegramUpdate } from "../lib/types.js";

const ADMIN = 6532155675; // nằm trong SPAMTEST_ADMIN_IDS

// Supabase mock CÓ STATE cho pending_batches (admin của ta) + telegram_users_qll
// (danh sách QLL để listKnownUsers). knownUsers có thể đổi giữa các bước để mô
// phỏng /adduser đã thêm QLL mới.
function makeEnv(opts: {
  pending: MappedItem[] | null;
  knownUsers: { username: string; full_name: string }[];
}) {
  let pending = opts.pending;
  const known = opts.knownUsers;
  const sendMessage = vi.fn(async () => ({ ok: true as const, messageId: 1 }));
  const enqueued: { message_text: string }[] = [];

  const from = vi.fn((table: string) => {
    if (table === "pending_batches") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: pending === null ? null : { items: pending },
              error: null,
            }),
            single: async () => ({
              data: pending === null ? null : { items: pending },
              error: null,
            }),
          }),
        }),
        upsert: async (row: { items?: MappedItem[] }) => {
          pending = row.items ?? [];
          return { error: null };
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "telegram_users_qll") {
      return {
        select: () => ({ data: known, error: null }),
      };
    }
    if (table === "send_queue") {
      return {
        insert: async (rows: { message_text: string }[]) => {
          enqueued.push(...rows);
          return { error: null };
        },
      };
    }
    return {};
  });

  const deps = {
    telegram: { sendMessage } as unknown as TelegramClient,
    supabase: { from } as unknown as SupabaseClient,
    relayEnabled: false,
  } as unknown as Deps;

  return {
    deps,
    sendMessage,
    enqueued,
    getPending: () => pending,
  };
}

function cmd(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: ADMIN, type: "private" },
      from: { id: ADMIN, first_name: "Admin" },
      text,
    },
  };
}

function lastText(send: ReturnType<typeof vi.fn>): string {
  const calls = send.mock.calls;
  return String((calls[calls.length - 1] as unknown as [number, string])[1]);
}

// 1 dòng đã map + 1 dòng chưa map (pending), cùng danh sách trước đó.
function seed(): MappedItem[] {
  return [
    {
      tenHS: "HS A",
      maLop: "TOAN.2025.0001",
      ngayHoc: "T2",
      lichHoc: "20:00",
      username: "sa_daco",
      qll: "Người Đã Map",
    },
    {
      tenHS: "HS B",
      maLop: "TOAN.2025.0002",
      ngayHoc: "T4",
      lichHoc: "20:00",
      username: "",
      pending: true,
      qll: "Nguyễn Khánh Uyên",
    },
  ];
}

describe("/remap", () => {
  it("map lại dòng pending bằng QLL mới thêm, không cần gửi file", async () => {
    const env = makeEnv({
      pending: seed(),
      // QLL mới đã được /adduser: Nguyễn Khánh Uyên -> SA_Uyennk86
      knownUsers: [{ username: "SA_Uyennk86", full_name: "Nguyễn Khánh Uyên" }],
    });

    await handleUpdate(cmd("/remap"), env.deps);

    const txt = lastText(env.sendMessage);
    expect(txt).toContain("Map lại: +1 dòng");
    const p = env.getPending()!;
    const uyen = p.find((it) => it.qll === "Nguyễn Khánh Uyên")!;
    expect(uyen.pending).toBeFalsy();
    expect(uyen.username).toBe("SA_Uyennk86");
  });

  it("còn QLL chưa thêm -> vẫn pending, báo còn thiếu", async () => {
    const env = makeEnv({ pending: seed(), knownUsers: [] });
    await handleUpdate(cmd("/remap"), env.deps);
    const txt = lastText(env.sendMessage);
    expect(txt).toContain("Nguyễn Khánh Uyên");
    const p = env.getPending()!;
    expect(p.find((it) => it.qll === "Nguyễn Khánh Uyên")!.pending).toBe(true);
  });

  it("danh sách đã map hết -> báo không còn gì để remap", async () => {
    const allMapped: MappedItem[] = [
      { tenHS: "A", maLop: "L1", ngayHoc: "T2", lichHoc: "20h", username: "sa_x", qll: "X" },
    ];
    const env = makeEnv({ pending: allMapped, knownUsers: [] });
    await handleUpdate(cmd("/remap"), env.deps);
    expect(lastText(env.sendMessage)).toContain("đã map hết");
  });

  it("không có danh sách chờ -> báo gửi file trước", async () => {
    const env = makeEnv({ pending: null, knownUsers: [] });
    await handleUpdate(cmd("/remap"), env.deps);
    expect(lastText(env.sendMessage)).toContain("Gửi file trước");
  });
});

describe("/ok khi còn dòng chưa map", () => {
  it("chỉ gửi dòng đã map, GIỮ dòng pending, báo bỏ qua", async () => {
    const env = makeEnv({ pending: seed(), knownUsers: [] });
    await handleUpdate(cmd("/ok"), env.deps);
    // Đã xếp hàng 1 tin (dòng đã map).
    expect(env.enqueued.length).toBe(1);
    expect(env.enqueued[0].message_text).toContain("@sa_daco");
    // Pending còn giữ dòng chưa map.
    const p = env.getPending()!;
    expect(p.length).toBe(1);
    expect(p[0].qll).toBe("Nguyễn Khánh Uyên");
    expect(lastText(env.sendMessage)).toContain("Bỏ qua 1 dòng CHƯA map");
  });
});
