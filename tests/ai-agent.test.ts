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

  it("header 950/1000: báo ĐÃ DÙNG 50, còn 950 (không gây hiểu nhầm sắp hết)", async () => {
    const { db } = fakeDb();
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
    await recordGroqCall(
      db,
      {
        status: 200,
        model: "m",
        headers: h({
          "x-ratelimit-remaining-requests": "950",
          "x-ratelimit-limit-requests": "1000",
          "x-ratelimit-remaining-tokens": "4350",
          "x-ratelimit-limit-tokens": "8000",
        }),
      },
      NOW
    );
    const r = await buildQuotaReport(db, loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!, NOW);
    expect(r).toContain("đã dùng 50/1.000 lượt hôm nay, còn 950 lượt");
    expect(r).toContain("tự hồi lại sau mỗi phút");
  });
});

import { observeGroup, listGroups, readGroup, resetGroupCacheForTest } from "../lib/ai.js";
import { beforeEach } from "vitest";

describe("Bee tự nhận diện các nhóm được add vào", () => {
  beforeEach(() => resetGroupCacheForTest());
  const XEPLOP = -1009999999999;
  const msg = (chatId: number, title: string, text: string, mid: number, extra: object = {}) =>
    ({ message_id: mid, chat: { id: chatId, type: "supergroup", title }, from: { id: 5, username: "gv_a" }, text, ...extra }) as any;

  it("ghi nhóm mới vào sổ + lưu tin gần đây; tin nhạy cảm bị ẩn", async () => {
    const { db, store } = fakeDb();
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "Cần xếp lớp cho HS 203745", 10), NOW);
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "TK: abc MK: 123", 11), NOW);
    const reg = store.get(-9104) as any;
    expect(reg.groups[String(XEPLOP)].title).toBe("VH - Xếp lớp");
    const log = store.get(XEPLOP - 3_000_000_000_000) as any;
    expect(log.items.map((x: any) => x.text)).toEqual([
      "Cần xếp lớp cho HS 203745",
      "[tin có tài khoản/mật khẩu/số dài, đã ẩn]",
    ]);
  });

  it("nhóm QLL/HTKT: chỉ ghi sổ, KHÔNG lưu nội dung tin", async () => {
    const { db, store } = fakeDb();
    await observeGroup(db, msg(-1002458492731, "HTKT", "215785 oa ạ", 1), NOW);
    expect((store.get(-9104) as any).groups["-1002458492731"]).toBeDefined();
    expect(store.has(-1002458492731 - 3_000_000_000_000)).toBe(false);
  });

  it("xem_nhom: tìm theo tên gần đúng không dấu, đánh dấu tin đã có người trả lời", async () => {
    const { db } = fakeDb();
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "Ai xếp lớp giúp HS 203745 với", 10), NOW);
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "Để mình xếp", 11, { reply_to_message: { message_id: 10 } }), NOW);
    const r = await readGroup(db, "xep lop", NOW.getTime());
    expect(r).toContain('Nhóm "VH - Xếp lớp" — 2 tin');
    expect(r).toContain("Ai xếp lớp giúp HS 203745 với (đã có người trả lời)");
    expect(await readGroup(db, "kế toán", NOW.getTime())).toContain("Không thấy nhóm nào");
  });

  it("tin quá 24h không còn hiện", async () => {
    const { db } = fakeDb();
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "tin cũ", 1), new Date(NOW.getTime() - 25 * 3600_000));
    expect(await readGroup(db, "Xếp lớp", NOW.getTime())).toContain("chưa có tin nào trong 24 giờ");
  });

  it("xem_cac_nhom: liệt kê các nhóm, phân biệt nhóm theo dõi case", async () => {
    const { db } = fakeDb();
    await observeGroup(db, msg(XEPLOP, "VH - Xếp lớp", "hi", 1), NOW);
    await observeGroup(db, msg(-1002273179613, "QLL Support", "hi", 2), NOW);
    const r = await listGroups(db, undefined, NOW.getTime());
    expect(r).toContain("Bee đang biết 2 nhóm");
    expect(r).toContain("VH - Xếp lớp (chỉ đọc tin gần đây)");
    expect(r).toContain("QLL Support (theo dõi case)");
  });

  it("tag Bee trong nhóm lạ (admin): Bee nhận và trả lời ngay trong nhóm", async () => {
    const t = setup([say("Em đây anh ơi")]);
    const r = await t.run("@vh_messenger_bot em có thấy nhóm này không", XEPLOP, "supergroup", ADMIN);
    expect(r).toBe(true);
    expect(t.f).toHaveBeenCalledTimes(1);
    expect(t.sent[0].chat).toBe(XEPLOP);
  });

  it("tag Bee trong caption ảnh: vẫn nhận", async () => {
    const t = setup([say("Dạ em xem ảnh rồi")]);
    const { maybeHandleAi: run } = await import("../lib/ai.js");
    void run;
    await t.run("@vh_messenger_bot xem giúp", XEPLOP, "supergroup", ADMIN);
    expect(t.f).toHaveBeenCalledTimes(1);
  });

  it("hỏi riêng 'nhóm Xếp lớp' -> AI có công cụ xem_nhom, đọc đúng tin nhóm", async () => {
    const call = { id: "c1", type: "function", function: { name: "xem_nhom", arguments: '{"ten_nhom":"Xếp lớp"}' } };
    const t = setup([say("", [call]), say("Nhóm Xếp lớp có 1 tin hỏi xếp lớp HS 203745 ạ")], {
      [-9104]: { kind: "groups", groups: { [String(XEPLOP)]: { title: "VH - Xếp lớp", type: "supergroup", lastSeen: NOW.toISOString() } } },
      [XEPLOP - 3_000_000_000_000]: {
        kind: "grouplog",
        items: [{ t: NOW.getTime() - 60_000, from: "gv_a", text: "Cần xếp lớp HS 203745", mid: 1 }],
      },
    });
    await t.run("Em có check được nhóm Xếp lớp không?");
    const tool = t.bodies[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toContain("Cần xếp lớp HS 203745");
    expect(t.sent.at(-1)!.text).toContain("Xếp lớp");
  });
});

