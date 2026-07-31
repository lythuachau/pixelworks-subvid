import { handle } from "@astrojs/cloudflare/handler"
import { defaultLang, languages } from "@/i18n/locales"
import { handleMediaApi } from "@/server/mediaApi.ts"
import { handleSpeechApi } from "@/server/speechApi.ts"
import { handleTranslateApi } from "@/server/translateApi.ts"
import {
  handleApiAdmin,
  requireApiAdmin,
  withStoredApiConfig,
} from "@/server/apiAdmin.ts"
import type { RateLimitBinding } from "@/server/rateLimit.ts"

// Durable Object backing the login lockout and proxy rate limits.
export { RateLimiter } from "@/server/rateLimiterDo.ts"

const LOCALES = Object.keys(languages)
const LOCALE_COOKIE = "locale"
const VARY = "Accept-Language, Cookie"

type WorkerEnv = {
  COBALT_API_URL?: string
  COBALT_API_KEY?: string
  MEDIA_PROXY_SECRET?: string
  MEDIA_MAX_BYTES?: string
  GROQ_API_KEY?: string
  GROQ_API_URL?: string
  GROQ_TRANSCRIBE_MODELS?: string
  CUSTOM_TRANSLATE_BASE_URL?: string
  CUSTOM_TRANSLATE_API_KEY?: string
  CUSTOM_TRANSLATE_MODEL?: string
  CUSTOM_TRANSLATE_MODELS?: string
  CUSTOM_TRANSLATE_PROTOCOL?: string
  GEMINI_API_KEY?: string
  GEMINI_TRANSLATE_MODEL?: string
  SUBVID_API_ADMIN_USER?: string
  SUBVID_API_ADMIN_PASSWORD_HASH?: string
  SUBVID_API_ADMIN_SESSION_SECRET?: string
  API_CONFIG?: {
    get(key: string, type?: "json"): Promise<unknown>
    put(key: string, value: string): Promise<void>
  }
  RATE_LIMITER?: RateLimitBinding
  [key: string]: unknown
}

function validLocale(value: string | undefined) {
  return value && LOCALES.includes(value) ? value : undefined
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie")
  if (!cookie) return undefined

  const prefix = `${name}=`
  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))

  if (!match) return undefined

  try {
    return decodeURIComponent(match.slice(prefix.length))
  } catch {
    return match.slice(prefix.length)
  }
}

function preferredLocale(request: Request) {
  const header = request.headers.get("Accept-Language")
  if (!header) return undefined

  return header
    .split(",")
    .map((entry) => {
      const [range = "", qValue] = entry.trim().split(";q=")
      const locale = range.toLowerCase().split("-")[0]
      const quality = qValue ? Number.parseFloat(qValue) : 1

      return {
        locale: validLocale(locale),
        quality: Number.isFinite(quality) ? quality : 0,
      }
    })
    .filter((entry) => entry.locale && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)[0]?.locale
}

function localeRedirect(request: Request) {
  const chosen = validLocale(cookieValue(request, LOCALE_COOKIE))
  const target = chosen ?? preferredLocale(request)

  if (!target || target === defaultLang) return undefined

  const url = new URL(request.url)
  url.pathname = `/${target}/`
  url.search = ""

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "private, no-store",
      Vary: VARY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
    },
  })
}

export default {
  async fetch(request, env, context) {
    const { pathname } = new URL(request.url)

    const adminResponse = await handleApiAdmin(request, env as WorkerEnv)
    if (adminResponse) return adminResponse

    const mediaResponse = await handleMediaApi(request, env as WorkerEnv)
    if (mediaResponse) return mediaResponse

    const speechResponse = await handleSpeechApi(request, env as WorkerEnv)
    if (speechResponse) return speechResponse

    if (pathname.startsWith("/api/translate")) {
      if (pathname !== "/api/translate/status") {
        const denied = await requireApiAdmin(request, env as WorkerEnv)
        if (denied) return denied
      }
      const runtimeEnv = await withStoredApiConfig(env as WorkerEnv)
      const translateResponse = await handleTranslateApi(request, runtimeEnv)
      if (translateResponse) return translateResponse
    }

    if (pathname === "/") {
      const redirect = localeRedirect(request)
      if (redirect) return redirect
    }

    return handle(request, env, context)
  },
} satisfies ExportedHandler<WorkerEnv>
