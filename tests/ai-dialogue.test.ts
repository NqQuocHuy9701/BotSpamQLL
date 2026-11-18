import { describe, expect, it } from "vitest";
import { DIALOGUE_CONTINUITY_RULES, dialogueModeEnabled, validateAgentToolArguments } from "../lib/ai_dialogue.js";

describe("AI two-way dialogue hardening", () => {
  it("keeps enhanced dialogue behavior disabled unless explicitly enabled", () => {
    expect(dialogueModeEnabled({})).toBe(false);
    expect(dialogueModeEnabled({ AI_DIALOGUE_MODE_ENABLED: "true" })).toBe(true);
    expect(dialogueModeEnabled({ AI_DIALOGUE_MODE_ENABLED: "1" })).toBe(false);
    expect(DIALOGUE_CONTINUITY_RULES).toContain("không bắt họ nhắc lại yêu cầu từ đầu");
  });

  it("asks for missing required details before a data lookup or group action", () => {
    expect(validateAgentToolArguments("tra_cuu_case", {})).toContain("mã lớp");
    expect(validateAgentToolArguments("xem_ctv", { username: "" })).toContain("username CTV");
    expect(validateAgentToolArguments("gui_tin_nhom", { ten_nhom: "QLL" })).toContain("nội dung gì");
    expect(validateAgentToolArguments("nhan_nhom", { nhom: "unknown" })).toContain("QLL, HTKT");
    expect(validateAgentToolArguments("tag_ctv", { nhom: "all", usernames: ["vh_ok"] })).toContain("QLL hay HTKT");
  });

  it("accepts complete valid arguments and rejects malformed values rather than broadening scope", () => {
    expect(validateAgentToolArguments("tra_cuu_case", { tu_khoa: "HS203745" })).toBeNull();
    expect(validateAgentToolArguments("nhan_nhom", { nhom: "htkt" })).toBeNull();
    expect(validateAgentToolArguments("gui_tin_nhom", { ten_nhom: "QLL", noi_dung: "Nội dung cụ thể" })).toBeNull();
    expect(validateAgentToolArguments("tag_ctv", { nhom: "qll", usernames: ["@vh_ok"] })).toBeNull();
    expect(validateAgentToolArguments("nhan_nhom", { nhom: "HTKT" })).toContain("QLL, HTKT");
    expect(validateAgentToolArguments("quen", { so: -1 })).toContain("số thứ tự");
  });
});
