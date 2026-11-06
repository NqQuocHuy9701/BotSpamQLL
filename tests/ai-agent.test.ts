// Kiểm thử lớp hội thoại Bee bằng MOCK (không gọi Groq thật, không chạm DB thật).
import { describe, it, expect, vi } from "vitest";
import { maybeHandleAi, loadAiConfig } from "../lib/ai.js";

const ADMIN = 6532155675;
const NOW = new Date("2026-11-06T03:00:00Z"); // 10:00 giờ VN
const HISTORY_ROW = -9102;

// Supabase giả: lưu pending_batches theo admin_id, mọi truy vấn khác trả rỗng.
function fakeDb(seed: Record<number, unknown> = {}) {
  const store = new Map<number, unknown>(Object.entries(seed).map(([k, v]) => [Number(k), v]));
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: any = {
      select: () => chain,
      gte: () => chain,
      lt: () => chain,
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      in: () => chain,
      update: () => chain,
      delete: () => chain,
      eq: (k: string, v: unknown) => ((filters[k] = v), chain),
      maybeSingle: async () => {
        const id = filters.admin_id as number | undefined;
        return table === "pending_batches" && id !== undefined && store.has(id)
          ? { data: { items: store.get(id) }, error: null }
          : { data: null, error: null };
      },
      upsert: async (row: { admin_id: number; items: unknown }) => {
        if (table === "pending_batches") store.set(row.admin_id, row.items);
        return { error: null };
      },
      insert: async () => ({ error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: [], error: null, count: 0 }),
    };
    return chain;
  };
  return { db: { from } as any, store };
}

