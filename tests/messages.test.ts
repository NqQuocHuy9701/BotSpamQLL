import { describe, expect, it } from "vitest";
import {
  SLA_TEMPLATES,
  URGENT_TEMPLATES,
  buildSlaReminder,
  buildUrgentReminder,
  cleanQllName,
  pickIndex,
} from "../lib/messages.js";

// rng trả lần lượt các giá trị cố định để test có kết quả xác định.
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[i++ % vals.length];
}

describe("mẫu câu", () => {
  it("đủ 8 câu SLA và 6 câu khẩn", () => {
    expect(SLA_TEMPLATES).toHaveLength(8);
    expect(URGENT_TEMPLATES).toHaveLength(6);
  });

  it("không có chữ 'ưu tiên', lời chào theo buổi hay thời gian chờ", () => {
    for (const t of [...SLA_TEMPLATES, ...URGENT_TEMPLATES]) {
      expect(t.toLowerCase()).not.toContain("ưu tiên");
      expect(t).not.toContain("Chào buổi");
      expect(t).not.toContain("phút");
    }
  });

  it("mọi câu render xong không còn placeholder, có đúng @username", () => {
    SLA_TEMPLATES.forEach((_, i) => {
      const { text } = buildSlaReminder({
        title: "chị",
        username: "vh_minhlt",
        qllName: "Thu Hảo",
        rng: () => i / SLA_TEMPLATES.length,
      });
      expect(text).not.toMatch(/[{}]/);
      expect(text).toContain("@vh_minhlt");
    });
    URGENT_TEMPLATES.forEach((_, i) => {
      const { text } = buildUrgentReminder({
        title: "anh",
        username: "@OP_HuyNQ5",
        qllName: "Vy Anh",
        rng: () => i / URGENT_TEMPLATES.length,
      });
      expect(text).not.toMatch(/[{}]/);
      expect(text).toContain("@OP_HuyNQ5");
      expect(text).not.toContain("@@");
    });
  });

  it("điền đúng danh xưng và tên QLL", () => {
    const { text } = buildSlaReminder({
      title: "chị",
      username: "vh_minhlt",
      qllName: "Thu Hảo",
      rng: () => 0, // câu 1
    });
    expect(text).toBe(
      "Dạ chị @vh_minhlt ơi, case của Thu Hảo đang chờ, chị hỗ trợ giúp em với ạ!"
    );
  });

  it("thiếu danh xưng -> 'anh/chị'", () => {
    const { text } = buildSlaReminder({ username: "x", qllName: "A", rng: () => 0 });
    expect(text.startsWith("Dạ anh/chị @x ơi")).toBe(true);
  });
});

describe("cleanQllName", () => {
  it("rỗng/null -> QLL", () => {
    expect(cleanQllName("")).toBe("QLL");
    expect(cleanQllName("   ")).toBe("QLL");
    expect(cleanQllName(null)).toBe("QLL");
    expect(cleanQllName(undefined)).toBe("QLL");
  });

  it("gọt khoảng trắng thừa", () => {
    expect(cleanQllName("  Thu   Hảo ")).toBe("Thu Hảo");
  });

  it("cắt gọn tên quá 30 ký tự", () => {
    const out = cleanQllName("Admin Support Ms. Minh Lý Rất Dài Tên Quá");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
  });
});

describe("pickIndex", () => {
  it("không trả lại chỉ số vừa dùng", () => {
    for (let avoid = 0; avoid < 8; avoid++) {
      for (let k = 0; k < 20; k++) {
        expect(pickIndex(8, avoid, () => k / 20)).not.toBe(avoid);
      }
    }
  });

  it("luôn nằm trong [0, count)", () => {
    for (let k = 0; k < 50; k++) {
      const i = pickIndex(6, undefined, () => k / 50);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(6);
    }
    expect(pickIndex(6, undefined, () => 0.999999)).toBeLessThan(6);
  });

  it("count <= 1 -> 0", () => {
    expect(pickIndex(1, 0)).toBe(0);
  });

  it("2 câu liên tiếp dùng avoidIndex không trùng nhau", () => {
    const rng = seq(0.5, 0.5);
    const a = buildSlaReminder({ username: "x", qllName: "A", rng });
    const b = buildSlaReminder({ username: "x", qllName: "A", rng, avoidIndex: a.index });
    expect(b.index).not.toBe(a.index);
  });
});
