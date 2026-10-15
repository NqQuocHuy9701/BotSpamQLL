import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildAnnouncement,
  buildGroupedAnnouncement,
  buildSummary,
  groupByUsername,
  parseSheet,
  subjectHashtag,
} from "../lib/batch.js";
import type { MappedItem } from "../lib/types.js";

// Builds an in-memory .xlsx buffer from an array-of-arrays (header + rows).
function makeXlsx(aoa: unknown[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseSheet", () => {
  it("parses the verbatim fixture rows, preserving a blank Lịch học", () => {
    // Header has a trailing space on "Tên " and an extra trailing column.
    const buf = makeXlsx([
      ["Tên ", "Mã lớp", "Ngày học", "QLL", "Lịch học", "Ghi chú"],
      [
        "Hoàng Đắc Anh Khoa (SID: 194448)",
        "KHTN.2026.0746",
        "15/10/2026",
        "Nguyễn Thị Quỳnh Trang 8",
        "T5 19:15-20:15",
        "x",
      ],
      [
        "Vũ Xuân Kỳ (SID: 189064)",
        "KHTN.2026.0913",
        "15/10/2026",
        "Nông Thị Lan 18",
        "T5 20:30-21:30",
        "",
      ],
      [
        "Đặng Mai Vy (SID: 213054)",
        "KHTN.2026.1972",
        "15/10/2026",
        "Phạm Thị Hải Anh 5",
        "",
        "",
      ],
    ]);

    const rows = parseSheet(buf);
    expect(rows).toHaveLength(3);

    expect(rows[0]).toEqual({
      tenHS: "Hoàng Đắc Anh Khoa (SID: 194448)",
      maLop: "KHTN.2026.0746",
      ngayHoc: "15/10/2026",
      qll: "Nguyễn Thị Quỳnh Trang 8",
      lichHoc: "T5 19:15-20:15",
    });
    expect(rows[1].qll).toBe("Nông Thị Lan 18");
    // Blank Lịch học preserved as "".
    expect(rows[2]).toEqual({
      tenHS: "Đặng Mai Vy (SID: 213054)",
      maLop: "KHTN.2026.1972",
      ngayHoc: "15/10/2026",
      qll: "Phạm Thị Hải Anh 5",
      lichHoc: "",
    });
  });

  it("skips rows with a blank QLL cell", () => {
    const buf = makeXlsx([
      ["Tên", "Mã lớp", "Ngày học", "QLL", "Lịch học"],
      ["A", "L1", "01/01/2026", "", "T2"],
      ["B", "L2", "02/01/2026", "Nông Thị Lan 18", "T3"],
    ]);
    const rows = parseSheet(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenHS).toBe("B");
  });

  it("returns [] for an empty workbook sheet", () => {
    const buf = makeXlsx([[]]);
    expect(parseSheet(buf)).toEqual([]);
  });

  it("finds the real header row when junk rows precede it (Column1.. placeholders)", () => {
    // Mirrors the real export: two junk rows, THEN the actual header, THEN data.
    const buf = makeXlsx([
      ["Column1", "Column2", "Column3", "Column4", "Column5"],
      ["Column1", "Column2", "Column3", "Column4", "Column5"],
      ["Tên ", "Mã lớp", "Ngày học", "QLL", "Lịch học"],
      ["Hoàng Đắc Anh Khoa (SID: 194448)", "KHTN.2026.0746", "15/10/2026", "Nguyễn Thị Quỳnh Trang 8", "T5 19:15-20:15"],
      ["Đặng Mai Vy (SID: 213054)", "KHTN.2026.1972", "15/10/2026", "Phạm Thị Hải Anh 5", ""],
    ]);
    const rows = parseSheet(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      tenHS: "Hoàng Đắc Anh Khoa (SID: 194448)",
      maLop: "KHTN.2026.0746",
      ngayHoc: "15/10/2026",
      qll: "Nguyễn Thị Quỳnh Trang 8",
      lichHoc: "T5 19:15-20:15",
    });
    expect(rows[1].lichHoc).toBe(""); // blank Lịch học preserved
  });
});

