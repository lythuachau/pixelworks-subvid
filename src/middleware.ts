import { defineMiddleware } from "astro:middleware"

// Astro's built-in security.checkOrigin compares the browser Origin against the
// request URL, which the Node adapter derives from the Host header. Caddy sends
// `header_up Host localhost:4321`, so that comparison always fails behind the
// reverse proxy and every form POST turns into a 403 — including the
// multipart upload at /api/speech/transcribe.
//
// checkOrigin is disabled in astro.config.mjs and replaced by this guard, which
// rebuilds the externally visible origin from the proxy's X-Forwarded-* headers.
// Those headers are trustworthy here: the Node server binds to 127.0.0.1 only,
// so requests always arrive through Caddy, and a browser cannot set custom
// headers on a cross-site form POST (a fetch that tries triggers a preflight
// this app never approves).

// Same rule Astro applies: only content types a cross-site HTML form can
// produce need CSRF checking. JSON bodies are already preflight-protected.
const FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function firstHeaderValue(value: string | null) {
  // X-Forwarded-* may accumulate a comma-separated chain; the first entry is
  // the value the outermost proxy saw from the client.
  return String(value || "")
    .split(",")[0]
    .trim()
}

function allowedOrigins(request: Request, url: URL) {
  const origins = new Set<string>()
  const headers = request.headers

  const forwardedHost = firstHeaderValue(headers.get("x-forwarded-host"))
  if (forwardedHost) {
    const proto = firstHeaderValue(headers.get("x-forwarded-proto")) || "https"
    origins.add(`${proto}://${forwardedHost}`)
    // Accept both schemes for the proxied hostname so a proxy that omits
    // X-Forwarded-Proto cannot lock out legitimate traffic.
    origins.add(`https://${forwardedHost}`)
    origins.add(`http://${forwardedHost}`)
  }

  // Direct (unproxied) access, e.g. local dev and `astro preview`.
  origins.add(url.origin)

  // Optional escape hatch for extra hostnames, comma-separated.
  for (const extra of String(process.env.SUBVID_TRUSTED_ORIGINS || "").split(",")) {
    const trimmed = extra.trim()
    if (trimmed) origins.add(trimmed.replace(/\/+$/, ""))
  }

  return origins
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context
  const method = request.method.toUpperCase()

  if (SAFE_METHODS.has(method)) return next()

  const contentType = String(request.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (!FORM_CONTENT_TYPES.includes(contentType)) return next()

  const origin = request.headers.get("origin")
  // A missing Origin means the request did not come from a browser page
  // context, which is how Astro treats it as well.
  if (!origin) return next()

  if (!allowedOrigins(request, context.url).has(origin)) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "forbidden_origin",
        message: "Yêu cầu bị từ chối vì nguồn gửi không hợp lệ.",
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  }

  return next()
})
