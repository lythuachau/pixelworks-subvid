import {
  detectMediaService,
  extractSupportedMediaUrl,
  type MediaService,
} from "@/lib/mediaHosts.ts";
import {
  DOUYIN_FETCH_HEADERS,
  resolveDouyinMedia,
} from "@/server/douyinResolve.ts";
import { contentDisposition } from "@/server/httpHeaders.ts";
import {
  completedExpectedTransfer,
  resumedTransferTotal,
} from "@/server/mediaStream.ts";
import {
  defaultProxySecret,
  MissingProxySecretError,
  signProxyPayload,
  verifyProxyToken,
} from "@/server/mediaToken.ts";
import { cobaltHostname, isAllowedMediaHost } from "@/server/netGuard.ts";
import {
  clientIp,
  recordRateLimitFailure,
  type RateLimitBinding,
} from "@/server/rateLimit.ts";
import { runYtDlp, YtDlpError } from "@/server/ytDlp.ts";

export type MediaEnv = {
  COBALT_API_URL?: string;
  COBALT_API_KEY?: string;
  YTDLP_PATH?: string;
  MEDIA_PROXY_SECRET?: string;
  MEDIA_MAX_BYTES?: string;
  RATE_LIMITER?: RateLimitBinding;
  [key: string]: unknown;
};

// Allow common 720p Douyin clips while retaining a bounded proxy stream.
const DEFAULT_MAX_BYTES = 160_000_000;
const PROXY_TTL_SECONDS = 15 * 60;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
/** Redirect hops the proxy will follow, re-checking the allowlist each time. */
const MAX_REDIRECTS = 5;
const MAX_STREAM_RESUMES = 8;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/gi;

type CobaltTunnelResponse = {
  status: "tunnel" | "redirect";
  url: string;
  filename?: string;
};

type CobaltPickerResponse = {
  status: "picker";
  picker?: Array<{ type?: string; url?: string }>;
  audio?: string;
  audioFilename?: string;
};

type CobaltErrorResponse = {
  status: "error";
  error?: { code?: string; context?: { service?: string; limit?: number } };
};

type CobaltLocalProcessingResponse = {
  status: "local-processing";
  tunnel?: string[];
  output?: { filename?: string; type?: string };
};

type CobaltResponse =
  | CobaltTunnelResponse
  | CobaltPickerResponse
  | CobaltErrorResponse
  | CobaltLocalProcessingResponse
  | { status: string };

function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function rateLimit(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  const decision = await recordRateLimitFailure(
    env,
    `media:${clientIp(request)}`,
    { limit: RATE_MAX, windowMs: RATE_WINDOW_MS },
  );
  if (!decision.blocked) return null;
  return json(
    {
      ok: false,
      error: "rate_limited",
      message: "Too many import requests. Try again shortly.",
    },
    429,
    { "Retry-After": String(decision.retryAfter) },
  );
}

function proxySecretUnavailable(): Response {
  return json(
    {
      ok: false,
      error: "not_configured",
      message:
        "Media proxy is not configured. Set MEDIA_PROXY_SECRET on the server.",
    },
    503,
  );
}

function maxBytes(env: MediaEnv): number {
  const raw = env.MEDIA_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function guessContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  return "video/mp4";
}

