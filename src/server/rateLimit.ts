/**
 * Rate limiting that survives the Workers isolate lifecycle.
 *
 * A per-isolate `Map` resets whenever Cloudflare recycles the isolate and is
 * not shared between colos, so it cannot enforce a login lockout. When the
 * `RATE_LIMITER` Durable Object binding is present all counters live there
 * (single-threaded, strongly consistent). The in-memory map stays as a
 * best-effort fallback for `wrangler dev` and for deployments that have not
 * applied the Durable Object migration yet.
 */

export type RateLimitOptions = {
  /** Failures allowed inside the window before the key is blocked. */
  limit: number
  /** Rolling window in milliseconds. */
  windowMs: number
  /** How long a key stays blocked once the limit is hit. Defaults to windowMs. */
  lockoutMs?: number
}

export type RateDecision = {
  blocked: boolean
  /** Seconds the caller should wait; 0 when not blocked. */
  retryAfter: number
  /** True when the decision came from the isolate-local fallback. */
  degraded: boolean
}

type DurableObjectStubLike = {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

export type RateLimitBinding = {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStubLike
}

export type RateLimitEnv = {
  RATE_LIMITER?: RateLimitBinding
  [key: string]: unknown
}

export type RateLimitOp = "peek" | "hit" | "reset"

export type RateLimitEntry = {
  count: number
  firstAt: number
  blockedUntil: number
}

type Entry = RateLimitEntry

const memory = new Map<string, Entry>()

const ALLOWED: RateDecision = { blocked: false, retryAfter: 0, degraded: false }

/**
 * Pure state machine shared by the Durable Object and the in-memory fallback,
 * so both enforce identical semantics (and so it is unit-testable).
 */
export function applyRateLimit(
  entry: Entry | undefined,
  op: RateLimitOp,
  options: RateLimitOptions,
  now: number,
): { entry: Entry | undefined; blocked: boolean; retryAfter: number } {
  const lockoutMs = options.lockoutMs ?? options.windowMs

  if (op === "reset") return { entry: undefined, blocked: false, retryAfter: 0 }

  if (entry && entry.blockedUntil > now) {
    return {
      entry,
      blocked: true,
      retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
    }
  }

  // Expired window (or expired lockout) starts over.
  const active =
    entry && entry.blockedUntil <= now && now - entry.firstAt < options.windowMs
      ? entry
      : undefined

  if (op === "peek") {
    return { entry: active, blocked: false, retryAfter: 0 }
  }

  const next: Entry = active
    ? { ...active, count: active.count + 1 }
    : { count: 1, firstAt: now, blockedUntil: 0 }

  if (next.count >= options.limit) {
    next.blockedUntil = now + lockoutMs
    return {
      entry: next,
      blocked: true,
      retryAfter: Math.max(1, Math.ceil(lockoutMs / 1000)),
    }
  }

  return { entry: next, blocked: false, retryAfter: 0 }
}

function memoryDecision(
  key: string,
  op: RateLimitOp,
  options: RateLimitOptions,
): RateDecision {
  const now = Date.now()
  const result = applyRateLimit(memory.get(key), op, options, now)
  if (result.entry) memory.set(key, result.entry)
  else memory.delete(key)

  // Opportunistic sweep so a long-lived isolate does not grow unbounded.
  if (memory.size > 5_000) {
    for (const [existingKey, entry] of memory) {
      if (entry.blockedUntil <= now && now - entry.firstAt >= options.windowMs) {
        memory.delete(existingKey)
      }
    }
  }

  return { blocked: result.blocked, retryAfter: result.retryAfter, degraded: true }
}

/**
 * Apply `op` to `key`.
 *  - `peek`  — is this key currently locked out? (does not count)
 *  - `hit`   — record one failure and report whether that tripped the limit
 *  - `reset` — clear the counter (call after a successful login)
 */
export async function rateLimitOp(
  env: RateLimitEnv,
  key: string,
  op: RateLimitOp,
  options: RateLimitOptions,
): Promise<RateDecision> {
  const binding = env.RATE_LIMITER
  if (!binding) return memoryDecision(key, op, options)

  try {
    const stub = binding.get(binding.idFromName(key))
    const response = await stub.fetch("https://rate-limiter.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, options }),
    })
    if (!response.ok) return memoryDecision(key, op, options)
    const data = (await response.json()) as { blocked?: boolean; retryAfter?: number }
    return {
      blocked: Boolean(data.blocked),
      retryAfter: Number(data.retryAfter) || 0,
      degraded: false,
    }
  } catch {
    // Never fail the request because the limiter is unreachable.
    return memoryDecision(key, op, options)
  }
}

export async function isRateLimited(
  env: RateLimitEnv,
  key: string,
  options: RateLimitOptions,
): Promise<RateDecision> {
  return rateLimitOp(env, key, "peek", options)
}

export async function recordRateLimitFailure(
  env: RateLimitEnv,
  key: string,
  options: RateLimitOptions,
): Promise<RateDecision> {
  return rateLimitOp(env, key, "hit", options)
}

export async function clearRateLimit(
  env: RateLimitEnv,
  key: string,
  options: RateLimitOptions,
): Promise<void> {
  await rateLimitOp(env, key, "reset", options)
}

export function allowedDecision(): RateDecision {
  return ALLOWED
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  )
}
