# Tool-cousera
```markdown
# Coursera Automation & Assistant Tool (Tampermonkey Userscript)

Bộ công cụ Userscript chạy trên trình duyệt thông qua tiện ích mở rộng **Tampermonkey**, hỗ trợ tự động hóa và nâng cao trải nghiệm học tập trên nền tảng [Coursera](https://www.coursera.org/).

---

## 📌 Tính năng chính

- Tự động hóa các thao tác học tập, chuyển bài giảng video và tài liệu đọc.
- Bỏ chặn thao tác chuột phải, sao chép nội dung khi làm bài và học tập.
- Hỗ trợ phím tắt điều khiển và tinh chỉnh tốc độ phát video.
- Hiển thị log trạng thái hoạt động chi tiết trong cửa sổ Console (DevTools).

---

## 🛠 Yêu cầu chuẩn bị

1. Trình duyệt web: **Google Chrome**, **Microsoft Edge**, **Brave** hoặc **Mozilla Firefox**.
2. Tiện ích mở rộng **Tampermonkey**:
   - [Cài đặt Tampermonkey cho Chrome / Chromium](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Cài đặt Tampermonkey cho Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)

---

## 🚀 Hướng dẫn sao chép mã nguồn và cài đặt vào Tampermonkey

### Bước 1: Sao chép mã nguồn sạch từ GitHub
1. Mở file mã nguồn script trong repository này (ví dụ file `main.js` hoặc `coursera-tool.user.js`).
2. Thực hiện một trong hai cách sau để lấy mã:
   - **Cách nhanh nhất:** Nhấp vào biểu tượng **Copy raw file** (hình 2 ô vuông lồng nhau ở góc trên bên phải khung hiển thị code).
   - **Cách thủ công:** Nhấp vào nút **Raw** ở đầu khung code để mở trang text thuần, sau đó nhấn tổ hợp phím `Ctrl + A` (chọn tất cả) và `Ctrl + C` (sao chép).

### Bước 2: Tạo và dán script vào Tampermonkey
1. Nhấp vào biểu tượng **Tampermonkey** trên thanh tiện ích của trình duyệt (góc trên bên phải).
2. Chọn dòng **Create a new script...** (Tạo script mới).
3. Tại giao diện soạn thảo code vừa mở ra, nhấn `Ctrl + A` rồi nhấn `Delete` (hoặc `Backspace`) để **xóa sạch toàn bộ code mẫu mặc định**.
4. Nhấn `Ctrl + V` để dán toàn bộ đoạn mã đã sao chép ở Bước 1 vào.
5. Nhấn `Ctrl + S` (hoặc chọn menu **File** > **Save** ở góc trên bên trái khung soạn thảo) để lưu lại.

### Bước 3: Kiểm tra kích hoạt
1. Mở lại menu Tampermonkey > chọn **Dashboard**.
2. Kiểm tra xem tên script đã xuất hiện trong danh sách và công tắc trạng thái đang gạt sang **Bật (ON)** hay chưa.

---

## 🔧 Cách bật Developer Mode và DevTools

### 1. Bật Developer Mode cho tiện ích trình duyệt
1. Nhập đường dẫn sau vào thanh địa chỉ của trình duyệt rồi nhấn `Enter`:
   ```text
   chrome://extensions

```

2. Tìm công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải màn hình và gạt sang **Bật (On)**.

### 2. Mở DevTools (F12) để xem log hoạt động

1. Truy cập vào bài học bất kỳ trên [Coursera](https://www.coursera.org/).
2. Nhấn phím **F12** (hoặc nhấn tổ hợp phím `Ctrl + Shift + I` trên Windows / `Cmd + Option + I` trên macOS).
3. Chuyển sang tab **Console** trong bảng DevTools để theo dõi các tiến trình tự động hoặc thông báo lỗi nếu có.

---

## 📖 Hướng dẫn sử dụng

1. Đăng nhập vào tài khoản cá nhân trên [Coursera](https://www.coursera.org/).
2. Truy cập vào khóa học cần học. Script sẽ tự động nhận diện trang và chạy theo cấu hình metadata:
```javascript
// ==UserScript==
// @name         Coursera Tool
// @match        https://*.coursera.org/*
// @grant        none
// ==/UserScript==

```


3. Nhấp vào biểu tượng tiện ích Tampermonkey trên thanh trình duyệt: nếu thấy biểu tượng hiển thị số `1` kèm chấm xanh tức là script đã được kích hoạt thành công trên trang.

---

## ⚠ Lưu ý & Miễn trừ trách nhiệm

* Script được phát triển nhằm mục đích nghiên cứu công nghệ và hỗ trợ học tập cá nhân.
* Không lạm dụng công cụ để can thiệp tiêu cực vào các bài thi, câu hỏi trắc nghiệm (quizzes) hoặc vi phạm Điều khoản dịch vụ (Terms of Service) của Coursera.
* Người dùng tự chịu mọi trách nhiệm liên quan đến tài khoản học tập khi cài đặt và chạy các công cụ tự động hóa từ bên thứ ba.

```

```
