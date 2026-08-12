# Khôi phục Subvid trên VPS Windows mới

## GitHub khôi phục được gì

Repository chứa source, lockfile, schema PostgreSQL, script release/service,
health check, CI và quy trình chuyển khóa. GitHub cố ý không chứa database URL,
API key, mật khẩu, session secret, PFX recovery hoặc khóa DPAPI production.

Không thể vừa lưu toàn bộ secret chỉ trong GitHub vừa coi GitHub là nơi an toàn.
Để khôi phục đúng cấu hình provider cũ, cần thêm recovery PFX ngoại tuyến và mật
khẩu của PFX. Nếu không có chúng, ứng dụng vẫn dựng mới được nhưng phải nhập lại
các provider key và có thể phải xóa cấu hình mã hóa cũ trong database.

## Chuẩn bị trước sự cố

Trên một máy tin cậy không phải VPS, tạo recovery PFX/CER:

```powershell
$pfxPassword = Read-Host "Recovery PFX password" -AsSecureString
.\deploy\windows\New-RecoveryCertificate.ps1 `
  -PublicCertificatePath D:\Offline\subvid-recovery.cer `
  -PrivateKeyPath D:\Offline\subvid-recovery.pfx `
  -PrivateKeyPassword $pfxPassword
```

Chỉ chép file `.cer` công khai lên VPS cũ rồi xuất envelope:

```powershell
.\deploy\windows\Export-RecoveryEnvelope.ps1 `
  -ProtectedKeyPath C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi `
  -PublicCertificatePath C:\Transfer\subvid-recovery.cer `
  -EnvelopePath C:\Transfer\subvid-config-key.envelope.json
```

Envelope có thể lưu trong repository hạ tầng private. PFX và mật khẩu phải được
lưu ở hai nơi ngoại tuyến tách biệt. Chạy `Test-KeyRecovery.ps1` bằng dữ liệu giả
trước khi tin cậy quy trình.

## Dựng VPS mới

1. Cài Git, Node.js >=22.12, pnpm, Python 3.12, FFmpeg/ffprobe, yt-dlp, Caddy và
   WinSW. Không mở port ứng dụng 4321 ra Internet.
2. Clone repository private vào `C:\Deploy\subvid`, xác minh commit/tag cần dùng.
3. Tạo `C:\ServiceData\Subvid\secrets\subvid.env` từ `env.example` và nhập secret
   từ password manager. Áp dụng `deploy/postgres-schema.sql` vào database.
4. Nếu dựng mới hoàn toàn, tạo khóa mới:

   ```powershell
   .\deploy\windows\Initialize-ProtectedKey.ps1
   ```

   Nếu cần giữ cấu hình provider cũ, dùng PFX ngoại tuyến:

   ```powershell
   $pfxPassword = Read-Host "Recovery PFX password" -AsSecureString
   .\deploy\windows\Import-RecoveryKey.ps1 `
     -EnvelopePath C:\Transfer\subvid-config-key.envelope.json `
     -PrivateKeyPath E:\Offline\subvid-recovery.pfx `
     -PrivateKeyPassword $pfxPassword `
     -OutputKeyPath C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi
   ```

5. Tạo release rồi cài service trong PowerShell Administrator:

   ```powershell
   .\deploy\windows\Deploy-Release.ps1
   .\deploy\windows\Prepare-Service.ps1
   Set-Service subvid-web -StartupType Automatic
   Start-Service subvid-web
   ```

6. Cài Caddy từ repository stack, xác minh config, sau đó mới đổi DNS/mở 80/443.
7. Kiểm tra:

   ```powershell
   .\deploy\windows\Test-Deployment.ps1 -Domain subvid.choulee.indevs.in
   ```

Tiêu chí hoàn tất: service Running/Automatic, chỉ một listener loopback 4321,
local và public health HTTP 200, trang đăng nhập hoạt động, import URL/tệp và một
probe dịch thật thành công. Không coi HTTP 200 là đủ nếu số cue dịch không khớp.
