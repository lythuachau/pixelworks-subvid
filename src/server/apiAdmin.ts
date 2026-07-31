import {
  assertPublicHttpsEndpoint,
  BlockedEndpointError,
} from "./netGuard.ts"
import {
  clearRateLimit,
  clientIp,
  isRateLimited,
  recordRateLimitFailure,
  type RateLimitBinding,
  type RateLimitOptions,
} from "./rateLimit.ts"

type ApiConfigStore = {
  get(key: string, type?: "json"): Promise<unknown>
  put(key: string, value: string): Promise<void>
}

export type ApiAdminEnv = {
  SUBVID_API_ADMIN_USER?: string
  SUBVID_API_ADMIN_PASSWORD_HASH?: string
  SUBVID_API_ADMIN_SESSION_SECRET?: string
  API_CONFIG?: ApiConfigStore
  RATE_LIMITER?: RateLimitBinding
  CUSTOM_TRANSLATE_BASE_URL?: string
  CUSTOM_TRANSLATE_API_KEY?: string
  CUSTOM_TRANSLATE_MODEL?: string
  CUSTOM_TRANSLATE_MODELS?: string
  CUSTOM_TRANSLATE_PROTOCOL?: string
  GEMINI_API_KEY?: string
  GEMINI_TRANSLATE_MODEL?: string
  [key: string]: unknown
}

type StoredApiConfig = {
  provider: "custom" | "gemini"
  custom: {
    baseUrl: string
    apiKey: string
    model: string
    models: string[]
    protocol: string
  }
  gemini: {
    apiKey: string
    model: string
  }
  updatedAt?: string
}

const CONFIG_KEY = "translation-api-config-v1"
const COOKIE_NAME = "subvid_api_admin"
const SESSION_SECONDS = 12 * 60 * 60

/**
 * Login lockout. Counted per source IP *and* per submitted username so a
 * botnet spraying one password cannot slip past a purely per-IP limit.
 */
const LOGIN_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
}

const encoder = new TextEncoder()

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  })
}

function base64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  )
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function safeEqual(a: string, b: string) {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0)
  }
  return diff === 0
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") || ""
  const prefix = `${name}=`
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length)
}

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  )
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))),
  )
}

async function passwordVersion(passwordHash: string) {
  return base64Url((await sha256(passwordHash)).slice(0, 12))
}

async function verifyPassword(password: string, encoded: string) {
  const [algorithm, roundsRaw, saltRaw, expectedRaw] = encoded.split("$")
  const rounds = Number.parseInt(roundsRaw || "", 10)
  if (
    algorithm !== "pbkdf2-sha256" ||
    !Number.isFinite(rounds) ||
    rounds < 100_000 ||
    !saltRaw ||
    !expectedRaw
  ) {
    return false
  }
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    )
    const actual = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: fromBase64Url(saltRaw),
          iterations: rounds,
        },
        material,
        fromBase64Url(expectedRaw).length * 8,
      ),
    )
    return safeEqual(base64Url(actual), expectedRaw)
  } catch {
    return false
  }
}

function configured(env: ApiAdminEnv) {
  return Boolean(
    String(env.SUBVID_API_ADMIN_USER || "").trim() &&
      String(env.SUBVID_API_ADMIN_PASSWORD_HASH || "").trim() &&
      String(env.SUBVID_API_ADMIN_SESSION_SECRET || "").trim(),
  )
}

async function authenticated(request: Request, env: ApiAdminEnv) {
  if (!configured(env)) return false
  const raw = cookieValue(request, COOKIE_NAME)
  if (!raw) return false
  const parts = raw.split(".")
  if (parts.length !== 5 || parts[0] !== "v1") return false
  const [version, expiryRaw, encodedUser, credentialVersion, signature] = parts
  const expiry = Number.parseInt(expiryRaw, 10)
  if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
    return false
  }
  let username = ""
  try {
    username = new TextDecoder().decode(fromBase64Url(encodedUser))
  } catch {
    return false
  }
  const expectedUser = String(env.SUBVID_API_ADMIN_USER || "").trim()
  const expectedVersion = await passwordVersion(
    String(env.SUBVID_API_ADMIN_PASSWORD_HASH || "").trim(),
  )
  if (!safeEqual(username, expectedUser) || !safeEqual(credentialVersion, expectedVersion)) {
    return false
  }
  const body = [version, expiryRaw, encodedUser, credentialVersion].join(".")
  const expectedSignature = await hmac(
    String(env.SUBVID_API_ADMIN_SESSION_SECRET || ""),
    body,
  )
  return safeEqual(signature, expectedSignature)
}

async function sessionCookie(env: ApiAdminEnv) {
  const username = String(env.SUBVID_API_ADMIN_USER || "").trim()
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const encodedUser = base64Url(encoder.encode(username))
  const credentialVersion = await passwordVersion(
    String(env.SUBVID_API_ADMIN_PASSWORD_HASH || "").trim(),
  )
  const body = ["v1", String(expiry), encodedUser, credentialVersion].join(".")
  const signature = await hmac(
    String(env.SUBVID_API_ADMIN_SESSION_SECRET || ""),
    body,
  )
  return `${COOKIE_NAME}=${body}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`
}