describe("subjectHashtag", () => {
  it("takes the first 4 chars of the class code", () => {
    expect(subjectHashtag("TOAN.2026.1176")).toBe("#TOAN");
    expect(subjectHashtag("MOET.2026.0533")).toBe("#MOET");
    expect(subjectHashtag("KHTN.2026.0746")).toBe("#KHTN");
  });

  it("handles an underscore-suffixed code (MOET_TH -> #MOET)", () => {
    expect(subjectHashtag("MOET_TH.2025.0104")).toBe("#MOET");
  });

  it("uppercases and trims", () => {
    expect(subjectHashtag("  toan.2026.1 ")).toBe("#TOAN");
  });

  it("returns '' when there is no usable leading code", () => {
    expect(subjectHashtag("")).toBe("");
    expect(subjectHashtag(".123")).toBe("");
  });
});

describe("buildAnnouncement", () => {
  const base: MappedItem = {
    tenHS: "Vũ Xuân Kỳ (SID: 189064)",
    maLop: "KHTN.2026.0913",
    ngayHoc: "15/10/2026",
    lichHoc: "T5 20:30-21:30",
    username: "SA_LanNT18",
  };

  it("builds the full form when Lịch học is present", () => {
    expect(buildAnnouncement(base)).toBe(
      [
        "✅ Thông tin học của con #KHTN",
        "Học sinh: Vũ Xuân Kỳ (SID: 189064)",
        "Mã lớp học: KHTN.2026.0913",
        "Lịch học: T5 20:30-21:30",
        "Ngày học: 15/10/2026",
        "",
        "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_LanNT18",
      ].join("\n")
    );
  });

  it("omits the Lịch học line entirely when it is blank", () => {
    const item: MappedItem = {
      tenHS: "Đặng Mai Vy (SID: 213054)",
      maLop: "KHTN.2026.1972",
      ngayHoc: "15/10/2026",
      lichHoc: "",
      username: "SAAnhPTH5",
    };
    expect(buildAnnouncement(item)).toBe(
      [
        "✅ Thông tin học của con #KHTN",
        "Học sinh: Đặng Mai Vy (SID: 213054)",
        "Mã lớp học: KHTN.2026.1972",
        "Ngày học: 15/10/2026",
        "",
        "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SAAnhPTH5",
      ].join("\n")
    );
    // No leftover blank "Lịch học:" line.
    expect(buildAnnouncement(item)).not.toContain("Lịch học:");
  });

  it("uses a custom closing line (cauNhan) when provided, keeping the @tag", () => {
    const item: MappedItem = {
      ...base,
      cauNhan: "HS hôm nay có lịch học, QLL trao đổi với PHHS giúp em nhé ạ!",
    };
    const out = buildAnnouncement(item);
    expect(out).toContain(
      "HS hôm nay có lịch học, QLL trao đổi với PHHS giúp em nhé ạ! @SA_LanNT18"
    );
    // The default closing line is NOT used.
    expect(out).not.toContain("HS nay có ca học QLL nắm thêm thông tin");
  });

  it("falls back to the default closing when cauNhan is empty/whitespace", () => {
    const item: MappedItem = { ...base, cauNhan: "   " };
    expect(buildAnnouncement(item)).toContain(
      "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_LanNT18"
    );
  });
});

describe("groupByUsername", () => {
  const a1: MappedItem = {
    tenHS: "A1",
    maLop: "TOAN.2026.0001",
    ngayHoc: "15/10/2026",
    lichHoc: "T2",
    username: "SA_X",
  };
  const a2: MappedItem = {
    tenHS: "A2",
    maLop: "KHTN.2026.0002",
    ngayHoc: "16/10/2026",
    lichHoc: "",
    username: "SA_X",
  };
  const b1: MappedItem = {
    tenHS: "B1",
    maLop: "MOET.2026.0003",
    ngayHoc: "17/10/2026",
    lichHoc: "T4",
    username: "SA_Y",
  };

  it("groups multiple students sharing a username into one bucket, order preserved", () => {
    const groups = groupByUsername([a1, a2]);
    expect([...groups.keys()]).toEqual(["SA_X"]);
    expect(groups.get("SA_X")).toEqual([a1, a2]);
  });

  it("keeps different usernames in separate buckets, first-seen order preserved", () => {
    const groups = groupByUsername([b1, a1, a2]);
    expect([...groups.keys()]).toEqual(["SA_Y", "SA_X"]);
    expect(groups.get("SA_Y")).toEqual([b1]);
    expect(groups.get("SA_X")).toEqual([a1, a2]);
  });
});

