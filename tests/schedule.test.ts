import { describe, expect, it } from "vitest";
import { formatVnDateTime, parseOkCommand } from "../lib/schedule.js";

// A fixed "now" at 2025-06-15T03:00:00.000Z = 10:00 VN on 15 Jun 2025.
const NOW = new Date("2025-06-15T03:00:00.000Z");

describe("parseOkCommand — immediate /ok", () => {
  it("treats exact /ok as send-now", () => {
    expect(parseOkCommand("/ok", NOW)).toEqual({ kind: "now" });
  });

  it("is case-insensitive (/OK)", () => {
    expect(parseOkCommand("/OK", NOW)).toEqual({ kind: "now" });
  });

  it("tolerates trailing/leading whitespace", () => {
    expect(parseOkCommand("/ok   ", NOW)).toEqual({ kind: "now" });
    expect(parseOkCommand("  /ok  ", NOW)).toEqual({ kind: "now" });
  });
});

describe("parseOkCommand — HH:MM scheduling", () => {
  it("21:00 VN today -> 14:00 UTC same day (explicit −7h offset)", () => {
    const result = parseOkCommand("/ok 21:00", NOW);
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-06-15T14:00:00.000Z",
    });
  });

  it("rolls to tomorrow VN when the time already passed today", () => {
    // 10:00 VN now; 05:00 VN today already passed -> tomorrow.
    const result = parseOkCommand("/ok 05:00", NOW);
    // 05:00 VN on 16 Jun = 22:00 UTC on 15 Jun (previous UTC calendar day),
    // proving Date.UTC + ms rollover works across the midnight boundary.
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-06-15T22:00:00.000Z",
    });
  });

  it("accepts a single-digit hour (9:30 VN already passed -> tomorrow)", () => {
    // 9:30 VN = 02:30 UTC, before NOW (03:00 UTC), so it rolls to tomorrow VN.
    const result = parseOkCommand("/ok 9:30", NOW);
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-06-16T02:30:00.000Z",
    });
  });
});

describe("parseOkCommand — dd/mm HH:MM scheduling", () => {
  it("16/10 21:00 later this VN year -> current-year 14:00 UTC", () => {
    const result = parseOkCommand("/ok 16/10 21:00", NOW);
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-10-16T14:00:00.000Z",
    });
  });

  it("rolls to next year when the dated instant already passed", () => {
    // 01/01 00:00 of 2025 is long past relative to NOW -> 2026.
    const result = parseOkCommand("/ok 1/1 00:00", NOW);
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-12-31T17:00:00.000Z",
    });
  });

  it("tolerates extra internal whitespace", () => {
    const result = parseOkCommand("/ok   16/10   21:00", NOW);
    expect(result).toEqual({
      kind: "at",
      sendAfterIso: "2025-10-16T14:00:00.000Z",
    });
  });
});

describe("parseOkCommand — invalid inputs", () => {
  for (const bad of [
    "/ok abc",
    "/ok 9pm",
    "/ok 25:00",
    "/ok 21:60",
    "/ok 32/10 21:00",
    "/ok 16/13 21:00",
    "/ok 0/5 10:00",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const result = parseOkCommand(bad, NOW);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("formatVnDateTime", () => {
  it("renders a UTC instant as HH:MM dd/mm in VN time", () => {
    expect(formatVnDateTime("2025-06-15T14:00:00.000Z")).toBe("21:00 15/06");
  });

  it("rolls the VN date forward past midnight UTC", () => {
    // 22:00 UTC + 7h = 05:00 next day VN.
    expect(formatVnDateTime("2025-06-15T22:00:00.000Z")).toBe("05:00 16/06");
  });
});
