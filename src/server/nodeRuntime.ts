import { createHmac, randomBytes, webcrypto } from "node:crypto"

import pg from "pg"

import type { RateLimitBinding, RateLimitOptions } from "./rateLimit.ts"

type StoredRow = { ciphertext: Buffer; iv: Buffer }

const { Pool } = pg
const CONFIG_KEY = "translation-api-config-v1"
let runtime: Record<string, unknown> | undefined

function dataKey() {
  const encoded = String(process.env.SUBVID_CONFIG_DATA_KEY || "").trim()
  if (!encoded) throw new Error("SUBVID_CONFIG_DATA_KEY is not configured")
  const key = Buffer.from(encoded, "base64")
  if (key.length !== 32) throw new Error("SUBVID_CONFIG_DATA_KEY must decode to 32 bytes")
  return key
}

async function aesKey() {
  return webcrypto.subtle.importKey("raw", dataKey(), "AES-GCM", false, ["encrypt", "decrypt"])
}

async function encrypt(value: string) {
  const iv = randomBytes(12)
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: Buffer.from(CONFIG_KEY) },
    await aesKey(),
    Buffer.from(value, "utf8"),
  )
  return { iv, ciphertext: Buffer.from(ciphertext) }
}

async function decrypt(row: StoredRow) {
  const cleartext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: row.iv, additionalData: Buffer.from(CONFIG_KEY) },
    await aesKey(),
    row.ciphertext,
  )
  return Buffer.from(cleartext).toString("utf8")
}

function pool() {
  const connectionString = String(process.env.SUBVID_DATABASE_URL || "").trim()
  if (!connectionString) throw new Error("SUBVID_DATABASE_URL is not configured")
  return new Pool({ connectionString, max: 4, application_name: "subvid-web" })
}

function configStore(database: InstanceType<typeof Pool>) {
  return {
    async get(key: string, type?: "json") {
      if (key !== CONFIG_KEY) return null
      const result = await database.query<StoredRow>(
        "SELECT ciphertext, iv FROM subvid_runtime_config WHERE config_key = $1",
        [key],
      )
      if (!result.rowCount) return null
      const value = await decrypt(result.rows[0])
      return type === "json" ? JSON.parse(value) : value
    },
    async put(key: string, value: string) {
      if (key !== CONFIG_KEY) throw new Error("Unsupported config key")
      const sealed = await encrypt(value)
      await database.query(
        `INSERT INTO subvid_runtime_config (config_key, ciphertext, iv, updated_at)
         VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (config_key) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           updated_at = EXCLUDED.updated_at`,
        [key, sealed.ciphertext, sealed.iv],
      )
    },
  }
}

function rateLimitBinding(database: InstanceType<typeof Pool>): RateLimitBinding {
  const hashKey = dataKey()
  return {
    idFromName(name: string) {
      return createHmac("sha256", hashKey).update(`rate-limit:${name}`).digest("hex")
    },
    get(id: unknown) {
      const identity = String(id)
      return {
        async fetch(_input: string, init?: RequestInit) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            op?: "peek" | "hit" | "reset"
            options?: RateLimitOptions
          }
          const options = body.options || { limit: 5, windowMs: 60_000 }
          const client = await database.connect()
          try {
            await client.query("BEGIN")
            const current = await client.query<{
              count: number
              first_at: Date
              blocked_until: Date | null
            }>(
              `SELECT count, first_at, blocked_until
                 FROM subvid_rate_limits WHERE identity_hash = $1 FOR UPDATE`,
              [identity],
            )
            const nowResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
            const now = nowResult.rows[0].now.getTime()
            const row = current.rows[0]
            const lockoutMs = options.lockoutMs ?? options.windowMs
            let count = row?.count || 0
            let firstAt = row?.first_at.getTime() || now
            let blockedUntil = row?.blocked_until?.getTime() || 0
            if (body.op === "reset") {
              await client.query("DELETE FROM subvid_rate_limits WHERE identity_hash = $1", [identity])
              await client.query("COMMIT")
              return Response.json({ blocked: false, retryAfter: 0 })
            }
            if (blockedUntil > now) {
              await client.query("COMMIT")
              return Response.json({ blocked: true, retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) })
            }
            if (now - firstAt >= options.windowMs) {
              count = 0
              firstAt = now
              blockedUntil = 0
            }
            if (body.op === "hit") count += 1
            if (count >= options.limit) blockedUntil = now + lockoutMs
            if (body.op === "hit") {
              await client.query(
                `INSERT INTO subvid_rate_limits (identity_hash, count, first_at, blocked_until)
                 VALUES ($1, $2, to_timestamp($3 / 1000.0), CASE WHEN $4 = 0 THEN NULL ELSE to_timestamp($4 / 1000.0) END)
                 ON CONFLICT (identity_hash) DO UPDATE SET count = EXCLUDED.count,
                   first_at = EXCLUDED.first_at, blocked_until = EXCLUDED.blocked_until`,
                [identity, count, firstAt, blockedUntil],
              )
            }
            await client.query("COMMIT")
            return Response.json({
              blocked: blockedUntil > now,
              retryAfter: blockedUntil > now ? Math.max(1, Math.ceil((blockedUntil - now) / 1000)) : 0,
            })
          } catch {
            await client.query("ROLLBACK")
            return new Response(null, { status: 503 })
          } finally {
            client.release()
          }
        },
      }
    },
  }
}

export function nodeRuntimeEnv() {
  if (runtime) return runtime
  runtime = { ...process.env }
  if (process.env.SUBVID_DATABASE_URL && process.env.SUBVID_CONFIG_DATA_KEY) {
    const database = pool()
    runtime.API_CONFIG = configStore(database)
    runtime.RATE_LIMITER = rateLimitBinding(database)
  }
  return runtime
}

export async function nodeRuntimeReady() {
  const database = pool()
  try {
    await database.query("SELECT 1")
    dataKey()
    return { ok: true }
  } finally {
    await database.end()
  }
}
