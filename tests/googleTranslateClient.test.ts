import assert from "node:assert/strict"
import test from "node:test"
import {
  getTranslateStatus,
  invalidateTranslateStatus,
  resolveAvailableTranslateProvider,
  saveTranslateSettings,
} from "../src/scripts/googleTranslateClient.ts"

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  clear() {
    this.values.clear()
  }
}

test("stale Gemini selection falls back to configured Custom backend", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  })
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      ok: true,
      preferred: "custom",
      custom: { ok: true, configured: true },
      gemini: { ok: false, configured: false },
    }), { status: 200 })
  invalidateTranslateStatus()
  saveTranslateSettings({ provider: "gemini" })

  assert.equal(await resolveAvailableTranslateProvider("gemini"), "custom")
})

test("saving translation settings invalidates cached backend status", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  })
  let customOk = false
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(JSON.stringify({
      ok: customOk,
      custom: { ok: customOk, configured: customOk },
      gemini: { ok: false, configured: false },
    }), { status: 200 })
  }
  invalidateTranslateStatus()

  assert.equal((await getTranslateStatus()).custom?.ok, false)
  customOk = true
  saveTranslateSettings({ provider: "custom" })
  assert.equal((await getTranslateStatus()).custom?.ok, true)
  assert.equal(requests, 2)
})
