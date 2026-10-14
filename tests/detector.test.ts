import { describe, expect, it } from "vitest";
import { isSensitive } from "../lib/detector.js";

describe("isSensitive — keyword variants", () => {
  const positives = [
    "TK",
    "tk",
    "MK",
    "Tài khoản",
    "TÀI KHOẢN",
    "tai khoan",
    "Mật khẩu",
    "mat khau",
    "TK:",
    "mk:",
    "TK: user01",
    "mk : 1234",
  ];

  for (const text of positives) {
    it(`detects keyword in "${text}"`, () => {
      expect(isSensitive(text)).toBe(true);
    });
  }
});

describe("isSensitive — 8+ digit numeric runs with separators", () => {
  const positives = [
    "01234567",
    "0123 456 789",
    "0123-456-789",
    "0123.456.789",
  ];

  for (const text of positives) {
    it(`detects long number in "${text}"`, () => {
      expect(isSensitive(text)).toBe(true);
    });
  }
});

describe("isSensitive — negatives", () => {
  const negatives = [
    "1234567", // only 7 digits
    "Chào bạn, hôm nay thế nào?", // plain chat
    "booktok is trending", // incidental t/k letters
    "milkman delivered", // incidental m/k letters
    "attack the problem", // contains "tk" letters inside a word
    "", // empty
  ];

  for (const text of negatives) {
    it(`does not flag "${text}"`, () => {
      expect(isSensitive(text)).toBe(false);
    });
  }
});