function emptyConfig(env: ApiAdminEnv): StoredApiConfig {
  return {
    provider: "custom",
    custom: {
      baseUrl: String(env.CUSTOM_TRANSLATE_BASE_URL || "").trim(),
      apiKey: String(env.CUSTOM_TRANSLATE_API_KEY || "").trim(),
      model: String(env.CUSTOM_TRANSLATE_MODEL || "").trim(),
      models: String(env.CUSTOM_TRANSLATE_MODELS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      protocol: String(env.CUSTOM_TRANSLATE_PROTOCOL || "auto").trim() || "auto",
    },
    gemini: {
      apiKey: String(env.GEMINI_API_KEY || "").trim(),
      model: String(env.GEMINI_TRANSLATE_MODEL || "").trim(),
    },
  }
}

export async function loadStoredApiConfig(env: ApiAdminEnv) {
  const fallback = emptyConfig(env)
  if (!env.API_CONFIG) return fallback
  try {
    const saved = (await env.API_CONFIG.get(CONFIG_KEY, "json")) as
      | Partial<StoredApiConfig>
      | null
    if (!saved) return fallback
    return {
      provider: saved.provider === "gemini" ? "gemini" : "custom",
      custom: {
        ...fallback.custom,
        ...(saved.custom || {}),
        models: Array.isArray(saved.custom?.models)
          ? saved.custom.models.map(String).map((value) => value.trim()).filter(Boolean)
          : fallback.custom.models,
      },
      gemini: {
        ...fallback.gemini,
        ...(saved.gemini || {}),
      },
      updatedAt: saved.updatedAt,
    } satisfies StoredApiConfig
  } catch {
    return fallback
  }
}

export async function withStoredApiConfig(env: ApiAdminEnv) {
  const saved = await loadStoredApiConfig(env)
  return {
    ...env,
    CUSTOM_TRANSLATE_BASE_URL: saved.custom.baseUrl,
    CUSTOM_TRANSLATE_API_KEY: saved.custom.apiKey,
    CUSTOM_TRANSLATE_MODEL: saved.custom.model,
    CUSTOM_TRANSLATE_MODELS: saved.custom.models.join(","),
    CUSTOM_TRANSLATE_PROTOCOL: saved.custom.protocol,
    GEMINI_API_KEY: saved.gemini.apiKey,
    GEMINI_TRANSLATE_MODEL: saved.gemini.model,
  }
}

export async function requireApiAdmin(request: Request, env: ApiAdminEnv) {
  if (!configured(env)) {
    return json(
      {
        ok: false,
        error: "api_admin_not_configured",
        message: "Quản trị API chưa được cấu hình ở backend.",
      },
      503,
    )
  }
  if (!(await authenticated(request, env))) {
    return json(
      {
        ok: false,
        error: "api_admin_authentication_required",
        message: "Cần đăng nhập quản trị để sử dụng API dịch.",
      },
      403,
    )
  }
  return null
}

/**
 * HTTPS-only *and* public-internet-only: an admin must not be able to point
 * the translation endpoint at loopback, RFC1918 or link-local metadata.
 */
function normalizeEndpoint(value: unknown) {
  return assertPublicHttpsEndpoint(value)
}

function loginRateKeys(request: Request, username: string) {
  return [
    `api-admin-login:ip:${clientIp(request)}`,
    `api-admin-login:user:${username.toLowerCase()}`,
  ]
}

function lockedOutResponse(retryAfter: number) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60))
  return json(
    {
      ok: false,
      error: "rate_limited",
      message: `Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau khoảng ${minutes} phút.`,
    },
    429,
    { "Retry-After": String(retryAfter) },
  )
}

