import type { APIRoute } from "astro"

import { handleApiAdmin, requireApiAdmin, withStoredApiConfig } from "@/server/apiAdmin.ts"
import { handleMediaApi } from "@/server/mediaApi.ts"
import { nodeRuntimeEnv } from "@/server/nodeRuntime.ts"
import { handleSpeechApi } from "@/server/speechApi.ts"
import { handleTranslateApi } from "@/server/translateApi.ts"

export const prerender = false

export const ALL: APIRoute = async ({ request }) => {
  const env = nodeRuntimeEnv() as any
  const { pathname } = new URL(request.url)

  const admin = await handleApiAdmin(request, env)
  if (admin) return admin
  const media = await handleMediaApi(request, env)
  if (media) return media
  const speech = await handleSpeechApi(request, env)
  if (speech) return speech

  if (pathname.startsWith("/api/translate")) {
    if (pathname !== "/api/translate/status") {
      const denied = await requireApiAdmin(request, env)
      if (denied) return denied
    }
    const translated = await handleTranslateApi(request, await withStoredApiConfig(env))
    if (translated) return translated
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 })
}
