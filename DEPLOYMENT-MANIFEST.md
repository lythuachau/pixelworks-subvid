# Production deployment manifest

Tested production layout on 2026-08-12:

| Item | Value |
| --- | --- |
| Public host | `subvid.choulee.indevs.in` |
| Loopback listener | `127.0.0.1:4321` |
| Windows service | `subvid-web` |
| Service root | `C:\Services\Subvid` |
| Mutable data | `C:\ServiceData\Subvid` |
| Environment file | `C:\ServiceData\Subvid\secrets\subvid.env` |
| DPAPI key file | `C:\ServiceData\Subvid\secrets\subvid-config-key.dpapi` |
| Reverse proxy | shared Caddy service on ports 80/443 |
| External database | Aiven PostgreSQL |

Tested toolchain: Windows x64, PowerShell 7.6.3 (scripts also target Windows
PowerShell 5.1), Node.js 24.18.0, pnpm 11.15.1, Python 3.12.10, FFmpeg 8.1.2,
yt-dlp 2026.07.04, Caddy 2.11.4 and WinSW 2.12.0.

Minimum supported application runtime is Node.js 22.12. Python 3.12, FFmpeg,
ffprobe and a current yt-dlp are required for media import/transcription.

The shared Caddy configuration and cross-project restore order live in the
separate `choulee-windows-vps-stack` repository. Caddy must preserve the
`forward_auth` dependency on Video Moderator and proxy Subvid to loopback only.
