import assert from "node:assert/strict"
import test from "node:test"
import {
  handleApiAdmin,
  requireApiAdmin,
  withStoredApiConfig,
  type ApiAdminEnv,
} from "../src/server/apiAdmin.ts"

function b64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

async function passwordHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
      material,
      256,
    ),
  )
  return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(derived)}`
}

test("API admin locks config, signs a session, and keeps API keys server-side", async () => {
  const store = new Map<string, string>()
  const env: ApiAdminEnv = {
    SUBVID_API_ADMIN_USER: "admin",
    SUBVID_API_ADMIN_PASSWORD_HASH: await passwordHash("secret"),
    SUBVID_API_ADMIN_SESSION_SECRET: "test-session-secret-with-enough-entropy",
    API_CONFIG: {
      async get(key, type) {
        const value = store.get(key)
        return type === "json" && value ? JSON.parse(value) : value
      },
      async put(key, value) {
        store.set(key, value)
      },
    },
  }

  const locked = await requireApiAdmin(
    new Request("https://subvid.test/api/translate/models"),
    env,
  )
  assert.equal(locked?.status, 403)

  const login = await handleApiAdmin(
    new Request("https://subvid.test/api/api-admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" }),
    }),
    env,
  )
  assert.equal(login?.status, 200)
  const cookie = login?.headers.get("Set-Cookie")?.split(";", 1)[0]
  assert.ok(cookie)

  const authenticatedRequest = (path: string, init: RequestInit = {}) =>
    new Request(`https://subvid.test${path}`, {
      ...init,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    })

  assert.equal(
    await requireApiAdmin(
      authenticatedRequest("/api/translate/models"),
      env,
    ),
    null,
  )

  const saved = await handleApiAdmin(
    authenticatedRequest("/api/api-admin/config", {
      method: "POST",
      body: JSON.stringify({
        provider: "custom",
        custom: {
          baseUrl: "https://api.example.com",
          apiKey: "private-key",
          model: "model-a",
          models: ["model-a"],
          protocol: "openai",
        },
      }),
    }),
    env,
  )
  const savedBody: any = await saved?.json()
  assert.equal(savedBody.custom.hasApiKey, true)
  assert.equal(JSON.stringify(savedBody).includes("private-key"), false)

  const runtime = await withStoredApiConfig(env)
  assert.equal(runtime.CUSTOM_TRANSLATE_API_KEY, "private-key")
  assert.equal(runtime.CUSTOM_TRANSLATE_MODEL, "model-a")

  const changedEnv = {
    ...env,
    SUBVID_API_ADMIN_PASSWORD_HASH: await passwordHash("new-secret"),
  }
  const revoked = await requireApiAdmin(
    authenticatedRequest("/api/translate/models"),
    changedEnv,
  )
  assert.equal(revoked?.status, 403)
})