export async function handleApiAdmin(request: Request, env: ApiAdminEnv) {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith("/api/api-admin/")) return null

  if (pathname === "/api/api-admin/status" && request.method === "GET") {
    return json({
      ok: true,
      configured: configured(env),
      authenticated: await authenticated(request, env),
    })
  }

  if (pathname === "/api/api-admin/login" && request.method === "POST") {
    if (!configured(env)) {
      return json(
        {
          ok: false,
          error: "api_admin_not_configured",
          message: "Quản trị API chưa được cấu hình ở backend.",
        },
        503,
      )
    }
    let body: Record<string, unknown> = {}
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return json({ ok: false, error: "bad_json", message: "Dữ liệu đăng nhập không hợp lệ." }, 400)
    }
    const username = String(body.username || "").trim()
    const password = String(body.password || "")
    const rateKeys = loginRateKeys(request, username)

    const existing = await Promise.all(
      rateKeys.map((key) => isRateLimited(env, key, LOGIN_LIMIT)),
    )
    const blocked = existing.find((decision) => decision.blocked)
    if (blocked) return lockedOutResponse(blocked.retryAfter)

    const expectedUser = String(env.SUBVID_API_ADMIN_USER || "").trim()
    const userOk = safeEqual(username, expectedUser)
    const passwordOk = await verifyPassword(
      password,
      String(env.SUBVID_API_ADMIN_PASSWORD_HASH || "").trim(),
    )
    if (!(userOk && passwordOk)) {
      const recorded = await Promise.all(
        rateKeys.map((key) => recordRateLimitFailure(env, key, LOGIN_LIMIT)),
      )
      const tripped = recorded.find((decision) => decision.blocked)
      if (tripped) return lockedOutResponse(tripped.retryAfter)
      return json(
        {
          ok: false,
          error: "invalid_credentials",
          message: "Tài khoản hoặc mật khẩu quản trị không đúng.",
        },
        401,
      )
    }

    await Promise.all(rateKeys.map((key) => clearRateLimit(env, key, LOGIN_LIMIT)))
    return json(
      { ok: true, authenticated: true, username: expectedUser },
      200,
      { "Set-Cookie": await sessionCookie(env) },
    )
  }

  if (pathname === "/api/api-admin/logout" && request.method === "POST") {
    return json(
      { ok: true, authenticated: false },
      200,
      {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      },
    )
  }

  if (pathname === "/api/api-admin/config") {
    const denied = await requireApiAdmin(request, env)
    if (denied) return denied
    const saved = await loadStoredApiConfig(env)
    if (request.method === "GET") {
      return json({
        ok: true,
        provider: saved.provider,
        custom: {
          baseUrl: saved.custom.baseUrl,
          model: saved.custom.model,
          models: saved.custom.models,
          protocol: saved.custom.protocol,
          hasApiKey: Boolean(saved.custom.apiKey),
        },
        gemini: {
          model: saved.gemini.model,
          hasApiKey: Boolean(saved.gemini.apiKey),
        },
        updatedAt: saved.updatedAt || null,
      })
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405)
    }
    if (!env.API_CONFIG) {
      return json(
        {
          ok: false,
          error: "config_store_missing",
          message: "Kho cấu hình backend chưa được cấu hình.",
        },
        503,
      )
    }
    let body: any = {}
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, error: "bad_json", message: "Cấu hình không hợp lệ." }, 400)
    }
    let customBaseUrl = saved.custom.baseUrl
    try {
      if (body.custom) {
        customBaseUrl = normalizeEndpoint(body.custom.baseUrl || saved.custom.baseUrl)
      }
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof BlockedEndpointError ? "blocked_endpoint" : "invalid_endpoint",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      )
    }

    // The stored key is bound to the stored endpoint. Repointing baseUrl while
    // reusing it would forward the secret to an operator-chosen host — the
    // admin UI deliberately never discloses the key, so that would be an
    // exfiltration path. Changing the endpoint requires supplying a new key.
    const submittedCustomKey = String(body.custom?.apiKey || "").trim()
    if (
      customBaseUrl !== saved.custom.baseUrl &&
      saved.custom.apiKey &&
      !submittedCustomKey
    ) {
      return json(
        {
          ok: false,
          error: "api_key_required",
          message:
            "Đổi endpoint thì phải nhập lại API key — key đã lưu không được gửi sang endpoint mới.",
        },
        400,
      )
    }

    const next: StoredApiConfig = {
      provider:
        body.provider === "gemini"
          ? "gemini"
          : body.provider === "custom"
            ? "custom"
            : saved.provider,
      custom: {
        baseUrl: customBaseUrl,
        apiKey: String(body.custom?.apiKey || saved.custom.apiKey).trim(),
        model: String(body.custom?.model || saved.custom.model).trim(),
        models: Array.isArray(body.custom?.models)
          ? body.custom.models.map(String).map((value: string) => value.trim()).filter(Boolean)
          : saved.custom.models,
        protocol: String(body.custom?.protocol || saved.custom.protocol || "auto"),
      },
      gemini: {
        apiKey: String(body.gemini?.apiKey || saved.gemini.apiKey).trim(),
        model: String(body.gemini?.model || saved.gemini.model).trim(),
      },
      updatedAt: new Date().toISOString(),
    }
    await env.API_CONFIG.put(CONFIG_KEY, JSON.stringify(next))
    return json({
      ok: true,
      provider: next.provider,
      custom: {
        baseUrl: next.custom.baseUrl,
        model: next.custom.model,
        models: next.custom.models,
        protocol: next.custom.protocol,
        hasApiKey: Boolean(next.custom.apiKey),
      },
      gemini: {
        model: next.gemini.model,
        hasApiKey: Boolean(next.gemini.apiKey),
      },
      updatedAt: next.updatedAt,
    })
  }

  return json({ ok: false, error: "not_found" }, 404)
}
