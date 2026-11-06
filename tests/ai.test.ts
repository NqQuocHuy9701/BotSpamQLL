import { describe, it, expect } from "vitest";
import {
  loadAiConfig,
  foldVi,
  classifyByRules,
  extractMention,
  sanitizeReply,
  parseGroqJson,
  maybeHandleAi,
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
