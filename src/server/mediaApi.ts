import {
  detectMediaService,
  extractSupportedMediaUrl,
  type MediaService,
} from "@/lib/mediaHosts.ts";
import {
  DOUYIN_FETCH_HEADERS,
  resolveDouyinMedia,
} from "@/server/douyinResolve.ts";
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

export type MediaEnv = {
  COBALT_API_URL?: string;
  COBALT_API_KEY?: string;
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
      // If Cobalt is configured, fall through; otherwise fail clearly.
      if (!env.COBALT_API_URL) {
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

/**
 * Fetch `target`, following redirects by hand so the allowlist is re-checked
 * on every hop. With `redirect: "follow"` an allowed CDN could 302 the Worker
 * to any host on the internet, which is what made this an open proxy.
 */
async function fetchAllowedMedia(
  target: string,
  request: Request,
  env: MediaEnv,
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
    const response = await fetch(current, {
      method: request.method,
      headers: isDouyinCdn
        ? { ...DOUYIN_FETCH_HEADERS }
        : {
            // Some CDNs are picky; keep headers minimal.
            Accept: "*/*",
            "User-Agent":
              request.headers.get("User-Agent") || "subvid-media-proxy/1.0",
          },
      redirect: "manual",
    });

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
    return json(
      { ok: false, error: "failed", message: "Upstream media fetch failed." },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    return json(
      {
        ok: false,
        error: "failed",
        message: `Upstream returned ${upstream.status}.`,
      },
      502,
    );
  }

  const limit = maxBytes(env);
  const contentLengthHeader =
    upstream.headers.get("Content-Length") ||
    upstream.headers.get("Estimated-Content-Length");
  if (contentLengthHeader) {
    const length = Number(contentLengthHeader);
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
  const reader = upstream.body.getReader();

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        transferred += value.byteLength;
        if (transferred > limit) {
          await writer.abort(new Error("too_large"));
          return;
        }
        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {
        // ignore
      }
    }
  })();

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  });
  if (contentLengthHeader) {
    headers.set("Content-Length", contentLengthHeader);
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
