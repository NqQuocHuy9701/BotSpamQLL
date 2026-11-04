// Mẫu câu nhắc của bot (v5 - lời nhắc đa dạng). Hàm THUẦN: không gọi DB hay
// Telegram, chỉ dựng chuỗi. Placeholder: {title} danh xưng, {user} username
// (không có @), {qll} tên hiển thị Telegram của người gửi case.

// A. Nhắc SLA: case quá 5 phút chưa ai xử lý, tag CTV trong ca.
export const SLA_TEMPLATES: readonly string[] = [
  "Dạ {title} @{user} ơi, case của {qll} đang chờ, {title} hỗ trợ giúp em với ạ! 🥺",
  "Dạ {title} @{user} ạ, case này chưa có ai nhận, {title} xem giúp em nha! 😊",
  "Dạ {title} @{user} ơi, {qll} đang đợi phản hồi ạ 🥺🙏",
  "@{user} ơi, case này chưa ai xử lý, {title} check giúp em với ạ! 😅",
  "Dạ {title} @{user}, mình còn case này đang chờ ạ, nhờ {title} hỗ trợ nha! 🥹",
  "Dạ {title} @{user}, {title} rảnh tay hỗ trợ giúp {qll} case này với ạ! 😊",
  "Dạ {title} @{user} ơi, case này vẫn đang chờ phản hồi ạ, {title} vào hỗ trợ giúp em nhé! 🥺",
  "Dạ {title} @{user} ơi, em nhờ {title} nhận giúp case của {qll} với ạ! 🥹",
];

// B. Tin khẩn: tag điều phối viên ngay khi có từ khóa khẩn (mặt khóc).
export const URGENT_TEMPLATES: readonly string[] = [
  "Dạ {title} @{user} ơi, {qll} đang cần hỗ trợ gấp, {title} xem giúp em ngay với ạ! 😭",
  "Dạ {title} @{user} ạ, có case gấp từ {qll}, nhờ {title} hỗ trợ sớm nha! 😢",
  "Dạ {title} @{user} ơi, case này khẩn ạ, {title} check giúp em với 😭🙏",
  "Dạ {title} @{user}, {qll} đang cần xử lý gấp, {title} hỗ trợ giúp em nha ạ! 😥",
  "Dạ {title} @{user} ơi, case này cần xử lý sớm ạ, {title} vào hỗ trợ giúp em với ạ! 😢",
  "Dạ {title} @{user} ơi, có case gấp ạ, nhờ {title} nhận giúp em nhé! 😭",
];

const MAX_QLL_NAME = 30;
const DEFAULT_TITLE = "anh/chị";

// Chuẩn hóa tên QLL: gọt khoảng trắng thừa, cắt gọn tên quá dài, rỗng -> "QLL".
export function cleanQllName(name: string | null | undefined): string {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n === "") return "QLL";
  return n.length > MAX_QLL_NAME ? `${n.slice(0, MAX_QLL_NAME).trim()}…` : n;
}

// Chọn chỉ số ngẫu nhiên trong [0, count), tránh `avoid` (câu vừa dùng) khi có
// thể. `rng` truyền vào được để test cho kết quả cố định.
export function pickIndex(
  count: number,
  avoid: number | undefined,
  rng: () => number = Math.random
): number {
  if (count <= 1) return 0;
  if (avoid === undefined || avoid < 0 || avoid >= count) {
    return Math.floor(rng() * count) % count;
  }
  // Chọn trong (count - 1) chỉ số còn lại rồi dời qua chỗ trống của `avoid`.
  const i = Math.floor(rng() * (count - 1)) % (count - 1);
  return i >= avoid ? i + 1 : i;
}

export function renderTemplate(
  tpl: string,
  vars: { title: string; user: string; qll: string }
): string {
  return tpl
    .replace(/\{title\}/g, vars.title)
    .replace(/\{user\}/g, vars.user)
    .replace(/\{qll\}/g, vars.qll);
}

interface ReminderInput {
  title?: string; // danh xưng anh/chị; thiếu -> "anh/chị"
  username: string; // có hoặc không có @
  qllName?: string | null;
  avoidIndex?: number; // chỉ số câu vừa dùng, để không lặp liền kề
  rng?: () => number;
}

function build(
  templates: readonly string[],
  input: ReminderInput
): { text: string; index: number } {
  const index = pickIndex(templates.length, input.avoidIndex, input.rng);
  const text = renderTemplate(templates[index], {
    title: (input.title ?? "").trim() || DEFAULT_TITLE,
    user: input.username.replace(/^@/, "").trim(),
    qll: cleanQllName(input.qllName),
  });
  return { text, index };
}

export function buildSlaReminder(input: ReminderInput): { text: string; index: number } {
  return build(SLA_TEMPLATES, input);
}

export function buildUrgentReminder(input: ReminderInput): { text: string; index: number } {
  return build(URGENT_TEMPLATES, input);
}