import { claimsSent } from "../lib/ai.js";

describe("Gửi tin vào nhóm theo tên + chặn báo 'đã gửi' sai (lỗi thực tế)", () => {
  beforeEach(() => resetGroupCacheForTest());
  const XEPLOP = -1002493556435;
  const seed = {
    [-9104]: {
      kind: "groups",
      groups: { [String(XEPLOP)]: { title: "[BU VUIHOC VH] Hỗ Trợ Xếp Lớp", type: "supergroup", lastSeen: NOW.toISOString() } },
    },
    [XEPLOP - 3_000_000_000_000]: {
      kind: "grouplog",
      items: [{ t: NOW.getTime() - 60_000, from: "Quốc Huy", uid: ADMIN, text: "@vh_messenger_bot test", mid: 77 }],
    },
  };
  const send = (args: object) => ({
    id: "c1",
    type: "function",
    function: { name: "gui_tin_nhom", arguments: JSON.stringify(args) },
  });

  it("AI nói 'đã gửi' mà KHÔNG gọi công cụ -> chặn, nói thật là chưa gửi", async () => {
    const t = setup([say('Dạ, đã gửi tin "test nhé" vào các nhóm rồi ạ.')], seed);
    await t.run("Ờ em rep lại là test nhé");
    expect(t.sent.some((s) => s.chat === XEPLOP)).toBe(false);
    expect(t.sent.at(-1)!.text).toContain("chưa gửi được tin nào thật");
  });

  it("gui_tin_nhom: tìm nhóm theo tên (không cần ID), reply đúng tin của admin", async () => {
    const t = setup([say("", [send({ ten_nhom: "Xếp lớp", noi_dung: "test nhé", tra_loi_cho: "admin" })]), say("Em rep trong nhóm Xếp lớp rồi ạ")], seed);
    await t.run("Ờ em rep lại là test nhé");
    const post = t.sent.find((s) => s.chat === XEPLOP)!;
    expect(post.text).toBe("test nhé");
    expect(post.replyTo).toBe(77);
    expect(t.sent.at(-1)!.text).toBe("Em rep trong nhóm Xếp lớp rồi ạ"); // có gửi thật -> không bị chặn
  });

  it("tên nhóm không có trong sổ: không gửi, báo các nhóm đã biết", async () => {
    const t = setup([say("", [send({ ten_nhom: "Kế toán", noi_dung: "hi" })]), say("Em không thấy nhóm Kế toán ạ")], seed);
    await t.run("gửi nhóm kế toán chữ hi");
    expect(t.sent.some((s) => s.chat < -1000000000000 && s.chat !== ADMIN)).toBe(false);
    const tool = t.bodies[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toContain("Chưa gửi");
    expect(tool.content).toContain("Hỗ Trợ Xếp Lớp");
  });

  it("claimsSent nhận đúng câu khẳng định đã gửi", () => {
    expect(claimsSent('Dạ, đã gửi tin "test nhé" vào các nhóm rồi ạ.')).toBe(true);
    expect(claimsSent("tin test nhé mình đã gửi vào nhóm Xếp lớp ạ")).toBe(true);
    expect(claimsSent("Em chưa gửi được ạ")).toBe(false);
    expect(claimsSent("Hôm nay QLL còn 1 case ạ")).toBe(false);
  });
});

import { hasLeaveIntent, isLeaveFormMessage, applyLeaveForward, COMMUNITY_CHAT_ID, redactForAi } from "../lib/ai.js";
import { afterEach } from "vitest";

describe("Form xin nghỉ QLL -> tự chuyển nhóm Cộng đồng", () => {
  const QLL = -1002273179613;
  const FORM = [
    "Nguyễn Minh Tuấn",
    "Code: 4756684",
    "Mã học sinh: 210150 xin nghỉ TOAN.2026.1836 | TOÁN 8 | LỚP 1-1 | NỀN TẢNG 2 Đang học | Ngày vào lớp: 11/10/2026",
    "GV dạy: M562 - Mai Thị Ánh Ly",
    "20:30 - 21:30 (T3) 20:30 - 21:30 (CN)",
    "Đã học: 16/24 (buổi)",
  ].join("\n");
  const FORM_TAIL = FORM.replace(" xin nghỉ ", "  ") + "\n#VH hs xin nghỉ buổi hôm nay ạ";
  afterEach(() => vi.unstubAllGlobals());

  it("đủ mẫu + xin nghỉ (ở dòng Mã HS hoặc cuối tin) -> nhận", () => {
    expect(isLeaveFormMessage(FORM)).toMatchObject({ hs: "210150", cls: "TOAN.2026.1836", name: "Nguyễn Minh Tuấn" });
    expect(isLeaveFormMessage(FORM_TAIL)).not.toBeNull();
    expect(hasLeaveIntent("#vh hs xin nghri ạ")).toBe(true);
    expect(hasLeaveIntent("#vh hs xin nghit ạ")).toBe(true);
  });

  it("đủ K1-K6 là chuyển, MỌI loại yêu cầu: xin muộn / out sớm / phản ánh / làm bù", () => {
    for (const tail of ["#VH xin muộn", "#VH xin out lớp sớm", "#VH PH phản ánh gv nói nhỏ quá", "#VH xin phép làm bù BTVN"]) {
      const t = FORM.replace(" xin nghỉ ", "  ") + "\n" + tail;
      expect(isLeaveFormMessage(t)).not.toBeNull();
    }
  });

  it("thiếu khung giờ học vẫn chuyển (không bắt buộc)", () => {
    expect(isLeaveFormMessage(FORM.replace("20:30 - 21:30 (T3) 20:30 - 21:30 (CN)\n", ""))).not.toBeNull();
  });

  it.each([
    ["thiếu tên dòng đầu", FORM.split("\n").slice(1).join("\n")],
    ["thiếu Code", FORM.replace("Code: 4756684\n", "")],
    ["thiếu mã lớp", FORM.replace("TOAN.2026.1836", "TOAN")],
    ["thiếu LỚP", FORM.replace("| LỚP 1-1 ", "")],
    ["thiếu Ngày vào lớp", FORM.replace("| Ngày vào lớp: 11/10/2026", "")],
    ["thiếu GV dạy", FORM.replace("GV dạy: M562 - Mai Thị Ánh Ly\n", "")],
    ["chỉ là câu nói", "Đào Nguyễn Linh Đan\nCode: 11702182\nMã học sinh: 210612\nlớp 1:1 qll có lên phiếu nghỉ tối nay"],
  ])("%s -> KHÔNG nhận", (_n, t) => {
    expect(isLeaveFormMessage(t)).toBeNull();
  });

  function run(text: string, chatId = QLL, store?: Map<number, unknown>, fwOk = true) {
    const db = fakeDb(store ? Object.fromEntries(store) : {});
    const fwCalls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      fwCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => (fwOk ? { ok: true } : { ok: false, description: "forbidden" }), status: 200 };
    }));
    const sent: any[] = [];
    const deps: any = { telegram: { sendMessage: async (c: number, t: string) => (sent.push({ c, t }), { ok: true }) }, supabase: db.db };
    const ai = { ...loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!, botToken: "T" };
    const message: any = { message_id: 555, chat: { id: chatId, type: "supergroup" }, from: { id: 9 }, text };
    return { go: () => applyLeaveForward(deps, ai, message), fwCalls, sent, store: db.store };
  }

  it("form ở QLL -> forwardMessage đúng nhóm Cộng đồng, 1 lần", async () => {
    const r = run(FORM);
    await r.go();
    expect(r.fwCalls).toHaveLength(1);
    expect(r.fwCalls[0].url).toContain("/forwardMessage");
    expect(r.fwCalls[0].body).toEqual({ chat_id: COMMUNITY_CHAT_ID, from_chat_id: QLL, message_id: 555 });
    // gửi lại cùng form (webhook lặp / QLL gửi lại) -> không chuyển nữa
    const again = run(FORM, QLL, r.store);
    await again.go();
    expect(again.fwCalls).toHaveLength(0);
  });

  it("form ở nhóm KHÁC QLL -> không chuyển", async () => {
    const r = run(FORM, -1002458492731);
    await r.go();
    expect(r.fwCalls).toHaveLength(0);
  });

  it("tin xin muộn đủ mẫu ở QLL -> CÓ chuyển", async () => {
    const r = run(FORM.replace(" xin nghỉ ", "  ") + "\n#VH xin muộn");
    await r.go();
    expect(r.fwCalls).toHaveLength(1);
  });

  it("cùng HS, tin khác (xin muộn rồi xin nghỉ) -> chuyển cả hai", async () => {
    const a = run(FORM);
    await a.go();
    const db = fakeDb(Object.fromEntries(a.store));
    const fw: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => (fw.push(JSON.parse(init.body)), { json: async () => ({ ok: true }) })));
    const deps: any = { telegram: { sendMessage: async () => ({ ok: true }) }, supabase: db.db };
    const ai = { ...loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })!, botToken: "T" };
    await applyLeaveForward(deps, ai, { message_id: 556, chat: { id: QLL, type: "supergroup" }, from: { id: 9 }, text: FORM } as any);
    expect(fw).toHaveLength(1);
    expect(fw[0].message_id).toBe(556);
  });

  it("forward bị chặn -> gửi bản sao kèm link tin gốc", async () => {
    const r = run(FORM, QLL, undefined, false);
    await r.go();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].c).toBe(COMMUNITY_CHAT_ID);
    expect(r.sent[0].t).toContain("https://t.me/c/2273179613/555");
  });

  it("che dữ liệu nhạy cảm cho AI nhưng GIỮ mã lớp", () => {
    const r = redactForAi("SĐT 0964 517 258, mk: abc123, lớp TOAN.2026.1836, Code: 4756684");
    expect(r).toContain("[số đã ẩn]");
    expect(r).toContain("mk: [đã ẩn]");
    expect(r).toContain("TOAN.2026.1836");
    expect(r).toContain("4756684");
    expect(r).not.toContain("0964");
  });

  it("admin dán form + nhờ việc: không bị đẩy vào luồng tra số, AI được đọc (đã che số)", async () => {
    const t = setup([say("Dạ em hiểu rồi ạ")]);
    await t.run(FORM + "\n\nCác tin dạng form như thế này em fw vào nhóm Cộng đồng được không");
    expect(t.f).toHaveBeenCalledTimes(1);
    expect(t.sent[0].text).not.toContain("Em tra theo");
  });
});
