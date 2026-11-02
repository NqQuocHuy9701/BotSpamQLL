import type { VercelRequest, VercelResponse } from "@vercel/node";

// ĐÃ GỠ: trước đây endpoint này (chạy 3 mốc/ngày theo vercel.json) gom các case
// chưa xử lý và gửi "BÁO CÁO CUỐI CA: N CASE BỊ MISS" cho admin. Theo yêu cầu,
// tính năng gửi danh sách case miss cuối ca đã được BỎ.
//
// Báo cáo cuối ca hiện tại (React/Reply/Tổng mỗi CTV) do api/cron.ts xử lý
// (maybeSendShiftReports) qua cron ngoài chạy mỗi phút — KHÔNG dùng endpoint này.
//
// Giữ endpoint như một no-op trả 200 để các lịch cron cũ (nếu còn) không lỗi.
export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.status(200).json({ ok: true, message: "cron_report disabled (case-miss report removed)" });
}
