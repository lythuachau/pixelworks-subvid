<div align="center">

# subvid.app

**Generate, edit, translate, and export subtitles for any video or audio — entirely in your browser.**

No uploads. No backend. No API keys.

<a href="https://subvid.app">🌐 Live site</a> ·
<a href="https://github.com/midudev/subvid.app">📦 Repository</a> ·
<a href="#getting-started">🚀 Getting started</a>

<br />

<img width="900" alt="subvid.app — subtitle editor with timeline and live preview" src="https://github.com/user-attachments/assets/6a4463ce-9cf7-4053-a193-97104080b6a7" />

<br />
<br />

[![Astro](https://img.shields.io/badge/Astro-6-FF5D01?logo=astro&logoColor=white)](https://astro.build)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Node.js](https://img.shields.io/badge/Deploy-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

## What it does

1. **Upload a video or audio** — drag & drop, browse, or paste a **Douyin / TikTok / YouTube** link. Supports MP4, MOV, WebM, MKV, MP3, WAV, and OGG.
2. **Configure languages** — pick the audio language (or auto-detect) and the subtitle language.
3. **Open subtitle tracks** — ASR/Whisper is not bundled; use an existing subtitle project/track, then translate when needed.
4. **Edit in the timeline** — fix text, timing, and styling with undo/redo.
5. **Export** — download an `.srt` file or a new video with burned-in captions (video files only).

Video and audio processing stay on the local machine. Translation sends subtitle text only to the configured API.

## Features

- **Subtitle-first processing** — no ASR/Whisper model is bundled, downloaded, or initialized.
- **Chinese subtitle OCR** — remains available as a standalone text source for imported subtitle workflows.
- **Source-locked translation timing** — translated cues copy the source track's exact start/end values and never create character-length or synthetic word timestamps.
- **Project workflow** — autosave plus named save/open projects, including media, subtitle tracks, styles, and editor settings.
- **Subtitle QA and cue tools** — overlap/timing/readability checks, cue split/merge, contextual retry, and side-by-side source/target comparison.
- **Subtitle editor** — segment list, timeline scrubbing, multi-language tracks, caption presets (font, color, background, outline, position).
- **Export options**
  - SRT, WebVTT, ASS, or TXT subtitle files; all language tracks can be downloaded as one ZIP
  - MP4 with hard-coded subtitles (WebCodecs + [mediabunny](https://github.com/Vanilagy/mediabunny) when available; canvas + MediaRecorder as fallback)
- **Internationalization** — English (default) and Spanish, with static pages per locale.
- **API-only translation** — Gemini or a custom OpenAI/Anthropic-compatible endpoint; no translation model is loaded in the browser.

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | [Astro 6](https://astro.build) with the Node adapter |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| Translation | Gemini API or custom OpenAI/Anthropic-compatible API |
| Audio extraction | [@ffmpeg/ffmpeg](https://ffmpegwasm.netlify.app) (WASM) |
| Video export | [mediabunny](https://www.npmjs.com/package/mediabunny) + WebCodecs |
| Deployment | Node.js behind Caddy |

## Requirements

- **Node.js** ≥ 22.12.0
- **pnpm** (recommended package manager for this repo)

For end users, a modern Chromium-based browser (Chrome, Edge, Brave) or Firefox is recommended. Safari works but WebCodecs export may fall back to the slower MediaRecorder path.

## Getting started

```sh
# Clone the repository
git clone https://github.com/midudev/subvid.app.git
cd subvid.app

# Install dependencies
pnpm install

# Start the dev server (http://localhost:4321)
pnpm dev
```

File upload works with **no environment variables**. Backend translation,
transcription, API administration, and link import require the server-side
configuration documented below.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Astro dev server at `localhost:4321` |
| `pnpm build` | Build the production site to `./dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm start` | Run the standalone Node production build |
| `pnpm deploy` | Build the standalone Node release |

## Project structure

```text
src/
├── components/       # Astro UI (upload, config, editor, export modal, …)
├── i18n/ui.ts        # Translations (en, es) — server + client strings
├── layouts/          # HTML shell, hreflang, meta tags
├── pages/            # Routes: / (en), /es/ (es)
├── scripts/
│   ├── app.ts        # Main client logic (state, translation, export)
│   └── dom.ts        # DOM helpers
└── styles/           # Global and app-specific CSS
```

The app is a multi-stage SPA embedded in static Astro pages. Server-rendered copy lives in `src/i18n/ui.ts`; runtime strings for the active locale are injected into `window.__I18N__` so only one language ships per page.

## Architecture notes

- **Main thread** — UI, video playback, timeline, FFmpeg orchestration, export rendering.
- **FFmpeg worker** — remains available for media preview and export/remux.
- **Model downloads** — no ASR model assets are downloaded; translation uses the configured API.

### Browser capabilities

| Capability | Used for |
| --- | --- |
| WebCodecs | Fast MP4 export with burned-in subtitles |
| SharedArrayBuffer / cross-origin isolation | Required by FFmpeg WASM in some environments |

## Deployment

The site runs as a standalone Astro Node server bound to loopback behind Caddy:

```sh
pnpm build
HOST=127.0.0.1 PORT=4321 pnpm start
```

Apply `deploy/postgres-schema.sql` to the Aiven database before enabling dynamic
configuration. Set `SUBVID_DATABASE_URL` and a 32-byte base64
`SUBVID_CONFIG_DATA_KEY` through the service environment. Provider keys are
AES-256-GCM encrypted before being written to PostgreSQL. Login, media, and
speech rate limits use atomic PostgreSQL transactions.

## Link import (Douyin · TikTok · YouTube)

The upload stage accepts a pasteable share link in addition to local files. Flow:

1. Browser `POST /api/media/resolve` with the URL (Node validates the host allowlist).
2. Node calls local yt-dlp or a configured **self-hosted Cobalt** instance and returns a short-lived same-origin proxy path.
3. Browser downloads via `GET /api/media/proxy`, builds a `File`, then reuses the normal subtitle pipeline.

### Configure

Copy `env.example` and set secrets in the external service environment:

| Variable | Required | Description |
| --- | --- | --- |
| `COBALT_API_URL` | yes (for links) | Base URL of your Cobalt API (no trailing slash) |
| `COBALT_API_KEY` | no | `Authorization: Api-Key …` if the instance requires it |
| `MEDIA_PROXY_SECRET` | **yes** | HMAC secret for proxy download tokens, ≥ 32 chars. Without it `/api/media/*` returns `503 proxy_unavailable` — there is no fallback secret |
| `MEDIA_MAX_BYTES` | no | Max import size (default `160000000` ≈ 160 MB) |

Generate `MEDIA_PROXY_SECRET` outside the repository and never pass it on the
command line in production.

**Important:** do not point production traffic at the public `api.cobalt.tools` instance — it uses bot protection and is not for third-party apps. [Run your own Cobalt instance](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md).

### Supported hosts

- **Douyin** — `douyin.com`, `v.douyin.com`, `iesdouyin.com`
- **TikTok** — `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`, …
- **YouTube** — `youtube.com`, `youtu.be`, `music.youtube.com`

Photo-only carousels / multi-item pickers without a video track are rejected with a clear UI error. Prefer short clips; imports default to **720p**.

### Local development

`pnpm dev` / `pnpm dev:local` mounts `/api/media/*` via a Vite middleware (no Worker required):

1. **If `COBALT_API_URL` is set** in `.env` → same Cobalt resolve path as production.
2. **Otherwise** → local **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** fallback (must be on `PATH`). Supports Douyin / TikTok / YouTube for local testing without Cobalt.

```sh
# optional — production-like local path
cp env.example .env
# COBALT_API_URL=https://your-cobalt-instance.example
```

## Adding a language

1. Add the locale code to `i18n.locales` in `astro.config.mjs`.
2. Create `src/pages/<code>/index.astro` (copy `src/pages/es/index.astro`).
3. Add a translation block in `src/i18n/ui.ts` mirroring the English keys.
4. Register the display name in `languages` inside `src/i18n/ui.ts`.

## Privacy

subvid.app is designed around local-first processing:

- Local files are read via the File API and transcribed in the browser.
- AI models run in Web Workers with WASM/WebGPU.
- Optional **link import** resolves Douyin / TikTok / YouTube media through your Worker + Cobalt instance (only the share URL and media bytes for that import leave the browser).
- No analytics backend or user accounts in this codebase.

## License

See the repository for license details.

## Author

Built by [midudev](https://midu.dev).
