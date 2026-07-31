import { handleMediaApi } from "./server/mediaApi.ts"
import { handleSpeechApi } from "./server/speechApi.ts"
import { handleTranslateApi } from "./server/translateApi.ts"
import {
  handleApiAdmin,
  requireApiAdmin,
  withStoredApiConfig,
} from "./server/apiAdmin.ts"
import type { RateLimitBinding } from "./server/rateLimit.ts"

export { RateLimiter } from "./server/rateLimiterDo.ts"

type ApiWorkerEnv = {
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

function notFound() {
  return new Response(
    JSON.stringify({ ok: false, error: "not_found" }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)

    const adminResponse = await handleApiAdmin(request, env)
    if (adminResponse) return adminResponse

    const mediaResponse = await handleMediaApi(request, env)
    if (mediaResponse) return mediaResponse

    const speechResponse = await handleSpeechApi(request, env)
    if (speechResponse) return speechResponse

    if (pathname.startsWith("/api/translate")) {
      if (pathname !== "/api/translate/status") {
        const denied = await requireApiAdmin(request, env)
        if (denied) return denied
      }
      const runtimeEnv = await withStoredApiConfig(env)
      const response = await handleTranslateApi(request, runtimeEnv)
      if (response) return response
    }

    return notFound()
  },
} satisfies ExportedHandler<ApiWorkerEnv>