function sanitizeFilename(name: string | undefined, service: MediaService): string {
  const fallback = `${service}-video.mp4`;
  if (!name) return fallback;
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

async function callCobalt(
  env: MediaEnv,
  mediaUrl: string,
): Promise<CobaltResponse> {
  const base = (env.COBALT_API_URL || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("not_configured");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (env.COBALT_API_KEY) {
    headers.Authorization = `Api-Key ${env.COBALT_API_KEY}`;
  }

  const response = await fetch(`${base}/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: mediaUrl,
      downloadMode: "auto",
      videoQuality: "720",
      youtubeVideoCodec: "h264",
      youtubeVideoContainer: "mp4",
      filenameStyle: "basic",
      disableMetadata: true,
      alwaysProxy: true,
    }),
  });

  let data: CobaltResponse;
  try {
    data = (await response.json()) as CobaltResponse;
  } catch {
    throw new Error("resolve_failed");
  }

  if (!response.ok && data.status !== "error") {
    throw new Error("resolve_failed");
  }

  return data;
}


async function resolveWithYtDlp(
  env: MediaEnv,
  mediaUrl: string,
  service: MediaService,
): Promise<{ targetUrl: string; filename: string }> {
  const executable = String(env.YTDLP_PATH || "").trim();
  if (!executable) throw new Error("not_configured");
  const info = await runYtDlp(executable, mediaUrl);
  const targetUrl = String(
    info.url || info.requested_downloads?.find((item) => item.url)?.url || "",
  ).trim();
  if (!targetUrl) throw new Error("yt_dlp_missing_url");
  const parsed = new URL(targetUrl);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    !isAllowedMediaHost(parsed.hostname, cobaltHostname(env.COBALT_API_URL))
  ) {
    throw new Error("yt_dlp_blocked_target");
  }
  const ext = String(info.ext || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4";
  return {
    targetUrl,
    filename: sanitizeFilename(`${info.title || service}-video.${ext}`, service),
  };
}

async function buildDownloadPath(
  env: MediaEnv,
  targetUrl: string,
  filename: string,
): Promise<string> {
  const secret = defaultProxySecret(env);
  const token = await signProxyPayload(
    {
      u: targetUrl,
      n: filename,
      exp: Math.floor(Date.now() / 1000) + PROXY_TTL_SECONDS,
    },
    secret,
  );
  const params = new URLSearchParams({ t: token });
  return `/api/media/proxy?${params.toString()}`;
}

export async function handleMediaResolve(
  request: Request,
  env: MediaEnv,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const limited = await rateLimit(request, env);
  if (limited) return limited;

  // Fail fast rather than resolving the link and then failing to sign it.
  try {
    defaultProxySecret(env);
  } catch (error) {
    if (error instanceof MissingProxySecretError) return proxySecretUnavailable();
    throw error;
  }

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return json({ ok: false, error: "invalid", message: "Invalid JSON body." }, 400);
  }

  const extracted = extractSupportedMediaUrl(String(body.url || ""));
  if (!extracted) {
    // Distinguish unsupported host vs empty/invalid when possible
    const raw = String(body.url || "").trim();
    if (raw) {
      try {
        const host = new URL(
          raw.match(URL_IN_TEXT_RE)?.[0] || raw,
        ).hostname;
        if (host && !detectMediaService(host)) {
          return json(
            {
              ok: false,
              error: "unsupported",
              message: "Only Douyin, TikTok, and YouTube links are supported.",
            },
            400,
          );
        }
      } catch {
        // fall through
      }
    }
    return json(
      {
        ok: false,
        error: "invalid",
        message: "Paste a valid Douyin, TikTok, or YouTube link.",
      },
      400,
    );
  }

  // Cookie-free Douyin path (no Cobalt required)
  let douyinNativeError = "";
  if (extracted.service === "douyin") {
    try {
      const resolved = await resolveDouyinMedia(extracted.url);
      const filename = sanitizeFilename(resolved.filename, "douyin");
      const downloadPath = await buildDownloadPath(
        env,
        resolved.mediaUrl,
        filename,
      );
      return json({
        ok: true,
        service: "douyin",
        filename,
        downloadPath,
        contentType: "video/mp4",
        via: "douyin-native",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      douyinNativeError = message;
      // If Cobalt is configured, fall through to Cobalt.
      // If yt-dlp is configured, fall through to the yt-dlp block below.
      // Only fail immediately when neither fallback is available.
      if (!env.COBALT_API_URL && !env.YTDLP_PATH) {
        return json(
          {
            ok: false,
            error: "failed",
            message: `Could not resolve Douyin link (${message}).`,
          },
          502,
        );
      }
    }
  }

  if (!env.COBALT_API_URL) {
    if (env.YTDLP_PATH) {
      try {
        const resolved = await resolveWithYtDlp(env, extracted.url, extracted.service);
        return json({
          ok: true,
          service: extracted.service,
          filename: resolved.filename,
          downloadPath: await buildDownloadPath(
            env,
            resolved.targetUrl,
            resolved.filename,
          ),
          contentType: guessContentType(resolved.filename),
          via: "yt-dlp-local",
        });
      } catch (error) {
        const detail = error instanceof YtDlpError ? error.detail : "";
        console.error(
          "[media-resolve] yt_dlp_failed",
          JSON.stringify({
            service: extracted.service,
            detail,
            douyinNativeError: douyinNativeError || undefined,
          }),
        );
        const parts = [
          "Could not resolve this link with local yt-dlp.",
          detail,
          douyinNativeError ? `Douyin native: ${douyinNativeError}` : "",
        ].filter(Boolean);
        return json(
          {
            ok: false,
            error: "failed",
            message: parts.join(" "),
          },
          502,
        );
      }
    }
    return json(
      {
        ok: false,
        error: "not_configured",
        message:
          "Link import is not configured. Set COBALT_API_URL on the server.",
      },
      503,
    );
  }

  try {
    const cobalt = await callCobalt(env, extracted.url);

    if (cobalt.status === "error") {
      const code = (cobalt as CobaltErrorResponse).error?.code || "resolve_failed";
      return json(
        {
          ok: false,
          error: "failed",
          message: `Could not resolve media (${code}).`,
          code,
        },
        502,
      );
    }

    if (cobalt.status === "tunnel" || cobalt.status === "redirect") {
      const tunnel = cobalt as CobaltTunnelResponse;
      if (!tunnel.url) {
        return json({ ok: false, error: "failed", message: "Empty media URL." }, 502);
      }
      const filename = sanitizeFilename(tunnel.filename, extracted.service);
      const downloadPath = await buildDownloadPath(env, tunnel.url, filename);
      return json({
        ok: true,
        service: extracted.service,
        filename,
        downloadPath,
        contentType: guessContentType(filename),
      });
    }

    if (cobalt.status === "picker") {
      const picker = cobalt as CobaltPickerResponse;
      const video = picker.picker?.find(
        (item) => item.type === "video" && item.url,
      );
      if (video?.url) {
        const filename = sanitizeFilename(
          `${extracted.service}-video.mp4`,
          extracted.service,
        );
        const downloadPath = await buildDownloadPath(env, video.url, filename);
        return json({
          ok: true,
          service: extracted.service,
          filename,
          downloadPath,
          contentType: guessContentType(filename),
        });
      }
      return json(
        {
          ok: false,
          error: "picker_unsupported",
          message:
            "This post has no single video track we can import. Upload a file instead.",
        },
        422,
      );
    }

    if (cobalt.status === "local-processing") {
      const local = cobalt as CobaltLocalProcessingResponse;
      const first = local.tunnel?.[0];
      if (first) {
        const filename = sanitizeFilename(
          local.output?.filename,
          extracted.service,
        );
        const downloadPath = await buildDownloadPath(env, first, filename);
        return json({
          ok: true,
          service: extracted.service,
          filename,
          downloadPath,
          contentType: local.output?.type || guessContentType(filename),
        });
      }
    }

    return json(
      {
        ok: false,
        error: "failed",
        message: `Unsupported Cobalt status: ${String((cobalt as { status?: string }).status)}`,
      },
      502,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "not_configured") {
      return json(
        {
          ok: false,
          error: "not_configured",
          message:
            "Link import is not configured. Set COBALT_API_URL on the server.",
        },
        503,
      );
    }
    return json(
      {
        ok: false,
        error: "failed",
        message: "Could not import this link. Try another URL or upload a file.",
      },
      502,
    );
  }
}

class BlockedTargetError extends Error {}

class UpstreamFetchError extends Error {
  readonly host: string;
  readonly errorName: string;
  readonly causeName: string;
  readonly causeCode: string;

  constructor(host: string, error: unknown) {
    super("upstream_fetch_failed");
    this.name = "UpstreamFetchError";
    this.host = host;
    this.errorName = diagnosticValue(
      error instanceof Error ? error.name : typeof error,
    );
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    this.causeName = diagnosticValue(
      cause && typeof cause === "object" && "name" in cause
        ? (cause as { name?: unknown }).name
        : "",
    );
    this.causeCode = diagnosticValue(
      cause && typeof cause === "object" && "code" in cause
        ? (cause as { code?: unknown }).code
        : "",
    );
  }
}

function diagnosticValue(value: unknown): string {
  return String(value || "")
    .replace(/[^a-z0-9_.:-]/gi, "")
    .slice(0, 64);
}

function streamErrorCode(error: unknown): string {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  return diagnosticValue(
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : "",
  );
}

function canResumeStream(error: unknown): boolean {
  return ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(
    streamErrorCode(error),
  );
}

function safeMediaHost(target: string): string {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return "invalid-host";
  }
}

function logMediaProxyFailure(
  phase: "fetch" | "status" | "stream",
  target: string,
  error?: unknown,
  status?: number,
): void {
  const fetchError = error instanceof UpstreamFetchError ? error : null;
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  console.error(
    "[media-proxy] upstream_failure",
    JSON.stringify({
      phase,
      host: fetchError?.host || safeMediaHost(target),
      status: Number.isInteger(status) ? status : undefined,
      errorName:
        fetchError?.errorName ||
        diagnosticValue(error instanceof Error ? error.name : typeof error),
      causeName:
        fetchError?.causeName ||
        diagnosticValue(
          cause && typeof cause === "object" && "name" in cause
            ? (cause as { name?: unknown }).name
            : "",
        ),
      causeCode:
        fetchError?.causeCode ||
        diagnosticValue(
          cause && typeof cause === "object" && "code" in cause
            ? (cause as { code?: unknown }).code
            : "",
        ),
    }),
  );
}

/**
 * Fetch `target`, following redirects by hand so the allowlist is re-checked
 * on every hop. With `redirect: "follow"` an allowed CDN could 302 the Worker
 * to any host on the internet, which is what made this an open proxy.
 */
async function fetchAllowedMedia(
  target: string,
  request: Request,
  env: MediaEnv,
  rangeStart = 0,
): Promise<Response> {
  const cobaltHost = cobaltHostname(env.COBALT_API_URL);
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new BlockedTargetError(parsed.protocol);
    }
    if (!isAllowedMediaHost(parsed.hostname, cobaltHost)) {
      throw new BlockedTargetError(parsed.hostname);
    }

    const isDouyinCdn =
      /snssdk\.com|douyin|byteicdn|tiktokcdn|ibytedtos/i.test(parsed.hostname);
    let response: Response;
    try {
      const headers: Record<string, string> = isDouyinCdn
        ? { ...DOUYIN_FETCH_HEADERS }
        : {
            // Some CDNs are picky; keep headers minimal.
            Accept: "*/*",
            "User-Agent":
              request.headers.get("User-Agent") || "subvid-media-proxy/1.0",
          };
      if (rangeStart > 0) headers.Range = `bytes=${rangeStart}-`;
      response = await fetch(current, {
        method: request.method,
        headers,
        redirect: "manual",
      });
    } catch (error) {
      throw new UpstreamFetchError(parsed.hostname, error);
    }

    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("Location")
        : null;
    if (!location) return response;

    // Drain the redirect body so the connection is not left dangling.
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }

  throw new BlockedTargetError("too_many_redirects");
}

export async function handleMediaProxy(
  request: Request,
  env: MediaEnv,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const limited = await rateLimit(request, env);
  if (limited) return limited;

  const url = new URL(request.url);
  const token = url.searchParams.get("t") || "";
  let secret: string;
  try {
    secret = defaultProxySecret(env);
  } catch (error) {
    if (error instanceof MissingProxySecretError) return proxySecretUnavailable();
    throw error;
  }
  const payload = await verifyProxyToken(token, secret);
  if (!payload) {
    return json(
      { ok: false, error: "invalid_token", message: "Download link expired or invalid." },
      403,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetchAllowedMedia(payload.u, request, env);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return json(
        {
          ok: false,
          error: "forbidden_target",
          message: "This media host is not allowed.",
        },
        403,
      );
    }
    logMediaProxyFailure("fetch", payload.u, error);
    return json(
      {
        ok: false,
        error: "download_failed",
        message: "The link was resolved, but the video CDN could not be reached.",
      },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    logMediaProxyFailure("status", payload.u, undefined, upstream.status);
    return json(
      {
        ok: false,
        error: "download_failed",
        message: `Upstream returned ${upstream.status}.`,
      },
      502,
    );
  }

  const limit = maxBytes(env);
  let expectedLengthHeader =
    upstream.headers.get("Content-Length") ||
    upstream.headers.get("Estimated-Content-Length");
  if (expectedLengthHeader) {
    const length = Number(expectedLengthHeader);
    if (Number.isFinite(length) && length > limit) {
      return json(
        {
          ok: false,
          error: "too_large",
          message: "This video is too large to import.",
          maxBytes: limit,
        },
        413,
      );
    }
  }

  const filename = sanitizeFilename(payload.n, "youtube");
  const contentType =
    upstream.headers.get("Content-Type") || guessContentType(filename);

  // Stream with a soft byte cap
  let transferred = 0;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let reader = upstream.body.getReader();
  let resumeCount = 0;

  ;(async () => {
    while (true) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          transferred += value.byteLength;
          if (transferred > limit) {
            await writer.close();
            return;
          }
          await writer.write(value);
        }
        await writer.close();
        return;
      } catch (error) {
        if (canResumeStream(error) && resumeCount < MAX_STREAM_RESUMES) {
          try {
            const resumed = await fetchAllowedMedia(
              payload.u,
              request,
              env,
              transferred,
            );
            const total = resumedTransferTotal(
              resumed.status,
              resumed.headers.get("Content-Range"),
              transferred,
            );
            if (!resumed.body || total === null || total > limit) {
              await resumed.body?.cancel().catch(() => {});
              throw new Error("resume_rejected");
            }
            resumeCount += 1;
            expectedLengthHeader = String(total);
            reader = resumed.body.getReader();
            console.warn(
              "[media-proxy] upstream_resume",
              JSON.stringify({
                host: safeMediaHost(payload.u),
                offset: transferred,
                attempt: resumeCount,
              }),
            );
            continue;
          } catch (resumeError) {
            if (
              completedExpectedTransfer(transferred, expectedLengthHeader)
            ) {
              await writer.close();
              return;
            }
            error = resumeError;
          }
        }
        if (completedExpectedTransfer(transferred, expectedLengthHeader)) {
          console.warn(
            "[media-proxy] upstream_closed_after_complete_transfer",
            JSON.stringify({
              host: safeMediaHost(payload.u),
              transferred,
            }),
          );
          await writer.close();
          return;
        }
        logMediaProxyFailure("stream", payload.u, error);
        try {
          // Do not pass the upstream exception into Astro's response adapter.
          // Its uncaught-stream logger includes the full request query, which
          // contains the signed media token. The client still detects a short
          // response from the Content-Length mismatch.
          await writer.close();
        } catch {
          // ignore
        }
        return;
      }
    }
  })();

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(filename),
  });
  if (expectedLengthHeader) {
    headers.set("Content-Length", expectedLengthHeader);
  }
  const estimated = upstream.headers.get("Estimated-Content-Length");
  if (estimated) headers.set("Estimated-Content-Length", estimated);

  return new Response(request.method === "HEAD" ? null : readable, {
    status: 200,
    headers,
  });
}

export function isMediaApiPath(pathname: string): boolean {
  return (
    pathname === "/api/media/resolve" || pathname === "/api/media/proxy"
  );
}

export async function handleMediaApi(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/media/resolve") {
    return handleMediaResolve(request, env);
  }
  if (pathname === "/api/media/proxy") {
    return handleMediaProxy(request, env);
  }
  return null;
}
