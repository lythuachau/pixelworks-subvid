import type { APIRoute } from "astro"

import { nodeRuntimeReady } from "@/server/nodeRuntime.ts"

export const prerender = false

export const GET: APIRoute = async () => {
  try {
    return Response.json(await nodeRuntimeReady(), {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  } catch {
    return Response.json(
      { ok: false, error: "not_ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }
}
