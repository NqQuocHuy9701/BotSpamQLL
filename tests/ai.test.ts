import { describe, it, expect } from "vitest";
import {
  loadAiConfig,
  foldVi,
  classifyByRules,
  extractMention,
  sanitizeReply,
  parseGroqJson,
  maybeHandleAi,
  detectScope,
  extractCustomText,
  classifyMemory,
  extractNote,
} from "../lib/ai.js";

describe("loadAiConfig", () => {
  it("tắt mặc định / thiếu key", () => {
    expect(loadAiConfig({})).toBeUndefined();
    expect(loadAiConfig({ AI_ENABLED: "true" })).toBeUndefined();
    expect(loadAiConfig({ GROQ_API_KEY: "k" })).toBeUndefined();
  });
  it("bật khi đủ", () => {
    expect(loadAiConfig({ AI_ENABLED: "true", GROQ_API_KEY: "k" })).toBeDefined();
  });
});

describe("foldVi / classifyByRules", () => {
  it("bỏ dấu", () => {
    expect(foldVi("Báo cáo Đây")).toBe("bao cao day");
  });
  it("nhận ý định", () => {
    expect(classifyByRules(foldVi("cho mình báo cáo ca này"))).toBe("baocao");
    expect(classifyByRules(foldVi("còn case treo không"))).toBe("casetreo");
    expect(classifyByRules(foldVi("xyz abc"))).toBeNull();
  });
});

describe("detectScope / case tồn theo nhóm", () => {
  it("nhận đúng nhóm", () => {
    expect(detectScope(foldVi("gửi anh case tồn nhóm QLL"))).toBe("qll");
    expect(detectScope(foldVi("tồn nhóm HTKT"))).toBe("htkt");
    expect(detectScope(foldVi("case tồn"))).toBe("all");
    expect(classifyByRules(foldVi("tồn nhóm HTKT"))).toBe("casetreo");
    expect(classifyByRules(foldVi("gửi anh các case tồn nhóm QLL"))).toBe("casetreo");
  });
});

describe("hentag", () => {
  it("nhận câu dặn tag CTV ca chiều", () => {
    expect(classifyByRules(foldVi("đến ca chiều bee tag CTV ca chiều xử lý case tồn QLL"))).toBe("hentag");
    expect(classifyByRules(foldVi("sau 13h30 tag ctv ca chiều xử lý case tồn"))).toBe("hentag");
    expect(classifyByRules(foldVi("case tồn nhóm QLL"))).toBe("casetreo");
  });
});

describe("hentag (nói tắt)", () => {
  it("chiều tag ctv xử lý nhé", () => {
    expect(classifyByRules(foldVi("chiều tag ctv xử lý nhé"))).toBe("hentag");
  });
});

describe("nhacnhom", () => {
  it("nhắn nhóm", () => {
    expect(classifyByRules(foldVi("Nhắn nhóm HTKT"))).toBe("nhacnhom");
    expect(classifyByRules(foldVi("nhắc nhóm QLL xử lý nhé"))).toBe("nhacnhom");
    expect(classifyByRules(foldVi("gửi anh case tồn nhóm QLL"))).toBe("casetreo");
    expect(classifyByRules(foldVi("tag ctv ca chiều xử lý case tồn QLL"))).toBe("hentag");
  });
});

describe("câu nhắc tùy chỉnh", () => {
  it("lấy đúng câu admin đưa", () => {
    expect(extractCustomText("Đổi câu nhắc: Nhắn là dạ còn 1 case anh chị hỗ trợ nốt ạ")).toBe(
      "Dạ còn 1 case anh chị hỗ trợ nốt ạ"
    );
    expect(
      extractCustomText("Em nhắn trong nhóm HTKT đổi câu thành:  Dạ, còn 1 case anh chị hỗ trợ nốt ạ")
    ).toBe("Dạ, còn 1 case anh chị hỗ trợ nốt ạ");
    expect(extractCustomText("Nhắn nhóm HTKT")).toBe("");
    expect(classifyByRules(foldVi("Đổi câu nhắc: Nhắn là dạ còn 1 case"))).toBe("nhacnhom");
  });
});

describe("bộ nhớ lời dạy", () => {
  it("nhận đúng lệnh dạy/xem/quên, không nhầm 'nhờ'", () => {
    expect(classifyMemory("Bee nhớ: nhắc nhóm thì gọi là anh chị")).toBe("daynho");
    expect(classifyMemory("Từ giờ nhắc nhóm thì nói ngắn gọn thôi")).toBe("daynho");
    expect(classifyMemory("nhớ là luôn kèm số case")).toBe("daynho");
    expect(classifyMemory("Bee nhớ gì")).toBe("xemnho");
    expect(classifyMemory("em đã học những gì rồi")).toBe("xemnho");
    expect(classifyMemory("Bee quên số 2")).toBe("quennho");
    expect(classifyMemory("quên hết")).toBe("quennho");
    expect(classifyMemory("nhờ CTV ca chiều xử lý")).toBeNull();
    expect(classifyMemory("học sinh 203745 xin tk")).toBeNull();
    expect(classifyMemory("ai đang trực")).toBeNull();
  });
  it("lấy nội dung lời dạy", () => {
    expect(extractNote("Bee nhớ: nhắc nhóm thì gọi là anh chị")).toBe("nhắc nhóm thì gọi là anh chị");
    expect(extractNote("Từ giờ nhắc nhóm thì nói ngắn gọn")).toBe("Từ giờ nhắc nhóm thì nói ngắn gọn");
  });
});

describe("extractMention", () => {
  it("có tag", () => {
    const r = extractMention("@vh_messenger_bot ai đang trực?", "vh_messenger_bot");
    expect(r.mentioned).toBe(true);
    expect(r.question).toContain("ai đang trực");
  });
  it("không tag", () => {
    expect(extractMention("ai đang trực?", "vh_messenger_bot").mentioned).toBe(false);
  });
});

describe("sanitizeReply / parseGroqJson", () => {
  it("bỏ @ và link", () => {
    const s = sanitizeReply("chào @abc xem https://x.com/a nhé");
    expect(s).not.toContain("@");
    expect(s).not.toContain("http");
  });
  it("parse JSON", () => {
    expect(parseGroqJson('{"intent":"checkin","reply":"ok"}')?.intent).toBe("checkin");
    expect(parseGroqJson("không phải json")).toBeNull();
    expect(parseGroqJson(null)).toBeNull();
  });
});

describe("maybeHandleAi", () => {
  it("ai undefined → false, không động gì", async () => {
    const r = await maybeHandleAi(
      { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 1 }, text: "hi" } as any,
      { ai: undefined } as any,
      [1]
    );
    expect(r).toBe(false);
  });
});