describe("buildGroupedAnnouncement", () => {
  const s1: MappedItem = {
    tenHS: "Vũ Xuân Kỳ",
    maLop: "KHTN.2026.0913",
    ngayHoc: "15/10/2026",
    lichHoc: "T5 20:30-21:30",
    username: "SA_X",
  };
  const s2: MappedItem = {
    tenHS: "Đặng Mai Vy",
    maLop: "TOAN.2026.1972",
    ngayHoc: "16/10/2026",
    lichHoc: "",
    username: "SA_X",
  };

  it("builds a single-student message with one @tag at the end", () => {
    expect(buildGroupedAnnouncement("SA_X", [s1])).toBe(
      [
        "✅ Thông tin học của con #KHTN",
        "• Vũ Xuân Kỳ — Mã lớp: KHTN.2026.0913 — Lịch học: T5 20:30-21:30 — Ngày học: 15/10/2026",
        "",
        "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_X",
      ].join("\n")
    );
  });

  it("lists multiple students with distinct hashtags deduped in order and a single @tag", () => {
    const out = buildGroupedAnnouncement("SA_X", [s1, s2]);
    expect(out).toBe(
      [
        "✅ Thông tin học của con #KHTN #TOAN",
        "• Vũ Xuân Kỳ — Mã lớp: KHTN.2026.0913 — Lịch học: T5 20:30-21:30 — Ngày học: 15/10/2026",
        "• Đặng Mai Vy — Mã lớp: TOAN.2026.1972 — Ngày học: 16/10/2026",
        "",
        "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_X",
      ].join("\n")
    );
    // @tag appears exactly once.
    expect(out.match(/@SA_X/g)).toHaveLength(1);
  });

  it("omits only the blank student's Lịch học segment", () => {
    const out = buildGroupedAnnouncement("SA_X", [s1, s2]);
    expect(out).toContain("• Đặng Mai Vy — Mã lớp: TOAN.2026.1972 — Ngày học: 16/10/2026");
    expect(out).not.toContain("• Đặng Mai Vy — Mã lớp: TOAN.2026.1972 — Lịch học:");
  });

  it("collapses a single repeated subject into one hashtag", () => {
    const same: MappedItem = { ...s2, maLop: "KHTN.2026.1111" };
    const out = buildGroupedAnnouncement("SA_X", [s1, same]);
    expect(out.split("\n")[0]).toBe("✅ Thông tin học của con #KHTN");
  });

  it("omits the hashtag part (no trailing space) when none is derivable", () => {
    const noCode: MappedItem = { ...s1, maLop: "" };
    const out = buildGroupedAnnouncement("SA_X", [noCode]);
    expect(out.split("\n")[0]).toBe("✅ Thông tin học của con");
  });

  it("uses a custom cauNhan and keeps the @tag exactly once", () => {
    const out = buildGroupedAnnouncement(
      "SA_X",
      [s1],
      "QLL trao đổi với PHHS giúp em nhé ạ!"
    );
    expect(out).toContain("QLL trao đổi với PHHS giúp em nhé ạ! @SA_X");
    expect(out).not.toContain("HS nay có ca học QLL nắm thêm thông tin");
    expect(out.match(/@SA_X/g)).toHaveLength(1);
  });

  it("falls back to the default closing when cauNhan is blank/whitespace", () => {
    const out = buildGroupedAnnouncement("SA_X", [s1], "   ");
    expect(out).toContain(
      "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_X"
    );
  });
});

describe("buildSummary", () => {
  it("lists mapped and unmapped and ends with the confirmation instruction", () => {
    const summary = buildSummary(
      3,
      [
        { tenHS: "Vũ Xuân Kỳ (SID: 189064)", username: "SA_LanNT18" },
        { tenHS: "Đặng Mai Vy (SID: 213054)", username: "SAAnhPTH5" },
      ],
      ["Nguyễn Thị Quỳnh Trang 8"]
    );

    expect(summary).toContain("Tổng số dòng: 3");
    expect(summary).toContain("Đã map (2):");
    expect(summary).toContain("- Vũ Xuân Kỳ (SID: 189064) -> @SA_LanNT18");
    expect(summary).toContain("- Đặng Mai Vy (SID: 213054) -> @SAAnhPTH5");
    expect(summary).toContain("Không tìm thấy (1):");
    expect(summary).toContain("- Nguyễn Thị Quỳnh Trang 8");
    expect(summary.endsWith("Gõ /ok để gửi, /huy để huỷ.")).toBe(true);
  });

  it("shows (không có) when nothing mapped or unmapped", () => {
    const summary = buildSummary(0, [], []);
    expect(summary).toContain("Đã map (0):");
    expect(summary).toContain("Không tìm thấy (0):");
    expect(summary).toContain("(không có)");
  });
});
