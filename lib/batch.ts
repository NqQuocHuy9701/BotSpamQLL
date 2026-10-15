// Pure batch-announcement parsing and formatting. Reads an .xlsx buffer into
// typed rows, builds the fixed group announcement form, and builds the private
// summary report. No Telegram/Supabase I/O lives here (that is the handler's
// job), so every function is directly unit-testable.

import * as XLSX from "xlsx";
import type { BatchRow, MappedItem } from "./types.js";

// Default closing line used when the admin did not supply a custom one via the
// file caption.
export const DEFAULT_CLOSING =
  "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ !";

// Canonical header labels (trimmed, lowercased) for the five known columns.
const HEADER_TEN = "tên";
const HEADER_MA_LOP = "mã lớp";
const HEADER_NGAY_HOC = "ngày học";
const HEADER_QLL = "qll";
const HEADER_LICH_HOC = "lịch học";

function headerKey(cell: unknown): string {
  return String(cell ?? "").trim().toLowerCase();
}

function cellText(cell: unknown): string {
  return String(cell ?? "").trim();
}

// parseSheet(buf): read the FIRST worksheet of the workbook, resolve the five
// columns by trimmed/case-insensitive header match (robust to a trailing space
// like "Tên " and to extra/unknown columns), and return one BatchRow per data
// row. Rows whose QLL cell is blank are skipped (no name to map). lichHoc may
// be "".
export function parseSheet(buf: Buffer): BatchRow[] {
  const workbook = XLSX.read(buf, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }
  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
  if (grid.length === 0) {
    return [];
  }

  // Find the REAL header row: some exports prepend junk rows (e.g. repeated
  // "Column1".."Column5" placeholders) before the actual "Tên / Mã lớp / Ngày
  // học / QLL / Lịch học" header. Scan for the first row that contains both the
  // "tên" and "qll" header labels, and treat that as the header row.
  let headerRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const keys = grid[r].map(headerKey);
    if (keys.includes(HEADER_TEN) && keys.includes(HEADER_QLL)) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) {
    return []; // no recognizable header -> nothing to parse
  }

  const header = grid[headerRow];
  const idx: Record<string, number> = {};
  header.forEach((cell, i) => {
    idx[headerKey(cell)] = i;
  });

  const colTen = idx[HEADER_TEN];
  const colMaLop = idx[HEADER_MA_LOP];
  const colNgayHoc = idx[HEADER_NGAY_HOC];
  const colQll = idx[HEADER_QLL];
  const colLichHoc = idx[HEADER_LICH_HOC];

  const at = (row: unknown[], col: number | undefined): string =>
    col === undefined ? "" : cellText(row[col]);

  const rows: BatchRow[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    const qll = at(row, colQll);
    if (qll === "") {
      continue; // no QLL name -> nothing to map
    }
    rows.push({
      tenHS: at(row, colTen),
      maLop: at(row, colMaLop),
      ngayHoc: at(row, colNgayHoc),
      qll,
      lichHoc: at(row, colLichHoc),
    });
  }
  return rows;
}

// buildAnnouncement(item): the exact group message form. The whole "Lịch học"
// line is omitted (no leftover blank line) when lichHoc is blank.
export function buildAnnouncement(item: MappedItem): string {
  const lines = [
    "✅ Thông tin học của con",
    `Học sinh: ${item.tenHS}`,
    `Mã lớp học: ${item.maLop}`,
  ];
  if (item.lichHoc !== "") {
    lines.push(`Lịch học: ${item.lichHoc}`);
  }
  lines.push(`Ngày học: ${item.ngayHoc}`);
  lines.push("");
  // Use the admin's custom closing line (from caption) when present and
  // non-empty; otherwise fall back to the default. The @username tag is always
  // appended at the end.
  const closing =
    item.cauNhan && item.cauNhan.trim() !== ""
      ? item.cauNhan.trim()
      : DEFAULT_CLOSING;
  lines.push(`${closing} @${item.username}`);
  return lines.join("\n");
}

// buildSummary(total, mapped, unmapped): the private report the admin sees
// before confirming. Lists the mapped students ("Tên HS -> @username") and the
// unmapped QLL names, and ends with the fixed confirmation instruction.
export function buildSummary(
  total: number,
  mapped: { tenHS: string; username: string }[],
  unmapped: string[]
): string {
  const lines: string[] = [];
  lines.push(`Tổng số dòng: ${total}`);

  lines.push(`Đã map (${mapped.length}):`);
  if (mapped.length === 0) {
    lines.push("(không có)");
  } else {
    for (const m of mapped) {
      lines.push(`- ${m.tenHS} -> @${m.username}`);
    }
  }

  lines.push(`Không tìm thấy (${unmapped.length}):`);
  if (unmapped.length === 0) {
    lines.push("(không có)");
  } else {
    for (const name of unmapped) {
      lines.push(`- ${name}`);
    }
  }

  lines.push("");
  lines.push("Gõ /ok để gửi, /huy để huỷ.");
  return lines.join("\n");
}
