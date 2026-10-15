# Hướng dẫn Bot Trợ Lý QLL (Telegram)

Tài liệu này mô tả toàn bộ cách con bot hoạt động và cách admin sử dụng. Bot là
một **trợ lý một chiều**: admin giao việc cho bot qua **chat riêng (1-1)**, bot
thực thi và phản hồi/đăng kết quả vào **nhóm QLL chung**.

---

## 1. Bot là gì, làm được gì

Con bot (`@vh_messenger_bot`) chạy 24/7 trên Vercel, nhận lệnh của admin qua chat
riêng và thao tác trong nhóm QLL. Nó có **3 nhóm chức năng**:

1. **Gom thông tin QLL (nằm vùng).** Bất kỳ ai nhắn trong nhóm, hoặc mới vào
   nhóm, bot tự lưu `username` + tên vào cơ sở dữ liệu (bảng
   `telegram_users_qll`). Dùng để sau này map tên QLL → username mà tag.

2. **Bắn thông báo học sinh theo file Excel (có duyệt + hẹn giờ + gửi rải).**
   Admin gửi file `.xlsx` → bot map từng HS về đúng QLL → báo cáo lại admin →
   admin duyệt (`/ok`) → bot bắn từng thông báo vào nhóm, **rải chậm** để không
   làm trôi nhóm, và có thể **hẹn giờ** gửi.

3. **(Tạm tắt) Luồng thu hồi tài khoản TK/MK.** Khi bật, bot tự xoá tin chứa
   TK/MK trong nhóm và chuyển vào inbox QLL. Hiện **đang TẮT** (`RELAY_ENABLED`
   không bật) để bot chỉ làm 2 việc trên.

---

## 2. Nguyên tắc an toàn

- Mọi lệnh điều khiển chỉ chạy khi **admin được uỷ quyền** nhắn trong **chat
  riêng** với bot. Người khác, hoặc gõ trong nhóm → bot bỏ qua.
- Danh sách admin được cấu hình trong code (`SPAMTEST_ADMIN_IDS`). Thêm người
  mới = thêm `telegram_id` của họ (họ phải bấm `/start` với bot một lần).
- Bot **không bao giờ tự bắn**. Nó chỉ bắn vào nhóm sau khi admin `/ok`.
- Thông tin nhạy cảm không log lộ; secret để trong biến môi trường Vercel.

---

## 3. Chuẩn bị (một lần)

- Admin phải **bấm `/start`** với bot trong chat riêng (để bot nhắn lại được).
- File Excel danh sách HS theo đúng 5 cột (xem mục 5).
- Các QLL cần được bot "biết" username — tức họ đã từng nhắn trong nhóm (bot gom
  dần). QLL nào bot chưa thấy sẽ bị "không tìm thấy" khi map.

---

## 4. Các lệnh admin (gõ trong chat riêng với bot)

| Thao tác | Ý nghĩa |
| --- | --- |
| Gửi file `.xlsx` (không caption) | Bot đọc + map + báo cáo. **Chưa gửi gì vào nhóm.** |
| Gửi file `.xlsx` + caption là câu nhắn | Như trên, nhưng dùng câu caption làm **dòng nhắn cuối** của mỗi thông báo. |
| `/ok` | Duyệt: bắn **ngay**, rải chậm vào nhóm. |
| `/ok 21:00` | Hẹn: đúng **21h hôm nay (giờ VN)** mới bắt đầu bắn. Nếu 21h đã qua → tự dời sang **21h ngày mai**. |
| `/ok 16/10 21:00` | Hẹn: đúng **21h ngày 16/10 (giờ VN)** năm nay. Nếu mốc đã qua → tự dời sang **năm sau**. |
| `/huy` | Huỷ danh sách đang chờ duyệt. |

> Lệnh `/ok` nhận cả chữ hoa/thường và dư khoảng trắng (vd `/OK  21:00`).
> Giờ theo định dạng 24h `HH:MM`, ngày theo `dd/mm` (ngày/tháng). Nhập sai (vd
> `/ok 25:00`, `/ok 32/13 10:00`, `/ok abc`) → bot báo lỗi và **không** xếp hàng.
> Khi hẹn giờ, bot trả lời xác nhận kèm mốc giờ VN, vd:
> "✅ Đã lên lịch gửi N HS lúc 21:00 16/10 (giờ VN). Bot sẽ tự gửi khi tới giờ."

> Câu nhắn cuối: nếu không nhập caption, bot dùng câu mặc định
> "HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ !".
> Bot luôn tự thêm ` @username` của QLL vào cuối.

---

## 5. Định dạng file Excel

