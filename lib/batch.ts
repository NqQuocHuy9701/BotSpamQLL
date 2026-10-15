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

// subjectHashtag(maLop): the subject hashtag derived from the first 4 chars of
// the class code (e.g. "TOAN.2026.1176" -> "#TOAN", "MOET_TH.2025.0104" ->
// "#MOET", "KHTN.2026.0746" -> "#KHTN"). Returns "" when the code is too short
// or has no usable leading letters/digits, so no stray "#" is added.
export function subjectHashtag(maLop: string): string {
  // Take the leading run of letters/digits, then its first 4 chars uppercased.
  const head = maLop.trim().replace(/[^A-Za-z0-9].*$/, "").slice(0, 4).toUpperCase();
  return head === "" ? "" : `#${head}`;
}

// buildAnnouncement(item): the exact group message form. The whole "Lịch học"
// line is omitted (no leftover blank line) when lichHoc is blank. The subject
// hashtag (from the first 4 chars of the class code) is appended to the title
// line, e.g. "✅ Thông tin học của con #TOAN".
export function buildAnnouncement(item: MappedItem): string {
  const hashtag = subjectHashtag(item.maLop);
  const title =
    hashtag === ""
      ? "✅ Thông tin học của con"
      : `✅ Thông tin học của con ${hashtag}`;
  const lines = [
    title,
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

// groupByUsername(items): buckets mapped items by their QLL username into an
// insertion-ordered Map, preserving the first-seen order of usernames AND the
// first-seen order of students within each bucket. Used by /ok to combine all
// students sharing one QLL into a single tagged announcement.
export function groupByUsername(
  items: MappedItem[]
): Map<string, MappedItem[]> {
  const groups = new Map<string, MappedItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.username);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.username, [item]);
    }
  }
  return groups;
}

// buildGroupedAnnouncement(username, students, cauNhan): combines every student
// sharing ONE QLL into a single announcement that tags that QLL exactly once.
// The title lists the DISTINCT subject hashtags across the group's students
// (first-seen order, space-separated); the hashtag part is omitted entirely
// when none is derivable. Each student is a "•" bullet carrying its own Mã lớp,
// Lịch học (omitted when blank), and Ngày học. The closing line (cauNhan when
// provided and non-blank, else DEFAULT_CLOSING) ends with " @<username>".
export function buildGroupedAnnouncement(
  username: string,
  students: MappedItem[],
  cauNhan?: string
): string {
  // Distinct subject hashtags, first-seen order, blanks dropped.
  const hashtags: string[] = [];
  for (const s of students) {
    const tag = subjectHashtag(s.maLop);
    if (tag !== "" && !hashtags.includes(tag)) {
      hashtags.push(tag);
    }
  }

  const title =
    hashtags.length === 0
      ? "✅ Thông tin học của con"
      : `✅ Thông tin học của con ${hashtags.join(" ")}`;

  // De-duplicate identical rows: the source sheet can repeat the exact same
  // (HS + mã lớp + lịch + ngày) line, which would otherwise show as duplicate
  // bullets. Two DIFFERENT subjects/classes for the same student are kept (the
  // key includes maLop), so a student with two classes still lists both.
  const seen = new Set<string>();
  const uniqueStudents: MappedItem[] = [];
  for (const s of students) {
    const key = `${s.tenHS}|${s.maLop}|${s.lichHoc}|${s.ngayHoc}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueStudents.push(s);
    }
  }

  const lines = [title, ""];
  uniqueStudents.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.tenHS}`);
    lines.push(`   • Mã lớp: ${s.maLop}`);
    if (s.lichHoc !== "") {
      lines.push(`   • Lịch học: ${s.lichHoc}`);
    }
    lines.push(`   • Ngày học: ${s.ngayHoc}`);
    lines.push("");
  });

  const closing =
    cauNhan && cauNhan.trim() !== "" ? cauNhan.trim() : DEFAULT_CLOSING;
  lines.push(`${closing} @${username}`);
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
