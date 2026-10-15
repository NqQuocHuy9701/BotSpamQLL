import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildAnnouncement, buildSummary, parseSheet } from "../lib/batch.js";
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
        "✅ Thông tin học của con",
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
        "✅ Thông tin học của con",
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