Sheet đầu tiên, có dòng tiêu đề (bot tự dò dòng header kể cả khi phía trên có vài
dòng rác), gồm **5 cột**:

| Tên | Mã lớp | Ngày học | QLL | Lịch học |
| --- | --- | --- | --- | --- |
| Hoàng Đắc Anh Khoa (SID: 194448) | KHTN.2026.0746 | 15/10/2026 | Nguyễn Thị Quỳnh Trang 8 | T5 19:15-20:15 |

- **QLL**: ghi **tên đầy đủ tiếng Việt** của QLL (vd "Nguyễn Hải Hà 3"). Bot tự
  suy ra username theo quy tắc ở mục 6.
- **Lịch học**: có thể để trống (bot sẽ bỏ dòng "Lịch học" trong thông báo).

---

## 6. Quy tắc map tên QLL → username

Bot suy username từ tên đầy đủ theo công thức:

> **username lõi = Tên + chữ cái đầu của từng từ phần (Họ + Đệm) + số đuôi**

Ví dụ: **Nguyễn Hải Hà 3**
- Tên chính = "Hà" → `ha`
- Họ + đệm = "Nguyễn", "Hải" → chữ đầu `N`, `H` → `nh`
- Số đuôi = `3`
- Lõi = `hanh3` → khớp username `SA_HaNH3` (bỏ tiền tố `SA_`, không phân biệt hoa
  thường/dấu).

Bot bỏ qua tiền tố vai trò (`SA`, `OP`, `VH`) và dấu gạch dưới khi so khớp. Nếu
không tìm được username khớp trong bảng → HS đó bị **bỏ qua** và liệt kê trong
báo cáo (không bao giờ tag nhầm người).

---

## 7. Thông báo bot bắn vào nhóm (mẫu)

```
✅ Thông tin học của con
Học sinh: Hoàng Đắc Anh Khoa (SID: 194448)
Mã lớp học: KHTN.2026.0746
Lịch học: T5 19:15-20:15
Ngày học: 15/10/2026

HS nay có ca học QLL nắm thêm thông tin trao đổi với PHHS lịch nữa nhé ạ ! @SA_TrangNTQ8
```

(Dòng "Lịch học" được bỏ nếu để trống. Câu cuối đổi theo caption nếu có.)

---

## 8. Cơ chế gửi rải + hẹn giờ

- Khi admin `/ok`, bot **không bắn ngay một loạt**. Nó xếp từng HS vào hàng đợi
  (bảng `send_queue`).
- Một **cron bên ngoài** (cron-job.org) gọi bot mỗi phút. Mỗi lần bot lấy vài tin
  trong hàng đợi và gửi **cách nhau ~15-20 giây** → nhóm không bị dội.
- **Hẹn giờ**: nếu `/ok 21:00`, các tin được gắn mốc "chỉ gửi sau 21h". Cron vẫn
  chạy mỗi phút nhưng **bỏ qua** cho tới khi tới giờ, rồi mới bắt đầu rải.
- Giờ nhập theo **giờ Việt Nam (GMT+7)**; bot tự quy đổi sang UTC nội bộ.
- Khi gửi xong toàn bộ, bot nhắn admin: "✅ Đã gửi xong toàn bộ danh sách".

---

## 9. Hạ tầng kỹ thuật (tóm tắt)

- **Vercel Serverless**: `api/webhook.ts` (nhận update Telegram), `api/cron.ts`
  (drip-send theo hàng đợi).
- **Supabase (Postgres)**:
  - `telegram_users_qll` — username + tên QLL đã gom.
  - `pending_batches` — bản nháp đang chờ `/ok`.
  - `send_queue` — hàng đợi tin chờ gửi (có cờ `sent`, thời điểm, và mốc hẹn giờ
    `send_after`).
- **cron-job.org** — gọi `api/cron` mỗi phút, kèm header `Authorization: Bearer
  <CRON_SECRET>`.
- **Biến môi trường (Vercel)**: `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`,
  `CRON_SECRET`, và `RELAY_ENABLED` (để tắt/bật luồng TK/MK).

---

## 10. Giới hạn cần biết

- Bot **không lấy được toàn bộ thành viên nhóm** (giới hạn Telegram) — chỉ gom
  được ai đã nhắn/mới vào. QLL im lặng thì chưa có username.
- Vercel gói Hobby **không cho cron chạy mỗi phút**, nên phải dùng cron ngoài
  (cron-job.org). Nếu cron ngoài tắt, việc gửi rải/hẹn giờ sẽ dừng.
- Một lần `/ok` chỉ xử lý đúng danh sách đang chờ của chính admin đó.
