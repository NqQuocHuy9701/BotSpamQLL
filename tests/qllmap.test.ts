import { describe, expect, it } from "vitest";
import {
  mapQll,
  mapQllByUser,
  nameToCore,
  normalize,
  usernameToCore,
  type KnownUser,
} from "../lib/qllmap.js";

// The fixed known-username list used across the mapping assertions. Mirrors a
// snapshot of telegram_users_qll's `username` column.
const KNOWN = [
  "SA_PhuongLTT3",
  "SA_LanNT18",
  "SAAnhPTH5",
  "SA_NgaNT23",
  "SA_NgocNT22",
  "SA_HaNH3",
  "OP_HuyNQ5",
];

describe("normalize", () => {
  it("strips diacritics and lowercases", () => {
    expect(normalize("Nguyễn")).toBe("nguyen");
    expect(normalize("Phương")).toBe("phuong");
  });

  it("maps đ/Đ to d", () => {
    expect(normalize("Đặng")).toBe("dang");
    expect(normalize("đỏ")).toBe("do");
  });

  it("removes non [a-z0-9] characters", () => {
    expect(normalize("A n-h_5!")).toBe("anh5");
  });
});

describe("nameToCore", () => {
  it("builds the worked example core", () => {
    // "Nguyễn Hải Hà 3": Tên "Hà"->"ha", initials "NH"->"nh", number "3".
    expect(nameToCore("Nguyễn Hải Hà 3")).toBe("hanh3");
  });

  it("handles a name with no trailing number", () => {
    // Tên "Hà"->"ha", initials "NH"->"nh", no number.
    expect(nameToCore("Nguyễn Hải Hà")).toBe("hanh");
  });

  it("handles a compound (multi-word) family part", () => {
    expect(nameToCore("Lưu Thị Thu Phương 3")).toBe("phuongltt3");
  });

  it("handles a single-token name (no family words)", () => {
    expect(nameToCore("Hà 7")).toBe("ha7");
    expect(nameToCore("Hà")).toBe("ha");
  });

  it("returns empty for an empty string", () => {
    expect(nameToCore("")).toBe("");
    expect(nameToCore("   ")).toBe("");
  });
});

describe("usernameToCore", () => {
  it("strips SA_ prefix", () => {
    expect(usernameToCore("SA_HaNH3")).toBe("hanh3");
  });

  it("strips a prefix with no underscore", () => {
    expect(usernameToCore("SAAnhPTH5")).toBe("anhpth5");
  });

  it("strips OP and VH prefixes", () => {
    expect(usernameToCore("OP_HuyNQ5")).toBe("huynq5");
    expect(usernameToCore("VH_LanNT18")).toBe("lannt18");
  });

  it("normalizes a username with no role prefix", () => {
    expect(usernameToCore("HaNH3")).toBe("hanh3");
  });
});

describe("mapQll — verified real pairs", () => {
  const pairs: [string, string][] = [
    ["Lưu Thị Thu Phương 3", "SA_PhuongLTT3"],
    ["Nông Thị Lan 18", "SA_LanNT18"],
    ["Phạm Thị Hải Anh 5", "SAAnhPTH5"],
    ["Nguyễn Thị Nga 23", "SA_NgaNT23"],
    ["Nguyễn Thị Ngọc 22", "SA_NgocNT22"],
    ["Nguyễn Hải Hà 3", "SA_HaNH3"],
  ];

  for (const [name, username] of pairs) {
    it(`maps "${name}" -> ${username}`, () => {
      expect(mapQll(name, KNOWN)).toEqual({ kind: "found", username });
    });
  }
});

describe("mapQll — negative and ambiguous", () => {
  it("returns notFound for a name not in the known list", () => {
    expect(mapQll("Trần Văn Khoa 9", KNOWN)).toEqual({ kind: "notFound" });
  });

  it("returns notFound for a blank name", () => {
    expect(mapQll("", KNOWN)).toEqual({ kind: "notFound" });
  });

  it("returns ambiguous when two known usernames share a core", () => {
    // Both normalize to core "hanh3".
    const known = ["SA_HaNH3", "HaNH3"];
    const result = mapQll("Nguyễn Hải Hà 3", known);
    expect(result).toEqual({
      kind: "ambiguous",
      candidates: ["SA_HaNH3", "HaNH3"],
    });
  });
});

describe("mapQllByUser — full-name match takes priority over the core rule", () => {
  const USERS: KnownUser[] = [
    // Registered manually: the username carries a trailing number ("86") the
    // name does not, so the derived-core rule alone would MISS this.
    { username: "SA_Uyennk86", full_name: "Nguyễn Khánh Uyên" },
    { username: "SA_HaNH3", full_name: "Ha Nguyen" },
  ];

  it("maps a registered full name to its username even when the core rule misses", () => {
    expect(mapQllByUser("Nguyễn Khánh Uyên", USERS)).toEqual({
      kind: "found",
      username: "SA_Uyennk86",
    });
  });

  it("matches the full name case- and diacritic-insensitively", () => {
    expect(mapQllByUser("nguyen khanh uyen", USERS)).toEqual({
      kind: "found",
      username: "SA_Uyennk86",
    });
  });

  it("falls back to the derived-core rule when no full name matches", () => {
    // "Nguyễn Hải Hà 3" has no full_name hit here (stored as "Ha Nguyen"),
    // so the core rule resolves it to SA_HaNH3 (core "hanh3").
    expect(mapQllByUser("Nguyễn Hải Hà 3", USERS)).toEqual({
      kind: "found",
      username: "SA_HaNH3",
    });
  });

  it("returns notFound when neither full name nor core matches", () => {
    expect(mapQllByUser("Trần Văn Lạ 9", USERS)).toEqual({ kind: "notFound" });
  });
});
