import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../lib/config.js";
import { getClient, listKnownUsers } from "../lib/supabase.js";
import { createTelegramClient } from "../lib/telegram.js";
import { mapQllByUser, nameToCore, usernameToCore } from "../lib/qllmap.js"; // Import bộ bóc Lõi

// Hàm tính độ tương đồng (Dice's Coefficient)
// Vì nameToCore và usernameToCore đã tự động xóa dấu & viết thường, ta đọ trực tiếp luôn.
function getSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0; 
  if (s1.length < 2 || s2.length < 2) return 0.0;

  let bigrams1 = new Set();
  for (let i = 0; i < s1.length - 1; i++) bigrams1.add(s1.substring(i, i + 2));
  
  let bigrams2 = new Set();
  for (let i = 0; i < s2.length - 1; i++) bigrams2.add(s2.substring(i, i + 2));

  let intersection = 0;
  for (let item of bigrams1) {
    if (bigrams2.has(item)) intersection++;
  }

  return (2.0 * intersection) / (bigrams1.size + bigrams2.size);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
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

    const config = loadConfig();
    const supabase = getClient(config.supabaseUrl, config.supabaseKey);
    const telegram = createTelegramClient(config.botToken);
    const TARGET_GROUP_ID = -1002273179613; 

    const { users: knownUsers } = await listKnownUsers(supabase);

    for (const s of students) {
      const qllNameFromSheet = s.qll_name || "";
      let finalUsername = "";

      // 1. Dùng luồng gốc của project: Thử tìm khớp 100% full_name hoặc Lõi trùng tuyệt đối
      const match = mapQllByUser(qllNameFromSheet, knownUsers);
      
      if (match.kind === "found") {
        finalUsername = match.username; 
      } else {
         // 2. LOGIC NÂNG CẤP: Bóc Lõi từ sheet và Lõi từ DB đem đi đọ mix > 85-90%
         const targetCore = nameToCore(qllNameFromSheet); // VD: "quyennd1"
         
         let bestMatch = null;
         let highestSimilarity = 0;

         for (const user of knownUsers) {
             const dbCore = usernameToCore(user.username); // VD: VH_QuyenDD1 -> "quyendd1"
             
             const sim = getSimilarity(targetCore, dbCore);
             if (sim > highestSimilarity) {
                 highestSimilarity = sim;
                 bestMatch = user;
             }
         }

         // Set ngưỡng 0.85 (85%) để bắt dính case lệch 1 ký tự giữa quyennd1 vs quyendd1
         if (bestMatch && highestSimilarity >= 0.85) {
             finalUsername = bestMatch.username;
             console.log(`Fuzzy Match: ${targetCore} ~ ${usernameToCore(bestMatch.username)} (${Math.round(highestSimilarity*100)}%) -> @${bestMatch.username}`);
         } else {
             // 3. Dự phòng cuối cùng nếu hụt toàn bộ
             finalUsername = qllNameFromSheet.replace(/^@/, "").replace(/\s+/g, "");
         }
      }

      // 4. Bắn thông báo
      const text = [
        `Học sinh: ${s.student_name} (${s.student_id})`,
        `Mã lớp: ${s.class_code}`,
        ``,
        `@${finalUsername} Dạ đến giờ học nhưng HS chưa vào nhờ anh/chị báo PHHS ạ`
      ].join("\n");

      await telegram.sendMessage(TARGET_GROUP_ID, text);
    }

    res.status(200).json({ success: true, count: students.length });
  } catch (error) {
    console.error("Lỗi check attendance:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
  }
}