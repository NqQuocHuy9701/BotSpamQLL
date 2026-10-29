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

    // Kết nối Supabase để lấy danh xưng / map username từ bảng config có sẵn
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    let userTitles = {};
    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const CONFIG_ROW_ID = -9001;
      const { data } = await supabase
        .from("pending_batches")
        .select("items")
        .eq("admin_id", CONFIG_ROW_ID)
        .maybeSingle();
      
      if (data?.items?.userTitles) {
        userTitles = data.items.userTitles;
      }
    }

    for (const s of students) {
      // s = { student_id, student_name, qll_name, class_code }
      
      // Làm sạch tên QLL để tra cứu trong bảng map userTitles hoặc dùng trực tiếp
      let rawQll = (s.qll_name || "").trim();
      let cleanKey = rawQll.replace(/^@/, "").toLowerCase();
      
      // Lấy danh xưng đã lưu trong hệ thống (mặc định là "anh/chị" nếu chưa cài)
      let title = userTitles[cleanKey] || "anh/chị";
      let username = cleanKey || "HuyNQ5"; // Dự phòng nếu trống

      // Form chuẩn bạn yêu cầu
      const text = [
        `Học sinh: ${s.student_name} (${s.student_id})`,
        `Mã lớp: ${s.class_code}`,
        ``,
        `@${username} Dạ đến giờ học nhưng HS chưa vào nhờ ${title} báo PHHS ạ`
      ].join("\n");

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