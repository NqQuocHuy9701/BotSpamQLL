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

    for (const s of students) {
      // s = { student_id, student_name, qll_name, class_code }
      
      // RULE CHUẨN HÓA USERNAME QLL:
      // Chuyển "Nguyễn Quốc Huy" / "HuyNQ5" / "@HuyNQ5" thành username dạng gọn không dấu, viết liền hoặc lấy đúng cấu trúc bot đã có.
      // Ở đây ta xử lý chuẩn hóa cơ bản: Bỏ dấu, bỏ khoảng trắng, viết liền để ra đúng dạng @HuyNQ5 hoặc user tương ứng.
      let rawQll = (s.qll_name || "").trim();
      
      // Nếu tên QLL có chứa dạng "Nguyễn Quốc Huy" hoặc có số phía sau, ta xử lý đưa về đúng username hệ thống
      // Hoặc nếu sheet đã điền sẵn dạng "HuyNQ5" thì ta chỉ cần thêm dấu @ phía trước.
      let cleanUsername = rawQll
        .replace(/^@/, "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, ""); // Ví dụ: "Nguyễn Quốc Huy" -> "NguyenQuocHuy" 
        // Hoặc nếu tên QLL trong sheet của bạn đã sát với username (như "HuyNQ5"), nó sẽ giữ nguyên thành "HuyNQ5".

      // Nếu bạn muốn tận dụng hàm map sẵn có trong bot, ta có thể format thẳng:
      const qllTag = rawQll.startsWith("@") ? rawQll : `@${rawQll.replace(/\s+/g, "")}`;

      // Định dạng form thông báo đúng yêu cầu của bạn
      const text = [
        `Học sinh: ${s.student_name} (${s.student_id})`,
        `Mã lớp: ${s.class_code}`,
        ``,
        `${qllTag} Dạ đến giờ học nhưng HS chưa vào nhờ anh/chị báo PHHS ạ`
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