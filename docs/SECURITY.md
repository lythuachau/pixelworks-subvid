# Bảo mật và secret

- Không commit `.env`, PFX, mật khẩu PFX, API key, database URL thật hoặc DPAPI
  blob production.
- Recovery envelope chỉ chứa ciphertext RSA và fingerprint chứng chỉ. Nó không
  giải mã được nếu thiếu PFX và mật khẩu, nhưng vẫn nên đặt trong repo private.
- Backend chỉ bind `127.0.0.1:4321`; chỉ Caddy được mở 80/443.
- `ALLOW_PRIVATE_TRANSLATE_ENDPOINT` chỉ dùng test local vì nó nới chặn SSRF.
- Tài khoản service chỉ được Read/Execute trên release và Modify trên log/temp.
- Dùng password hash cho admin; không lưu mật khẩu rõ trong env.
- Chạy `deploy/windows/Audit-Secrets.ps1` trước mỗi commit và kiểm tra toàn bộ diff.

Khi nghi lộ secret: thu hồi key tại provider, đổi database password và session
secret, tạo lại media proxy secret, đăng xuất mọi phiên, rồi kiểm tra Git history.
Xóa file ở commit mới không xóa nó khỏi lịch sử.
