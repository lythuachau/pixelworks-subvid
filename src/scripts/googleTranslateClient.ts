/**
 * Client for local translation proxy (/api/translate/*).
 * Supports Gemini and custom OpenAI/Anthropic-compatible endpoints.
 * API keys stay on the server (or are posted only to localhost).
 */

export type TranslateProvider = "auto" | "gemini" | "custom"
export type CustomTranslateProtocol =
  | "auto"
  | "anthropic"
  | "openai"
  | "responses"

export type TranslateStatus = {
  ok: boolean
  preferred?: TranslateProvider
  gemini?: {
    ok?: boolean
    engine?: string
    provider?: string
    model?: string
    configured?: boolean
    message?: string
  }
  custom?: {
    ok?: boolean
    engine?: string
    configured?: boolean
    baseUrl?: string
    model?: string
    models?: string[]
    protocol?: string
    hasApiKey?: boolean
    message?: string
  }
  message?: string
}

export type CustomTranslateOptions = {
  provider?: TranslateProvider
  model?: string
  models?: string[]
  baseUrl?: string
  apiKey?: string
  geminiApiKey?: string
  protocol?: CustomTranslateProtocol
  glossary?: string[]
  /**
   * Per-line character ceiling, one entry per text. Lets the server tell the
   * model how much room each line has on screen so translations stop
   * overflowing the cue they belong to.
   */
  budgets?: number[]
  signal?: AbortSignal
}

export type TranslateApiTestOptions = {
  provider?: TranslateProvider
  model?: string
  models?: string[]
  baseUrl?: string
  apiKey?: string
  geminiApiKey?: string
  protocol?: CustomTranslateProtocol
  sampleText?: string
  signal?: AbortSignal
}

export type TranslateApiTestResult = {
  elapsedMs: number
  httpStatus: number
  engine?: string
  model?: string
  strategy?: string
  translation: string
  diagnostic?: string
}

const LS_KEY = "subvid.translate.custom.v1"
const GEMINI_LS_KEY = "subvid.translate.gemini.v1"

export type SavedCustomTranslateSettings = {
  provider: TranslateProvider
  baseUrl: string
  apiKey: string
  model: string
  verifiedModel: string
  models: string[]
  protocol: CustomTranslateProtocol
}

export type SavedGeminiSettings = {
  apiKey: string
  model: string
}

export function loadSavedTranslateSettings(): SavedCustomTranslateSettings {
  const defaults: SavedCustomTranslateSettings = {
    provider: "custom",
    baseUrl: "",
    apiKey: "",
    model: "",
    verifiedModel: "",
    models: [],
    protocol: "auto",
  }
  if (typeof localStorage === "undefined") return defaults
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    return {
      provider: (["auto", "gemini", "custom"].includes(parsed.provider)
        ? parsed.provider
        : "custom") as TranslateProvider,
      baseUrl: String(parsed.baseUrl || ""),
      apiKey: String(parsed.apiKey || ""),
      model: String(parsed.model || ""),
      verifiedModel: String(parsed.verifiedModel || ""),
      models: Array.isArray(parsed.models)
        ? [...new Set(parsed.models.map(String).map((item: string) => item.trim()).filter(Boolean))]
        : [],
      protocol: (["auto", "anthropic", "openai", "responses"].includes(parsed.protocol)
        ? parsed.protocol
        : "auto") as SavedCustomTranslateSettings["protocol"],
    }
  } catch {
    return defaults
  }
}

export function saveTranslateSettings(settings: Partial<SavedCustomTranslateSettings>) {
  if (typeof localStorage === "undefined") return
  const next = { ...loadSavedTranslateSettings(), ...settings }
  localStorage.setItem(LS_KEY, JSON.stringify(next))
}