type FakeRes = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
function fakeFetch(queue: FakeRes[]) {
  const bodies: any[] = [];
  const f = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const r = queue.shift();
    if (!r) throw new Error("hết response giả");
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    };
  });
  return { f, bodies };
}
const say = (content: string, tool_calls?: unknown[]) => ({
  status: 200,
  body: { choices: [{ message: { content, tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
});

function setup(queue: FakeRes[], seed: Record<number, unknown> = {}) {
  const { db, store } = fakeDb(seed);
  const { f, bodies } = fakeFetch(queue);
  const sent: { chat: number; text: string }[] = [];
  const telegram: any = {
    sendMessage: vi.fn(async (chat: number, text: string) => (sent.push({ chat, text }), { ok: true })),
  };
  const ai = { ...loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!, fetchImpl: f as any };
  const deps: any = { telegram, supabase: db, ai };
  const run = (text: string, chatId = ADMIN, type = "private", fromId = ADMIN) =>
    maybeHandleAi(
      { message_id: 1, chat: { id: chatId, type }, from: { id: fromId }, text } as any,
      deps,
      [ADMIN],
      { now: NOW, rng: () => 0 }
    );
  return { run, f, bodies, sent, store };
}

const turns = (key: string, n: number, t = NOW.getTime() - 60_000) => ({
  kind: "history",
  byUser: {
    [key]: Array.from({ length: n }, (_, i) => ({
      t,
      role: i % 2 ? "assistant" : "user",
      content: `lượt ${i}`,
    })),
  },
});

describe("Nhóm A: TypeScript xử lý, KHÔNG gọi Groq", () => {
  it("yêu cầu nghiệp vụ khớp luật (ai đang trực)", async () => {
    const t = setup([]);
    expect(await t.run("ai đang trực")).toBe(true);
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent.length).toBe(1);
  });
  it("xã giao ngắn khi chưa có mạch hội thoại", async () => {
    const t = setup([]);
    await t.run("ok");
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent[0].text).not.toMatch(/^Dạ .* ạ$/);
  });
  it("hỏi Bee nhớ gì", async () => {
    const t = setup([]);
    await t.run("em nhớ được những gì rồi");
    expect(t.f).not.toHaveBeenCalled();
  });
  it("người không phải admin nhắn riêng: không xử lý", async () => {
    const t = setup([]);
    expect(await t.run("chào bee", 111, "private", 111)).toBe(false);
    expect(t.f).not.toHaveBeenCalled();
  });
});

describe("Nhóm B: cần AI, đúng 1 lượt hội thoại", () => {
  it("câu tự do: 1 lần gọi, trả lời tự nhiên, lưu ngữ cảnh", async () => {
    const t = setup([say("Hôm nay ổn anh ơi, chưa có gì gấp 😊")]);
    await t.run("hôm nay thế nào em");
    expect(t.f).toHaveBeenCalledTimes(1);
    expect(t.sent.map((s) => s.text)).toEqual(["Hôm nay ổn anh ơi, chưa có gì gấp 😊"]);
    expect(t.bodies[0].max_completion_tokens).toBe(300);
    const h = t.store.get(HISTORY_ROW) as any;
    expect(h.byUser[`${ADMIN}:${ADMIN}`].length).toBe(2);
  });
  it("'ok' giữa cuộc trò chuyện -> để AI hiểu theo mạch", async () => {
    const t = setup([say("Em gửi nhé")], { [HISTORY_ROW]: turns(`${ADMIN}:${ADMIN}`, 2) });
    await t.run("ok");
    expect(t.f).toHaveBeenCalledTimes(1);
  });
  it("chỉ gửi tối đa 6 lượt lịch sử", async () => {
    const t = setup([say("Dạ")], { [HISTORY_ROW]: turns(`${ADMIN}:${ADMIN}`, 10) });
    await t.run("còn nhóm kia thì sao");
    const roles = t.bodies[0].messages.map((m: any) => m.role);
    expect(roles.filter((r: string) => r !== "system").length).toBe(7); // 6 lịch sử + câu hiện tại
  });
  it("ngữ cảnh tách theo chat: lịch sử trong nhóm không lọt sang chat riêng", async () => {
    const t = setup([say("Dạ")], { [HISTORY_ROW]: turns(`-1002458492731:${ADMIN}`, 4) });
    await t.run("còn nhóm kia thì sao");
    expect(t.bodies[0].messages.length).toBe(2); // system + câu hiện tại
  });
  it("gọi công cụ rồi trả lời: 2 lần gọi, số liệu từ công cụ", async () => {
    const tool = { id: "c1", type: "function", function: { name: "xem_so_lieu", arguments: "{}" } };
    const t = setup([say("", [tool]), say("QLL với HTKT đều sạch case rồi ạ")]);
    await t.run("tình hình 2 nhóm sao em");
    expect(t.f).toHaveBeenCalledTimes(2);
    expect(t.bodies[1].messages.some((m: any) => m.role === "tool")).toBe(true);
    expect(t.sent.at(-1)!.text).toBe("QLL với HTKT đều sạch case rồi ạ");
  });
  it("bỏ markdown trong câu trả lời", async () => {
    const t = setup([say("Còn **1 case** HTKT ạ")]);
    await t.run("htkt sao rồi em");
    expect(t.sent[0].text).toBe("Còn 1 case HTKT ạ");
  });
});

describe("Lỗi & hạn mức: không gọi AI lặp lại, báo bận thân thiện", () => {
  const busy = /bận/;
  it("429 có Retry-After dài: không thử lại", async () => {
    const t = setup([{ status: 429, headers: { "retry-after": "30" } }]);
    await t.run("hôm nay thế nào em");
    expect(t.f).toHaveBeenCalledTimes(1);
    expect(t.sent[0].text).toMatch(busy);
  });
  it("429 không có Retry-After: không thử lại", async () => {
    const t = setup([{ status: 429 }]);
    await t.run("hôm nay thế nào em");
    expect(t.f).toHaveBeenCalledTimes(1);
  });
  it("5xx: thử lại đúng 1 lần", async () => {
    const t = setup([{ status: 503 }, { status: 503 }]);
    await t.run("hôm nay thế nào em");
    expect(t.f).toHaveBeenCalledTimes(2);
    expect(t.sent[0].text).toMatch(busy);
  });
  it("5xx rồi thành công", async () => {
    const t = setup([{ status: 500 }, say("Ổn rồi anh")]);
    await t.run("hôm nay thế nào em");
    expect(t.sent[0].text).toBe("Ổn rồi anh");
  });
  it("401 / 400: không thử lại", async () => {
    for (const status of [401, 400]) {
      const t = setup([{ status, body: { error: "x" } }]);
      await t.run("hôm nay thế nào em");
      expect(t.f).toHaveBeenCalledTimes(1);
      expect(t.sent[0].text).toMatch(busy);
    }
  });
  it("timeout / mất kết nối: không thử lại, không lỗi ra ngoài", async () => {
    const t = setup([new Error("The operation was aborted")]);
    expect(await t.run("hôm nay thế nào em")).toBe(true);
    expect(t.f).toHaveBeenCalledTimes(1);
    expect(t.sent[0].text).toMatch(busy);
  });
});
