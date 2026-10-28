import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../lib/config.js";
import { getClient, getAndMarkMissedCases } from "../lib/supabase.js";
import { createTelegramClient } from "../lib/telegram.js";

// ID của bạn và ID của QLL mới
const ADMIN_IDS = [6532155675, 6410818714]; 
const GROUP_ID = -1002273179613; 

export default async function handler(
  _req: VercelRequest, 
  res: VercelResponse
): Promise<void> {
  const config = loadConfig();
  const supabase = getClient(config.supabaseUrl, config.supabaseKey);
  const telegram = createTelegramClient(config.botToken);

  // Lấy các case chưa xử lý và đánh dấu là "đã báo cáo"
  const missedCases = await getAndMarkMissedCases(supabase);
  
  if (missedCases.length === 0) {
    res.status(200).json({ ok: true, message: "Không có case miss" });
    return;
  }

  // Gom nội dung báo cáo
  let reportText = `⚠️ **BÁO CÁO CUỐI CA: ${missedCases.length} CASE BỊ MISS**\n\n`;
  for (const c of missedCases) {
    // Tạo link trỏ thẳng tới tin gốc trong nhóm kín (bỏ tiền tố -100)
    const msgLink = `https://t.me/c/${String(GROUP_ID).replace("-100", "")}/${c.message_id}`;
    reportText += `👤 ${c.sender_name}:\n📝 ${c.content.substring(0, 50)}...\n🔗 Link: ${msgLink}\n\n`;
  }

  // Bắn tin nhắn vào Inbox riêng cho từng Admin
  for (const adminId of ADMIN_IDS) {
    await telegram.sendMessage(adminId, reportText);
  }

  res.status(200).json({ ok: true, reported: missedCases.length });
}