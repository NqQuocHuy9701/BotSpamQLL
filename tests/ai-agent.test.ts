// Kiểm thử lớp hội thoại Bee bằng MOCK (không gọi Groq thật, không chạm DB thật).
import { describe, it, expect, vi } from "vitest";
import { maybeHandleAi, loadAiConfig } from "../lib/ai.js";

const ADMIN = 6532155675;
const NOW = new Date("2026-11-06T03:00:00Z"); // 10:00 giờ VN
const HISTORY_ROW = -9102;

// Supabase giả: lưu pending_batches theo admin_id, mọi truy vấn khác trả rỗng.
function fakeDb(seed: Record<number, unknown> = {}, tableRows: Record<string, unknown[]> = {}) {
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
      ilike: () => chain,
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
      then: (res: (v: unknown) => unknown) => res({ data: tableRows[table] ?? [], error: null, count: 0 }),
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

function setup(
  queue: FakeRes[],
  seed: Record<number, unknown> = {},
  tableRows: Record<string, unknown[]> = {}
) {
  const { db, store } = fakeDb(seed, tableRows);
  const { f, bodies } = fakeFetch(queue);
  const sent: { chat: number; text: string; replyTo?: number }[] = [];
  const telegram: any = {
    sendMessage: vi.fn(
      async (chat: number, text: string, replyTo?: number) => (sent.push({ chat, text, replyTo }), { ok: true })
    ),
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

describe("Hiệu ứng 'đang nhập...' khi chờ AI", () => {
  function setupTyping(queue: FakeRes[], botToken?: string) {
    const typing = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", typing);
    const t = setup(queue);
    const { db } = fakeDb();
    const { f } = fakeFetch(queue);
    const sent: string[] = [];
    const deps: any = {
      telegram: { sendMessage: async (_c: number, text: string) => (sent.push(text), { ok: true }) },
      supabase: db,
      ai: { ...loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!, fetchImpl: f as any, botToken },
    };
    const run = (text: string) =>
      maybeHandleAi(
        { message_id: 1, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN }, text } as any,
        deps,
        [ADMIN],
        { now: NOW, rng: () => 0 }
      );
    void t;
    return { run, typing, f, sent };
  }

  it("có token: gửi sendChatAction typing đúng chat trước khi gọi AI", async () => {
    const t = setupTyping([say("Ổn anh ơi")], "TOKEN");
    await t.run("hôm nay thế nào em");
    expect(t.typing).toHaveBeenCalled();
    const [url, init] = t.typing.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/botTOKEN/sendChatAction");
    expect(JSON.parse(init.body)).toEqual({ chat_id: ADMIN, action: "typing" });
    expect(t.f).toHaveBeenCalledTimes(1); // không ảnh hưởng số lần gọi Groq
    vi.unstubAllGlobals();
  });
  it("câu xử lý bằng TypeScript (không gọi AI): không typing", async () => {
    const t = setupTyping([], "TOKEN");
    await t.run("ai đang trực");
    expect(t.typing).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("không có token: không typing, vẫn trả lời bình thường", async () => {
    const t = setupTyping([say("Ổn anh ơi")]);
    await t.run("hôm nay thế nào em");
    expect(t.typing).not.toHaveBeenCalled();
    expect(t.sent).toEqual(["Ổn anh ơi"]);
    vi.unstubAllGlobals();
  });
});

describe("Nhiều vấn đề hơn: công cụ chỉ đọc mới", () => {
  const call = (name: string, args: object) => ({
    id: "c1",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });

  it("AI được cấp đủ công cụ mới", async () => {
    const t = setup([say("Dạ")]);
    await t.run("hôm nay thế nào em");
    const names = t.bodies[0].tools.map((x: any) => x.function.name);
    expect(names).toEqual(expect.arrayContaining(["tra_cuu_case", "xem_ctv", "xem_cau_hinh"]));
  });

  for (const [name, args, expectText] of [
    ["tra_cuu_case", { tu_khoa: "TOAN.2026.1517" }, "Không tìm thấy case"],
    ["xem_ctv", { username: "@vh_minhlt" }, "vh_minhlt chưa có lượt"],
    ["xem_cau_hinh", {}, "Điều phối:"],
  ] as const) {
    it(`${name}: chạy công cụ, gửi kết quả cho AI viết câu trả lời`, async () => {
      const t = setup([say("", [call(name, args)]), say("Xong ạ")]);
      await t.run("cho anh hỏi chút");
      expect(t.f).toHaveBeenCalledTimes(2);
      const toolMsg = t.bodies[1].messages.find((m: any) => m.role === "tool");
      expect(toolMsg.content).toContain(expectText);
      expect(t.sent.at(-1)!.text).toBe("Xong ạ");
    });
  }

  it("prompt cho phép việc chung (soạn tin, trả lời phụ huynh) thay vì từ chối", async () => {
    const t = setup([say("Anh có thể nhắn: ...")]);
    await t.run("soạn giúp anh tin xin lỗi phụ huynh vì trả lời chậm");
    expect(t.bodies[0].messages[0].content).toMatch(/phụ huynh/);
    expect(t.f).toHaveBeenCalledTimes(1);
  });
});

describe("Tin có số điện thoại / mật khẩu: không gửi lên AI", () => {
  it("admin tra SĐT: TypeScript tự tra DB, KHÔNG gọi Groq", async () => {
    const t = setup([]);
    await t.run("tra giúp anh case 0964517258");
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent[0].text).toContain("0964517258");
    expect(t.sent[0].text).toContain("Không tìm thấy case");
  });
  it("admin gửi TK/MK: không gọi Groq, nhắc nhẹ", async () => {
    const t = setup([]);
    await t.run("mk: abc123 tk: xyz");
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent.length).toBe(1);
  });
  it("người không phải admin trong nhóm: im lặng như cũ", async () => {
    const t = setup([]);
    const r = await t.run("@vh_messenger_bot số em 0964517258", -1002458492731, "supergroup", 222);
    expect(r).toBe(true);
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent.length).toBe(0);
  });
});

describe("Hiểu đúng ý: 'tag anh ý trong nhóm HTKT case 215785' (lỗi thực tế)", () => {
  const HTKT = -1002458492731;
  const KEY = `${ADMIN}:${ADMIN}`;
  // Mạch trước đó: admin vừa nhắc @vh_anhpd1.
  const ctx = {
    [HISTORY_ROW]: {
      kind: "history",
      byUser: {
        [KEY]: [
          { t: NOW.getTime() - 60_000, role: "user", content: "Anh này cơ mà @vh_anhpd1" },
          { t: NOW.getTime() - 60_000, role: "assistant", content: "Hôm nay vh_anhpd1 xử lý 15 case ạ" },
        ],
      },
    },
  };
  const caseRow = { message_id: -(149662 * 10 + 1), content: "215785 oa ạ" };
  const tagCall = {
    id: "c1",
    type: "function",
    function: {
      name: "tag_ctv",
      arguments: JSON.stringify({
        nhom: "htkt",
        usernames: ["vh_anhpd1"],
        ma_case: "215785",
        loi_nhan: "anh hỗ trợ giúp em case này nhé 😊",
      }),
    },
  };

  it("không đi luật 'nhắn nhóm' cứng; AI đọc được mạch có @vh_anhpd1", async () => {
    const t = setup([say("Anh ý là ai ạ?")], ctx, { qll_tracking: [caseRow] });
    await t.run("Em thử tag anh ý trong nhóm HTKT case 215785 đi");
    expect(t.f).toHaveBeenCalledTimes(1);
    const msgs = t.bodies[0].messages.map((m: any) => m.content).join("\n");
    expect(msgs).toContain("@vh_anhpd1");
    expect(t.sent.some((s) => s.chat === HTKT)).toBe(false); // không tự đăng tag cả ca
  });

  it("tag_ctv: chỉ tag đúng người, reply ngay dưới tin case 215785", async () => {
    const t = setup([say("", [tagCall]), say("Em tag anh vh_anhpd1 vào case đó rồi ạ")], ctx, {
      qll_tracking: [caseRow],
    });
    await t.run("Em thử tag anh ý trong nhóm HTKT case 215785 đi");
    const post = t.sent.find((s) => s.chat === HTKT)!;
    expect(post.text).toBe("@vh_anhpd1 anh hỗ trợ giúp em case này nhé 😊");
    expect(post.replyTo).toBe(149662);
    const tool = t.bodies[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toContain("ngay dưới tin case 215785");
    // câu báo lại admin không tag ai
    expect(t.sent.at(-1)!.text).not.toContain("@");
  });

  it("không tìm thấy case: vẫn tag đúng người, báo rõ là đăng tin riêng", async () => {
    const t = setup([say("", [tagCall]), say("Không thấy tin case nên em tag riêng ạ")], ctx);
    await t.run("tag anh ý case 215785 bên HTKT");
    const post = t.sent.find((s) => s.chat === HTKT)!;
    expect(post.replyTo).toBeUndefined();
    const tool = t.bodies[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toContain("không tìm thấy tin case");
  });

  it("username không hợp lệ: không đăng gì, bảo AI hỏi lại", async () => {
    const bad = { ...tagCall, function: { name: "tag_ctv", arguments: JSON.stringify({ nhom: "htkt", usernames: ["anh ý"], loi_nhan: "x" }) } };
    const t = setup([say("", [bad]), say("Anh ý là ai ạ?")], ctx);
    await t.run("tag anh ý giúp em");
    expect(t.sent.some((s) => s.chat === HTKT)).toBe(false);
  });

  it("lời Bee trả lời admin không tag ai (bỏ @)", async () => {
    const t = setup([say("Dạ, anh @vh_anhpd1 hôm nay xử lý 15 case ạ")]);
    await t.run("anh này cơ mà");
    expect(t.sent[0].text).toBe("Dạ, anh vh_anhpd1 hôm nay xử lý 15 case ạ");
  });

  it("câu xem đơn giản vẫn đi TypeScript (không tốn AI)", async () => {
    const t = setup([]);
    await t.run("case tồn nhóm HTKT");
    expect(t.f).not.toHaveBeenCalled();
  });
});

import { needsAiUnderstanding } from "../lib/ai.js";

describe("needsAiUnderstanding: câu nào phải để AI hiểu theo mạch", () => {
  it.each([
    ["nhacnhom", "Em thử tag anh ý trong nhóm HTKT case 215785 đi", true],
    ["casetreo", "case đó xử lý chưa em", true],
    ["casetreo", "còn bên kia thì sao", true],
    ["checkin", "anh ấy check-in chưa", true],
    ["casetreo", "case tồn nhóm HTKT", false],
    ["checkin", "ai đang trực", false],
    ["baocao", "báo cáo ca", false],
  ] as const)("%s | %s -> %s", (intent, q, expected) => {
    expect(needsAiUnderstanding(intent as any, q)).toBe(expected);
  });
});

import { shiftMoment } from "../lib/ai.js";

describe("Hỏi ca đã qua ('ca sáng nay có những ai làm') — lỗi 'Bee đang hơi bận'", () => {
  it("shiftMoment: hỏi ca sáng lúc 15:07 -> 10:00 sáng cùng ngày (giờ VN)", () => {
    const at1507 = new Date("2026-11-06T08:07:00Z"); // 15:07 VN
    expect(shiftMoment(at1507, "sang").toISOString()).toBe("2026-11-06T03:00:00.000Z");
    expect(shiftMoment(at1507, "toi").toISOString()).toBe("2026-11-06T12:00:00.000Z");
    expect(shiftMoment(at1507, undefined)).toBe(at1507);
  });

  it("công cụ báo cáo nhận tham số ca", async () => {
    const t = setup([say("Dạ")]);
    await t.run("hôm nay thế nào em");
    const tool = t.bodies[0].tools.find((x: any) => x.function.name === "xem_bao_cao_ca");
    expect(tool.function.parameters.properties.ca.enum).toEqual(["sang", "chieu", "toi"]);
  });

  it("AI gọi công cụ liên tục: vòng cuối buộc trả lời (tool_choice none), không báo bận", async () => {
    const c = (id: string, name: string, args: object = {}) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const t = setup([
      say("", [c("1", "xem_bao_cao_ca", { ca: "sang" })]),
      say("", [c("2", "xem_so_lieu")]),
      say("Ca sáng có minhlt và anhpd1 làm, QLL 20, HTKT 20 ạ"),
    ]);
    await t.run("Ca sáng nay có những ai làm thế em với số case 2 nhóm như thế nào");
    expect(t.f).toHaveBeenCalledTimes(3);
    expect(t.bodies[0].tool_choice).toBe("auto");
    expect(t.bodies[2].tool_choice).toBe("none");
    expect(t.sent.at(-1)!.text).toBe("Ca sáng có minhlt và anhpd1 làm, QLL 20, HTKT 20 ạ");
    expect(t.sent.some((s) => /bận/.test(s.text))).toBe(false);
  });
});

import { classifyByRules, foldVi, recordGroqCall, buildQuotaReport } from "../lib/ai.js";

describe("Hỏi Bee về credit/hạn mức", () => {
  const USAGE_ROW = -9103;

  it("nhận đúng câu hỏi hạn mức, không nhầm câu hỏi số lượt của CTV", () => {
    for (const q of ["bee còn bao nhiêu credit", "hạn mức groq sao rồi", "còn lượt ai không em", "check quota giúp anh"]) {
      expect(classifyByRules(foldVi(q))).toBe("hanmuc");
    }
    expect(classifyByRules(foldVi("minhlt bao nhiêu lượt reply"))).not.toBe("hanmuc");
  });

  it("admin hỏi credit: TypeScript trả lời, KHÔNG gọi Groq", async () => {
    const t = setup([]);
    await t.run("Bee còn bao nhiêu credit vậy em");
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent[0].text).toContain("Hạn mức hôm nay");
    expect(t.sent[0].text).toContain("Vercel, Supabase");
  });

  it("người không phải admin trong nhóm hỏi credit: từ chối, không lộ số", async () => {
    const t = setup([]);
    await t.run("@vh_messenger_bot còn bao nhiêu credit", -1002458492731, "supergroup", 222);
    expect(t.f).not.toHaveBeenCalled();
    expect(t.sent[0].text).toContain("chỉ báo cho admin");
  });

  it("mỗi lần gọi Groq được ghi sổ: token + header còn lại", async () => {
    const t = setup([
      {
        status: 200,
        body: { choices: [{ message: { content: "Ổn ạ" } }], usage: { prompt_tokens: 800, completion_tokens: 40 } },
        headers: {
          "x-ratelimit-remaining-requests": "990",
          "x-ratelimit-limit-requests": "1000",
          "x-ratelimit-remaining-tokens": "7100",
          "x-ratelimit-limit-tokens": "8000",
        },
      },
    ]);
    await t.run("hôm nay thế nào em");
    const u = t.store.get(USAGE_ROW) as any;
    expect(u).toMatchObject({ calls: 1, ok: 1, errors: 0, tokIn: 800, tokOut: 40, remReq: "990", remTok: "7100" });
  });

  it("429 được đếm vào sổ", async () => {
    const t = setup([{ status: 429 }]);
    await t.run("hôm nay thế nào em");
    expect(t.store.get(USAGE_ROW)).toMatchObject({ calls: 1, ok: 0, errors: 1, rate429: 1 });
  });

  it("báo cáo hạn mức đọc đúng sổ, sang ngày mới thì reset bộ đếm", async () => {
    const { db } = fakeDb();
    await recordGroqCall(db, { status: 200, model: "m", tokIn: 1000, tokOut: 100 }, NOW);
    await recordGroqCall(db, { status: 429, model: "m" }, NOW);
    const ai = loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!;
    const today = await buildQuotaReport(db, ai, NOW);
    expect(today).toContain("gọi 2 lần (thành công 1, lỗi 1, bị giới hạn 429: 1)");
    expect(today).toContain("1.100/200.000");
    const tomorrow = await buildQuotaReport(db, ai, new Date(NOW.getTime() + 24 * 3600_000));
    expect(tomorrow).toContain("gọi 0 lần");
  });
});
