# Kiến trúc production

Trình duyệt đi qua Caddy tại `subvid.choulee.indevs.in`. Caddy xác thực phiên
qua `video-moderator` (`/auth/verify`) rồi chuyển request đến Astro Node tại
`127.0.0.1:4321`. Node gọi PostgreSQL Aiven, Groq/Gemini hoặc endpoint dịch đã
cấu hình, và các binary cục bộ Python/FFmpeg/yt-dlp.

Source được đóng thành release bất biến dưới `C:\Services\Subvid\releases`.
Junction `current` chọn release đang chạy. Log, file tạm, `.env` và khóa không
nằm trong release.

Khóa provider do người dùng nhập được AES-256-GCM trước khi lưu PostgreSQL. Khóa
AES 32 byte nằm trong `subvid-config-key.dpapi`, được Windows DPAPI bảo vệ theo
máy. Vì vậy database và blob DPAPI phải được khôi phục cùng một recovery envelope
nếu muốn giữ nguyên cấu hình provider cũ.

## Phụ thuộc và thứ tự khởi động

1. PostgreSQL Aiven khả dụng.
2. `video-moderator-web` khả dụng cho `forward_auth`.
3. `subvid-web` lắng nghe đúng một process tại loopback.
4. Caddy lắng nghe 80/443 và proxy đến Subvid.

Nếu Video Moderator ngừng, Caddy sẽ không cho truy cập Subvid dù backend Subvid
vẫn khỏe. Kiểm tra local health trước khi kết luận Subvid lỗi.