export function loadSavedGeminiSettings(): SavedGeminiSettings {
  const defaults: SavedGeminiSettings = { apiKey: "", model: "" }
  if (typeof localStorage === "undefined") return defaults
  try {
    const raw = localStorage.getItem(GEMINI_LS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    return {
      apiKey: String(parsed.apiKey || ""),
      model: String(parsed.model || ""),
    }
  } catch {
    return defaults
  }
}

export function saveGeminiSettings(settings: Partial<SavedGeminiSettings>) {
  if (typeof localStorage === "undefined") return
  const next = { ...loadSavedGeminiSettings(), ...settings }
  localStorage.setItem(GEMINI_LS_KEY, JSON.stringify(next))
}

let cachedStatus: TranslateStatus | null = null
let statusPromise: Promise<TranslateStatus> | null = null

export async function getTranslateStatus(force = false): Promise<TranslateStatus> {
  if (!force && cachedStatus) return cachedStatus
  if (!force && statusPromise) return statusPromise

  statusPromise = (async () => {
    try {
      const res = await fetch("/api/translate/status", { cache: "no-store" })
      if (!res.ok) {
        cachedStatus = {
          ok: false,
          message: `Translate status HTTP ${res.status}`,
        }
        return cachedStatus
      }
      const data = (await res.json()) as TranslateStatus
      cachedStatus = data
      return data
    } catch (error) {
      cachedStatus = {
        ok: false,
        message: String((error as Error)?.message || error),
      }
      return cachedStatus
    } finally {
      statusPromise = null
    }
  })()

  return statusPromise
}

/** @deprecated use getTranslateStatus */
export async function getGoogleTranslateStatus(force = false) {
  return getTranslateStatus(force)
}

export async function isGoogleTranslateAvailable(): Promise<boolean> {
  const status = await getTranslateStatus()
  return !!(status.ok && (status.gemini?.ok || status.custom?.ok))
}

export async function isApiTranslateAvailable(
  provider: TranslateProvider = "auto",
): Promise<boolean> {
  const status = await getTranslateStatus()
  if (provider === "gemini") {
    const saved = loadSavedGeminiSettings()
    return !!(status.gemini?.ok || (saved.apiKey && saved.model))
  }
  if (provider === "custom") {
    // Custom may be configured from UI even if server .env is empty.
    const saved = loadSavedTranslateSettings()
    return !!(
      status.custom?.ok ||
      (saved.baseUrl && saved.apiKey && (saved.model || saved.models.length))
    )
  }
  const gemini = loadSavedGeminiSettings()
  return !!(status.gemini?.ok || (gemini.apiKey && gemini.model) || status.custom?.ok || (
    loadSavedTranslateSettings().baseUrl &&
    loadSavedTranslateSettings().apiKey &&
    (loadSavedTranslateSettings().model || loadSavedTranslateSettings().models.length)
  ))
}

export async function listGeminiModels(options: {
  apiKey?: string
} = {}): Promise<Array<{
  id: string
  display_name?: string
  description?: string
  supported_generation_methods?: string[]
}>> {
  const saved = loadSavedGeminiSettings()
  const res = await fetch("/api/translate/gemini/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      geminiApiKey: options.apiKey || saved.apiKey,
    }),
  })
  const data = (await res.json()) as {
    ok?: boolean
    models?: Array<{
      id: string
      display_name?: string
      description?: string
      supported_generation_methods?: string[]
    }>
    message?: string
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `List Gemini models failed (HTTP ${res.status})`)
  }
  return data.models || []
}

export async function listCustomTranslateModels(options: {
  baseUrl?: string
  apiKey?: string
} = {}): Promise<Array<{
  id: string
  owned_by?: string
  supported_endpoint_types?: string[]
}>> {
  const saved = loadSavedTranslateSettings()
  const res = await fetch("/api/translate/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: options.baseUrl || saved.baseUrl,
      apiKey: options.apiKey || saved.apiKey,
    }),
  })
  const data = (await res.json()) as {
    ok?: boolean
    models?: Array<{
      id: string
      owned_by?: string
      supported_endpoint_types?: string[]
    }>
    message?: string
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `List models failed (HTTP ${res.status})`)
  }
  return data.models || []
}

export async function translateTextsWithGoogle(
  texts: string[],
  sourceLang: string,
  targetLang: string,
  options: CustomTranslateOptions = {},
): Promise<string[]> {
  if (!texts.length) return []
  if (sourceLang === targetLang) return texts.map((t) => t)

  const saved = loadSavedTranslateSettings()
  const savedGemini = loadSavedGeminiSettings()
  const provider = options.provider || saved.provider || "custom"

  const body: Record<string, unknown> = {
    texts,
    source: sourceLang,
    target: targetLang,
    provider,
    glossary: (options.glossary || []).filter(Boolean),
  }
  // Only send budgets when they line up with the texts, so a stale or partial
  // array can never shift limits onto the wrong lines.
  if (options.budgets?.length === texts.length) {
    body.budgets = options.budgets.map((value) =>
      Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0,
    )
  }

  if (provider === "custom" || provider === "auto") {
    const models = options.models?.length ? options.models : saved.models
    if (models.length) body.models = models
    if (options.model || saved.model) body.model = options.model || saved.model
    if (options.baseUrl || saved.baseUrl)
      body.baseUrl = options.baseUrl || saved.baseUrl
    if (options.apiKey || saved.apiKey)
      body.apiKey = options.apiKey || saved.apiKey
    if (options.protocol || saved.protocol)
      body.protocol = options.protocol || saved.protocol
  } else if (provider === "gemini") {
    if (options.model || savedGemini.model) body.model = options.model || savedGemini.model
    if (options.geminiApiKey || savedGemini.apiKey) {
      body.geminiApiKey = options.geminiApiKey || savedGemini.apiKey
    }
  }

  const requestController = new AbortController()
  const abortFromCaller = () => requestController.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options.signal?.aborted) abortFromCaller()
  const timeout = globalThis.setTimeout(
    () => requestController.abort(new DOMException("Translation timed out", "TimeoutError")),
    125_000,
  )
  let res: Response
  try {
    res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestController.signal,
    })
  } catch (error) {
    if (!options.signal?.aborted && requestController.signal.aborted) {
      throw new Error("Translation timed out after 125 seconds. Retry or switch provider.")
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abortFromCaller)
  }
  const data = (await res.json()) as {
    ok?: boolean
    translations?: string[]
    message?: string
    error?: string
    engine?: string
    model?: string
    missingFinal?: number[]
    strategy?: string
  }
  if (!res.ok || data.ok === false) {
    throw new Error(
      data.message || data.error || `Translate API failed (HTTP ${res.status})`,
    )
  }
  if (!Array.isArray(data.translations) || data.translations.length !== texts.length) {
    throw new Error("Translate API returned unexpected translations array")
  }

  const missing = Array.isArray(data.missingFinal) ? data.missingFinal : []
  if (missing.length > Math.max(3, Math.floor(texts.length * 0.05))) {
    throw new Error(
      `Translation incomplete: ${missing.length}/${texts.length} cues still source language. ` +
        `Server strategy=${data.strategy || "?"}. Retry Generate.`,
    )
  }

  // Detect "fake success": most lines still Chinese when target is Vietnamese
  if (targetLang !== "zh" && sourceLang === "zh") {
    let stillZh = 0
    for (let i = 0; i < texts.length; i += 1) {
      const src = String(texts[i] || "").trim()
      const dst = String(data.translations[i] || "").trim()
      if (dst && dst === src && /[\u4e00-\u9fff]/.test(dst)) stillZh += 1
    }
    if (stillZh > Math.max(5, Math.floor(texts.length * 0.15))) {
      throw new Error(
        `Translation looks untranslated (${stillZh}/${texts.length} lines still Chinese). Retry Generate.`,
      )
    }
  }

  console.info(
    `[translate] api ok engine=${data.engine || "?"} model=${data.model || "?"} ` +
      `strategy=${data.strategy || "?"} missing=${missing.length}`,
  )
  return data.translations
}

