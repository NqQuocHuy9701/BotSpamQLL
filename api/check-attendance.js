import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { students } = req.body;
    if (!Array.isArray(students) || students.length === 0) {
      return res.status(200).json({ success: true, message: "Không có học sinh nào cần báo cáo." });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const TARGET_GROUP_ID = -1002273179613; // ID nhóm QLL của bạn

    // Kết nối Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Chưa cấu hình Supabase URL hoặc Key trên Vercel.");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Lấy trước toàn bộ danh sách mapping từ bảng telegram_users_qll để tra cứu cho nhanh
    const { data: qllUsers, error: dbError } = await supabase
      .from("telegram_users_qll")
      .select("username, full_name");

    if (dbError) {
      console.error("Lỗi query bảng telegram_users_qll:", dbError);
    }

    for (const s of students) {
      // s = { student_id, student_name, qll_name, class_code }
      let inputName = (s.qll_name || "").trim();
      
      let matchedUsername = null;

      if (qllUsers && qllUsers.length > 0) {
        // Tìm kiếm linh hoạt theo full_name hoặc username trùng khớp với qll_name trong sheet
        const found = qllUsers.find(u => 
          (u.full_name && u.full_name.toLowerCase() === inputName.toLowerCase()) ||
          (u.username && u.username.toLowerCase() === inputName.replace(/^@/, "").toLowerCase())
        );

        if (found) {
          matchedUsername = found.username;
        }
      }

      // Nếu không tìm thấy trong database thì dùng tạm giá trị làm sạch từ sheet
      const finalUsername = matchedUsername || inputName.replace(/^@/, "").replace(/\s+/g, "");

      // Form chuẩn báo cáo học sinh chưa vào học
      const text = [
        `Học sinh: ${s.student_name} (${s.student_id})`,
        `Mã lớp: ${s.class_code}`,
        ``,
        `@${finalUsername} Dạ đến giờ học nhưng HS chưa vào nhờ anh/chị báo PHHS ạ`
      ].join("\n");

      // Gửi tin nhắn qua Telegram Bot API
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TARGET_GROUP_ID,
          text: text,
        }),
      });
    }

    return res.status(200).json({ success: true, count: students.length });
  } catch (error) {
    console.error("Lỗi check attendance:", error);
    return res.status(500).json({ error: error.message });
  }
}