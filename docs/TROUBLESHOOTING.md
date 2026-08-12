# Chẩn đoán nhanh

## Public lỗi nhưng local khỏe

Kiểm tra `video-moderator-web`, endpoint `/auth/verify`, Caddy và DNS. Subvid phụ
thuộc Video Moderator cho `forward_auth`; lỗi xác thực không phải lỗi Node.

## Service không khởi động sau chuyển VPS

Nếu log báo DPAPI/key, blob cũ thuộc máy cũ. Import recovery envelope để tạo blob
mới hoặc tạo khóa mới và nhập lại cấu hình provider. Không copy nguyên blob DPAPI.

## Link Douyin/TikTok/YouTube không tải

Chạy `yt-dlp --version`, cập nhật yt-dlp, xác nhận FFmpeg/ffprobe và DNS outbound.
Kiểm tra log lỗi resolver; không tắt SSRF guard hay cho phép private IP để chữa lỗi.

## Groq Whisper thất bại

Phân biệt HTTP 401/403 (key/quyền), 413 (audio quá lớn), 429 (rate limit), timeout
và response rỗng. Chia audio dưới giới hạn provider; không ghi request header/key
vào log.

## Dịch trả mảng sai

Đây là response-shape failure dù HTTP là 200. Hệ thống phải retry batch lỗi rồi
trả lỗi rõ; không ghép thiếu/thừa bản dịch vào cue kế tiếp.