/** Send one short real request through the selected provider/endpoint. */
export async function testTranslateApi(
  options: TranslateApiTestOptions = {},
): Promise<TranslateApiTestResult> {
  const saved = loadSavedTranslateSettings()
  const savedGemini = loadSavedGeminiSettings()
  const provider = options.provider || saved.provider || "custom"
  // Keep the diagnostic path consistent with Generate: auto prefers Gemini
  // and only uses the custom endpoint when Gemini is unavailable.
  const status = provider === "auto" ? await getTranslateStatus(true) : null
  const effectiveProvider: TranslateProvider =
    provider === "auto" && status?.gemini?.ok
      ? "gemini"
      : provider === "auto" && status?.custom?.ok
        ? "custom"
        : provider
  const sampleText = options.sampleText || "你好，今天过得怎么样？"
  const body: Record<string, unknown> = {
    provider: effectiveProvider,
    source: "zh",
    target: "vi",
    texts: [sampleText],
  }
  // API diagnostics must stay lightweight. The real Generate flow uses the
  // context-window strategy; the button only verifies auth, routing, and a
  // single model response, so use the fast line-batch path here.
  if (effectiveProvider === "custom" || effectiveProvider === "gemini") {
    body.strategy = "probe"
  }
  if (effectiveProvider === "custom" || effectiveProvider === "auto") {
    const models = options.models?.length ? options.models : saved.models
    if (models.length) body.models = models
    if (options.model || saved.model) body.model = options.model || saved.model
    if (options.baseUrl || saved.baseUrl)
      body.baseUrl = options.baseUrl || saved.baseUrl
    if (options.apiKey || saved.apiKey)
      body.apiKey = options.apiKey || saved.apiKey
    if (options.protocol || saved.protocol)
      body.protocol = options.protocol || saved.protocol
  } else if (effectiveProvider === "gemini") {
    if (options.model || savedGemini.model) body.model = options.model || savedGemini.model
    if (options.geminiApiKey || savedGemini.apiKey) {
      body.geminiApiKey = options.geminiApiKey || savedGemini.apiKey
    }
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options.signal?.aborted) abortFromCaller()
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException("API test timed out", "TimeoutError")),
    22_000,
  )
  const started = performance.now()
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = (await res.json()) as {
      ok?: boolean
      translations?: string[]
      message?: string
      error?: string
      engine?: string
      model?: string
      strategy?: string
    }
    if (!res.ok || data.ok === false) {
      const detail = data.message || data.error || `Translate API failed (HTTP ${res.status})`
      throw new Error(
        /\bHTTP\s+\d{3}\b/i.test(detail) ? detail : `${detail} (HTTP ${res.status})`,
      )
    }
    const translation = String(data.translations?.[0] || "").trim()
    if (!translation) throw new Error("API returned an empty translation")
    return {
      elapsedMs: Math.round(performance.now() - started),
      httpStatus: res.status,
      engine: data.engine,
      model: data.model,
      strategy: data.strategy,
      translation,
    }
  } catch (error) {
    if (!options.signal?.aborted && controller.signal.aborted) {
      throw new Error("API test timed out after 22 seconds")
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abortFromCaller)
  }
}
