import { loadConfig } from "../lib/config.js";
import { getClient, listKnownUsers } from "../lib/supabase.js";
import { createTelegramClient } from "../lib/telegram.js";
import { mapQllByUser } from "../lib/qllmap.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { students } = req.body;
    if (!Array.isArray(students) || students.length === 0) {
      res.status(200).json({ success: true, message: "Không có học sinh nào cần báo cáo." });
      return;
    }

    // 1. Tận dụng hàm loadConfig và các client có sẵn trong project
    const config = loadConfig();
    const supabase = getClient(config.supabaseUrl, config.supabaseKey);
    const telegram = createTelegramClient(config.botToken);
    const TARGET_GROUP_ID = -1002273179613; 

    // 2. Kéo danh sách QLL từ Supabase (bảng telegram_users_qll)
    const { users: knownUsers } = await listKnownUsers(supabase);

    // 3. Xử lý từng học sinh
    for (const s of students) {
      const qllNameFromSheet = s.qll_name || "";
      
      // Đưa tên vào "cỗ máy" mapQllByUser để bóc tách, chuẩn hóa và tìm đúng username
      const match = mapQllByUser(qllNameFromSheet, knownUsers);
      
      let finalUsername = "";
      if (match.kind === "found") {
        finalUsername = match.username; // Lấy được chuẩn username (VD: HuyNQ5)
      } else {
        // Dự phòng nếu không tìm thấy trong DB
        finalUsername = qllNameFromSheet.replace(/^@/, "").replace(/\s+/g, "");
      }

      // 4. Form chuẩn báo cáo
      const text = [
        `Học sinh: ${s.student_name} (${s.student_id})`,
        `Mã lớp: ${s.class_code}`,
        ``,
        `@${finalUsername} Dạ đến giờ học nhưng HS chưa vào nhờ anh/chị báo PHHS ạ`
      ].join("\n");

      // Bắn tin nhắn qua hàm có sẵn (đã bao gồm xử lý chia tin nhắn và timeout)
      await telegram.sendMessage(TARGET_GROUP_ID, text);
    }

    res.status(200).json({ success: true, count: students.length });
  } catch (error) {
    console.error("Lỗi check attendance:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
  }
}