/**
 * Durable Object backing `src/server/rateLimit.ts`.
 *
 * One object per rate-limit key. Durable Object fetch handlers are gated so a
 * read-modify-write inside a single handler is atomic — which is exactly what
 * a login lockout needs and what KV (eventually consistent) cannot provide.
 *
 * Kept in its own module so the pure `rateLimit.ts` helpers stay importable
 * from plain Node (`pnpm test`) without the `cloudflare:workers` runtime.
 */
import { DurableObject } from "cloudflare:workers"

import {
  applyRateLimit,
  type RateLimitEntry,
  type RateLimitOp,
  type RateLimitOptions,
} from "@/server/rateLimit.ts"

const STATE_KEY = "state"

export class RateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    let body: { op?: RateLimitOp; options?: RateLimitOptions }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return new Response("bad request", { status: 400 })
    }

    const op: RateLimitOp =
      body.op === "hit" || body.op === "reset" ? body.op : "peek"
    const options: RateLimitOptions = {
      limit: Math.max(1, Number(body.options?.limit) || 5),
      windowMs: Math.max(1_000, Number(body.options?.windowMs) || 60_000),
      lockoutMs: body.options?.lockoutMs
        ? Math.max(1_000, Number(body.options.lockoutMs))
        : undefined,
    }

    const storage = this.ctx.storage
    const current = (await storage.get<RateLimitEntry>(STATE_KEY)) ?? undefined
    const result = applyRateLimit(current, op, options, Date.now())

    if (result.entry) {
      await storage.put(STATE_KEY, result.entry)
      // Let the object evict itself once the window and lockout have passed.
      const expiry =
        Math.max(result.entry.blockedUntil, result.entry.firstAt + options.windowMs) +
        60_000
      await storage.setAlarm(expiry)
    } else {
      await storage.deleteAll()
    }

    return Response.json({
      blocked: result.blocked,
      retryAfter: result.retryAfter,
    })
  }

  async alarm(): Promise<void> {
    const entry = await this.ctx.storage.get<RateLimitEntry>(STATE_KEY)
    if (!entry) return
    if (entry.blockedUntil <= Date.now()) await this.ctx.storage.deleteAll()
  }
}
