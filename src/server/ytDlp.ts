// Local yt-dlp process runner used by the link-import resolver.
//
// Kept free of `@/` path aliases so the unit tests can import it directly under
// plain Node (the alias is a Vite-only resolution).

import { execFile } from "node:child_process";

export type YtDlpInfo = {
  url?: string;
  title?: string;
  ext?: string;
  requested_downloads?: Array<{ url?: string }>;
};

// TikTok answers some requests with a JS challenge; yt-dlp solves it and
// refetches, but the challenge cookie is often rejected and extraction fails
// with "Unable to extract universal data for rehydration". Measured on this
// host the extractor succeeds ~50-60% per call, and the outcome is partly
// correlated across rapid attempts, so retries are spaced out rather than
// immediate. Upgrading yt-dlp does not help — 2026.07.04 scored worse than
// 2026.06.09 on the same clip, and a persistent cookie jar made no difference.
const YTDLP_TIMEOUT_MS = 60_000;
const YTDLP_MAX_ATTEMPTS = 4;
const YTDLP_RETRY_DELAY_MS = 800;
/** Ceiling across all attempts so a hung extractor cannot stall the request. */
const YTDLP_TOTAL_BUDGET_MS = 90_000;
/** Failures that are a property of the link itself — retrying only wastes time. */
const YTDLP_PERMANENT_RE =
  /Unsupported URL|Video unavailable|is private|has been removed|does not exist|Requested format is not available|HTTP Error 4\d\d/i;

export class YtDlpError extends Error {
  /** Sanitized extractor message, safe to show a caller. May be empty. */
  detail: string;

  constructor(code: string, detail = "") {
    super(code);
    this.name = "YtDlpError";
    this.detail = detail;
  }
}

/**
 * Reduce yt-dlp stderr to its extractor message. Local paths are stripped so
 * the server filesystem layout never reaches the client.
 */
export function ytDlpErrorDetail(stderr: string): string {
  const reported = String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ERROR:/i.test(line));
  const chosen = reported.at(-1) || "";
  if (!chosen) return "";
  return chosen
    .replace(/^ERROR:\s*/i, "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\s*;\s*please report this issue.*$/i, "")
    .replace(/\s*Confirm you are on the latest version.*$/i, "")
    .slice(0, 200)
    .trim();
}

export function isPermanentYtDlpFailure(detail: string): boolean {
  return YTDLP_PERMANENT_RE.test(detail);
}

function runOnce(
  executable: string,
  mediaUrl: string,
  timeoutMs: number,
): Promise<YtDlpInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "20",
        "--format",
        "best[ext=mp4]/best",
        "--",
        mediaUrl,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new YtDlpError("yt_dlp_failed", ytDlpErrorDetail(stderr)));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as YtDlpInfo);
        } catch {
          reject(
            new YtDlpError("yt_dlp_invalid_json", ytDlpErrorDetail(stderr)),
          );
        }
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runYtDlp(
  executable: string,
  mediaUrl: string,
): Promise<YtDlpInfo> {
  const deadline = Date.now() + YTDLP_TOTAL_BUDGET_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= YTDLP_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await runOnce(
        executable,
        mediaUrl,
        Math.min(YTDLP_TIMEOUT_MS, remaining),
      );
    } catch (error) {
      lastError = error;
      const detail = error instanceof YtDlpError ? error.detail : "";
      if (isPermanentYtDlpFailure(detail)) break;
      if (attempt < YTDLP_MAX_ATTEMPTS) {
        console.warn(
          `[media-resolve] yt-dlp attempt ${attempt}/${YTDLP_MAX_ATTEMPTS} failed; retrying`,
          JSON.stringify({ detail }),
        );
        await delay(YTDLP_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new YtDlpError("yt_dlp_failed");
}
