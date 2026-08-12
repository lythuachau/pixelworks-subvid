import { isInternalHost } from "./netGuard.ts"
import {
  buildCuePlanPrompt,
  materializeCuePlan,
  normalizeCuePlanWords,
  splitCuePlanWords,
} from "./cuePlan.ts"

type TranslateEnv = {
  CUSTOM_TRANSLATE_BASE_URL?: string
  CUSTOM_TRANSLATE_API_KEY?: string
  CUSTOM_TRANSLATE_MODEL?: string
  CUSTOM_TRANSLATE_MODELS?: string
  CUSTOM_TRANSLATE_PROTOCOL?: string
  GEMINI_API_KEY?: string
  GEMINI_TRANSLATE_MODEL?: string
  [key: string]: unknown
}

export type CustomTranslateProtocol =
  | "auto"
  | "anthropic"
  | "openai"
  | "responses"

class UpstreamApiError extends Error {
  status: number
  protocol: Exclude<CustomTranslateProtocol, "auto">

  constructor(
    message: string,
    status: number,
    protocol: Exclude<CustomTranslateProtocol, "auto">,
  ) {
    super(message)
    this.name = "UpstreamApiError"
    this.status = status
    this.protocol = protocol
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function baseUrl(value: unknown) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
}

/**
 * Resolve the custom endpoint + key for one request.
 *
 * The server-side key is only ever paired with the server-side endpoint. When
 * the caller supplies their own `baseUrl` they must supply the matching key
 * too; otherwise an authenticated admin — who by design can never read the
 * stored key — could exfiltrate it just by pointing baseUrl at a host they
 * control and reading the inbound Authorization header.
 */
function resolveCustomCredentials(
  body: { baseUrl?: unknown; endpoint?: unknown; apiKey?: unknown; key?: unknown },
  stored: { baseUrl: string; apiKey: string },
) {
  const requestedBase = baseUrl(body.baseUrl || body.endpoint || "")
  const requestedKey = String(body.apiKey || body.key || "").trim()
  const usesStoredEndpoint = !requestedBase || requestedBase === stored.baseUrl
  return {
    base: requestedBase || stored.baseUrl,
    key: requestedKey || (usesStoredEndpoint ? stored.apiKey : ""),
  }
}

/**
 * True when `url` points at infrastructure rather than a public API.
 *
 * `ALLOW_PRIVATE_TRANSLATE_ENDPOINT=1` exists only so the test suite and local
 * development can target a loopback stub. Never set it in production —
 * it re-opens the endpoint field as an SSRF primitive.
 */
function endpointBlocked(env: TranslateEnv, url: string) {
  if (!url) return false
  if (String(env.ALLOW_PRIVATE_TRANSLATE_ENDPOINT || "") === "1") return false
  return isInternalHost(hostname(url))
}

function blockedEndpointResponse() {
  return json(
    {
      ok: false,
      error: "blocked_endpoint",
      message: "Endpoint nội bộ hoặc IP riêng không được phép.",
    },
    400,
  )
}

function hostname(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Hosts that speak the native Anthropic wire protocol, where `x-api-key` is the
 * only accepted credential. Everything else — LiteLLM, one-api, new-api and the
 * other aggregators — fronts Claude with an OpenAI-style Bearer gate.
 */
export function isNativeAnthropicHost(endpoint: string) {
  const host = hostname(baseUrl(endpoint))
  return host === "anthropic.com" || host.endsWith(".anthropic.com")
}

export function resolveCustomProtocol(
  value: unknown,
  endpoint: string,
  model = "",
): Exclude<CustomTranslateProtocol, "auto"> {
  const host = hostname(baseUrl(endpoint))
  // FreeModel documents separate Tier 0 routes. Always use the matching wire
  // protocol even if a stale browser setting selected another one.
  if (host === "cc.freemodel.dev") return "anthropic"
  if (host === "api.freemodel.dev") return "responses"

  const requested = String(value || "auto").trim().toLowerCase()
  if (requested === "anthropic") return "anthropic"
  if (requested === "responses") return "responses"
  if (requested === "openai") return "openai"
  // The wire protocol belongs to the endpoint, not the model. Guessing
  // "anthropic" from a claude-* model name pointed Anthropic-shaped requests at
  // OpenAI-only gateways, so every Claude model failed while GPT ones worked.
  return isNativeAnthropicHost(endpoint) ? "anthropic" : "openai"
}

function envString(env: TranslateEnv, key: keyof TranslateEnv) {
  return String(env[key] || "").trim()
}

function defaults(env: TranslateEnv) {
  return {
    baseUrl: baseUrl(envString(env, "CUSTOM_TRANSLATE_BASE_URL")),
    apiKey: envString(env, "CUSTOM_TRANSLATE_API_KEY"),
    model: envString(env, "CUSTOM_TRANSLATE_MODEL"),
    models: envString(env, "CUSTOM_TRANSLATE_MODELS").split(",").map((v) => v.trim()).filter(Boolean),
    protocol: envString(env, "CUSTOM_TRANSLATE_PROTOCOL") || "auto",
  }
}

export type ParsedTranslationOutput = {
  translations: string[]
  received: number
  format: "json" | "numbered" | "plain"
  exact: boolean
}

function translationValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim()
  if (value && typeof value === "object" && "text" in value)
    return String((value as { text?: unknown }).text || "").trim()
  return ""
}

export function parseTranslationOutput(
  text: unknown,
  count: number,
): ParsedTranslationOutput {
  const raw = String(text || "").replace(/\r/g, "").trim()
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  try {
    const parsed = JSON.parse(jsonText)
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.translations)
        ? parsed.translations
        : null
    if (values) {
      const received = values.length
      const translations = Array.from({ length: count }, (_, index) =>
        translationValue(values[index]),
      )
      return {
        translations,
        received,
        format: "json",
        exact:
          received === count && translations.every((translation) => translation),
      }
    }
  } catch {
    // Older and OpenAI-compatible models commonly return numbered text.
  }

  const result = Array.from({ length: count }, () => "")
  const numbered = new Map<number, string>()
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s*[.)、：:\-]\s*(.*?)\s*$/)
    // Models sometimes echo the "(max 84)" length hint back; strip it so the
    // marker never leaks onto the screen.
    if (match)
      numbered.set(
        Number(match[1]) - 1,
        match[2].replace(/^\(\s*max\s*\d+\s*\)\s*/i, "").trim(),
      )
  }
  if (numbered.size) {
    numbered.forEach((value, index) => {
      if (index >= 0 && index < result.length) result[index] = value
    })
    const received = [...numbered.keys()].filter(
      (index) => index >= 0 && index < count,
    ).length
    return {
      translations: result,
      received,
      format: "numbered",
      exact: received === count && result.every((translation) => translation),
    }
  }

  const plain = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  plain.slice(0, count).forEach((value, index) => {
    result[index] = value
  })
  return {
    translations: result,
    received: plain.length,
    format: "plain",
    exact: plain.length === count && result.every((translation) => translation),
  }
}

const TRANSLATE_BATCH_SIZE = 24
const TRANSLATE_BATCH_CONCURRENCY = 2

export function promptFor(
  texts: string[],
  source: string,
  target: string,
  budgets: number[] = [],
) {
  // A cue is on screen for a fixed number of seconds, so length is part of the
  // task, not a formatting preference. When the caller knows how much room a
  // line has, spell it out per line; verbose output is what makes translated
  // subtitles pile up into unreadable blocks.
  const useBudgets = budgets.length === texts.length
  return [
    `Translate subtitle cues from ${source} to natural spoken ${target}.`,
    `Output exactly ${texts.length} numbered lines in the same order. Do not add commentary.`,
    ...(useBudgets
      ? [
          "Each line is an on-screen subtitle with limited space. The number in",
          "parentheses is the maximum characters allowed for that line — stay at or",
          "under it. Keep the meaning but be concise: drop filler words, honorifics",
          "and repetition rather than exceeding the limit. Never output the",
          "parentheses marker itself.",
        ]
      : []),
    ...texts.map((text, index) => {
      const cleaned = String(text).replace(/\r?\n/g, " ").trim()
      const budget = useBudgets ? Number(budgets[index]) : 0
      return Number.isFinite(budget) && budget > 0
        ? `${index + 1}. (max ${Math.round(budget)}) ${cleaned}`
        : `${index + 1}. ${cleaned}`
    }),
  ].join("\n")
}

function parseJson(text: string) {
  try { return text ? JSON.parse(text) : {} } catch { return { raw: text } }
}

async function readJson(response: Response) {
  return parseJson(await response.text())
}

function extractAnthropicText(payload: any) {
  return Array.isArray(payload?.content)
    ? payload.content.map((part: any) => String(part?.text || "")).join("")
    : ""
}

function extractChatText(payload: any) {
  return String(payload?.choices?.[0]?.message?.content || "")
}

function extractResponsesText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text
  const output = Array.isArray(payload?.output) ? payload.output : []
  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => String(part?.text || part?.output_text || ""))
    .join("")
}

export function parseCustomApiResponse(
  raw: string,
  protocol: Exclude<CustomTranslateProtocol, "auto">,
  contentType = "",
) {
  const looksLikeSse =
    /text\/event-stream/i.test(contentType) ||
    /^\s*(?:event|data):/m.test(raw)
  if (!looksLikeSse) {
    const payload = parseJson(raw)
    return protocol === "anthropic"
      ? extractAnthropicText(payload)
      : protocol === "responses"
        ? extractResponsesText(payload)
        : extractChatText(payload)
  }

  const deltas: string[] = []
  let finalText = ""
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    const payload = parseJson(data)
    if (payload?.raw) continue

    if (
      payload?.type === "content_block_delta" &&
      payload?.delta?.type === "text_delta"
    ) {
      deltas.push(String(payload.delta.text || ""))
      continue
    }
    if (payload?.type === "response.output_text.delta") {
      deltas.push(String(payload.delta || ""))
      continue
    }
    if (payload?.choices?.[0]?.delta?.content) {
      deltas.push(String(payload.choices[0].delta.content))
      continue
    }

    const candidate = protocol === "anthropic"
      ? extractAnthropicText(payload?.message || payload)
      : protocol === "responses"
        ? extractResponsesText(payload?.response || payload)
        : extractChatText(payload)
    if (candidate) finalText = candidate
  }
  return deltas.join("") || finalText
}

function parseStructuredJson(raw: unknown) {
  let value = String(raw || "").trim()
  if (value.startsWith("```")) {
    const newline = value.indexOf("\n")
    value = newline >= 0 ? value.slice(newline + 1) : value.slice(3)
    if (value.trimEnd().endsWith("```"))
      value = value.trimEnd().slice(0, -3).trim()
  }
  return JSON.parse(value)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
) {
  const output = new Array<R>(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await task(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return output
}

async function handleCuePlanRequest(
  body: any,
  env: TranslateEnv,
) {
  const words = normalizeCuePlanWords(body?.words)
  const segments = Array.isArray(body?.segments) ? body.segments : []
  const source = String(body?.source || body?.sourceLang || "").trim()
  const target = String(body?.target || body?.targetLang || "").trim()
  if (!words.length || !source || !target)
    return json(
      {
        ok: false,
        error: "invalid_input",
        message: "Timestamped words, source, and target are required.",
      },
      400,
    )
  if (words.length > 900)
    return json(
      {
        ok: false,
        error: "too_many_words",
        message: "AI cue planning supports at most 900 word units.",
      },
      413,
    )

  const d = defaults(env)
  const provider = String(body.provider || "auto").toLowerCase()
  const { base: customBase, key: customKey } = resolveCustomCredentials(body, d)
  if (endpointBlocked(env, customBase)) return blockedEndpointResponse()
  const customModels =
    Array.isArray(body.models) && body.models.length
      ? body.models.map(String)
      : d.models
  const customModel = String(
    body.model || customModels[0] || d.model,
  ).trim()
  const useCustom =
    provider === "custom" ||
    (provider === "auto" && Boolean(customBase && customKey))
  const useGemini = provider === "gemini" || (provider === "auto" && !useCustom)
  const protocol = useCustom
    ? resolveCustomProtocol(
        body.protocol || d.protocol || "auto",
        customBase,
        customModel,
      )
    : undefined
  const geminiKey = String(
    body.geminiApiKey || envString(env, "GEMINI_API_KEY"),
  ).trim()
  const geminiModel = String(
    body.model ||
      envString(env, "GEMINI_TRANSLATE_MODEL") ||
      "gemini-2.5-flash",
  )
  if (useCustom && (!customBase || !customKey || !customModel))
    return json(
      {
        ok: false,
        error: "not_configured",
        message: "Custom endpoint, key, and model are required.",
      },
      503,
    )
  if (useGemini && !geminiKey)
    return json(
      {
        ok: false,
        error: "not_configured",
        message: "Gemini API key is required.",
      },
      503,
    )

  try {
    const chunks = splitCuePlanWords(words, segments, 80)
    const planned = await mapWithConcurrency(chunks, 2, async (chunk) => {
      const prompt = buildCuePlanPrompt(
        chunk,
        segments,
        source,
        target,
      )
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const retryNote =
            attempt === 0
              ? ""
              : "\n\nYour previous plan violated a hard rule. Correct it now: include every mandatory hard-silence ending, keep all `to` IDs increasing, and end at the final supplied word ID."
          const raw = useCustom
            ? await callCustom(
                {
                  baseUrl: customBase,
                  apiKey: customKey,
                  model: customModel,
                  protocol: protocol!,
                },
                prompt + retryNote,
                100_000,
                4096,
              )
            : await callGemini(
                geminiKey,
                geminiModel,
                prompt + retryNote,
                100_000,
                4096,
              )
          return materializeCuePlan(chunk, parseStructuredJson(raw), {
            targetLang: target,
          })
        } catch (error) {
          lastError = error
          const message = String(
            error instanceof Error ? error.message : error,
          )
          if (
            attempt === 0 &&
            /cue plan|hard silence|word ID|JSON/i.test(message)
          )
            continue
          throw error
        }
      }
      throw lastError
    })
    const selections = planned.flat().map((cue) => ({
      to: cue.sourceIds.at(-1)!,
      translation: cue.translation,
    }))
    // Re-materialize against the complete transcript. This is the final proof
    // that no chunk lost, duplicated, reordered, or mistimed a word.
    const cues = materializeCuePlan(words, { cues: selections }, {
      targetLang: target,
    })
    const engine = useCustom ? `custom:${protocol}` : "gemini"
    const model = useCustom ? customModel : geminiModel
    return json({
      ok: true,
      engine,
      model,
      protocol,
      cues,
      sourceSegments: cues.map((cue) => ({
        start: cue.start,
        end: cue.end,
        text: cue.sourceText,
      })),
      translatedSegments: cues.map((cue) => ({
        start: cue.start,
        end: cue.end,
        text: cue.translation,
      })),
      diagnostics: {
        inputWords: words.length,
        inputSegments: segments.length,
        outputCues: cues.length,
        chunks: chunks.length,
      },
    })
  } catch (error) {
    const candidate = error as Partial<UpstreamApiError> | null
    const upstreamStatus = Number(candidate?.status || 0)
    return json(
      {
        ok: false,
        error: "cue_plan_failed",
        message: String(error instanceof Error ? error.message : error),
        upstreamStatus: upstreamStatus || undefined,
        protocol: candidate?.protocol,
      },
      upstreamStatus || 502,
    )
  }
}

function upstreamMessage(payload: any, status: number) {
  const raw = String(
    payload?.error?.message ||
    (typeof payload?.error === "string" ? payload.error : "") ||
    payload?.message ||
    payload?.raw ||
    `Translation HTTP ${status}`,
  ).trim()
  return /\bHTTP\s+\d{3}\b/i.test(raw) ? raw : `${raw} (HTTP ${status})`
}

async function callCustom(
  cfg: {
    baseUrl: string
    apiKey: string
    model: string
    protocol: Exclude<CustomTranslateProtocol, "auto">
  },
  prompt: string,
  timeoutMs = 120_000,
  maxTokens = 4096,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  }
  const system = "You translate subtitles exactly as requested."
  const url = cfg.protocol === "anthropic"
    ? `${cfg.baseUrl}/v1/messages`
    : cfg.protocol === "responses"
      ? `${cfg.baseUrl}/v1/responses`
      : `${cfg.baseUrl}/v1/chat/completions`
  const body = cfg.protocol === "anthropic"
    ? {
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }
    : cfg.protocol === "responses"
      ? {
          model: cfg.model,
          instructions: system,
          input: prompt,
          max_output_tokens: maxTokens,
          store: false,
          stream: true,
        }
      : {
          model: cfg.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          stream: false,
        }
  if (cfg.protocol === "anthropic") {
    headers["x-api-key"] = cfg.apiKey
    headers["anthropic-version"] = "2023-06-01"
    // Only native Anthropic rejects a stray Bearer token. Gateways that expose
    // /v1/messages behind an OpenAI-style auth wall read Authorization and never
    // look at x-api-key, so dropping it there returned "API key required".
    if (isNativeAnthropicHost(cfg.baseUrl)) delete headers.Authorization
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new UpstreamApiError(
      upstreamMessage(parseJson(raw), response.status),
      response.status,
      cfg.protocol,
    )
  }
  const text = parseCustomApiResponse(
    raw,
    cfg.protocol,
    response.headers.get("content-type") || "",
  )
  if (!text.trim()) throw new Error("Translation API returned empty content")
  return text
}

async function callGemini(
  key: string,
  model: string,
  prompt: string,
  timeoutMs = 120_000,
  maxOutputTokens = 4096,
) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload: any = await readJson(response)
  if (!response.ok) throw new Error(String(payload?.error?.message || payload?.raw || `Gemini HTTP ${response.status}`))
  const text = String(payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "")
  if (!text.trim()) throw new Error("Gemini returned empty content")
  return text
}

async function handleGeminiModels(request: Request, env: TranslateEnv) {
  let body: any = {}
  try { body = await request.json() } catch { /* use server key */ }
  const key = String(
    body.geminiApiKey ||
    body.apiKey ||
    body.key ||
    envString(env, "GEMINI_API_KEY"),
  ).trim()
  if (!key) {
    return json({
      ok: false,
      error: "not_configured",
      message: "Gemini API key is required to list models",
    }, 400)
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(15_000),
      },
    )
    const payload: any = await readJson(response)
    if (!response.ok) {
      throw new Error(String(
        payload?.error?.message ||
        payload?.raw ||
        `Gemini list models HTTP ${response.status}`,
      ))
    }
    const models = (Array.isArray(payload?.models) ? payload.models : [])
      .filter((model: any) =>
        Array.isArray(model?.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes("generateContent"),
      )
      .map((model: any) => ({
        id: String(model?.name || "").replace(/^models\//, ""),
        display_name: String(model?.displayName || ""),
        description: String(model?.description || ""),
        supported_generation_methods: model.supportedGenerationMethods.map(String),
      }))
      .filter((model: any) =>
        model.id &&
        /^gemini-/i.test(model.id) &&
        !/(embedding|image|tts|live|robotics|computer-use)/i.test(model.id),
      )
    return json({ ok: true, models })
  } catch (error) {
    return json({
      ok: false,
      error: "list_failed",
      message: String(error instanceof Error ? error.message : error),
    }, 502)
  }
}

async function handleModels(request: Request, env: TranslateEnv) {
  let body: any = {}
  try { body = await request.json() } catch { /* use env defaults */ }
  const d = defaults(env)
  const { base: url, key } = resolveCustomCredentials(body, d)
  if (!url || !key) return json({ ok: false, error: "not_configured", message: "baseUrl and apiKey required to list models" }, 400)
  if (endpointBlocked(env, url)) return blockedEndpointResponse()
  try {
    const response = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(15_000) })
    const payload: any = await readJson(response)
    if (!response.ok) throw new Error(String(payload?.error?.message || payload?.message || payload?.raw || `List models HTTP ${response.status}`))
    const models = (Array.isArray(payload?.data) ? payload.data : []).map((model: any) => ({
      id: String(model.id || model.name || ""),
      owned_by: String(model.owned_by || ""),
      supported_endpoint_types: Array.isArray(model.supported_endpoint_types)
        ? model.supported_endpoint_types.map(String)
        : [],
    })).filter((model: any) => model.id)
    return json({ ok: true, models })
  } catch (error) {
    return json({ ok: false, error: "list_failed", message: String(error instanceof Error ? error.message : error) }, 502)
  }
}

export async function handleTranslateApi(request: Request, env: TranslateEnv) {
  const { pathname } = new URL(request.url)
  if (![
    "/api/translate",
    "/api/translate/status",
    "/api/translate/models",
    "/api/translate/gemini/models",
    "/api/translate/cue-plan",
  ].includes(pathname)) return null
  if (pathname === "/api/translate/status") {
    // Unauthenticated probe — booleans only. The endpoint URL, model names and
    // protocol are infrastructure detail; the admin UI reads them from the
    // authenticated /api/api-admin/config instead.
    const d = defaults(env)
    const custom = !!(d.baseUrl && d.apiKey)
    const gemini = !!envString(env, "GEMINI_API_KEY")
    return json({
      ok: custom || gemini,
      custom: { ok: custom, configured: custom },
      gemini: { ok: gemini, configured: gemini },
    })
  }
  if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "method_not_allowed", message: "POST required" }, 405)
  if (pathname === "/api/translate/gemini/models") return handleGeminiModels(request, env)
  if (pathname === "/api/translate/models") return handleModels(request, env)
  let body: any
  try { body = await request.json() } catch { return json({ ok: false, error: "bad_json", message: "Invalid JSON body" }, 400) }
  if (pathname === "/api/translate/cue-plan")
    return handleCuePlanRequest(body, env)
  const texts = Array.isArray(body.texts) ? body.texts.map((text: unknown) => String(text ?? "")) : []
  const source = String(body.source || body.sourceLang || "").trim()
  const target = String(body.target || body.targetLang || "").trim()
  // Per-line character ceilings are advisory: accept them only when they match
  // the texts one-for-one, otherwise fall back to the unbudgeted prompt.
  const budgets =
    Array.isArray(body.budgets) && body.budgets.length === texts.length
      ? body.budgets.map((value: unknown) => {
          const parsed = Number(value)
          return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
        })
      : []
  if (!texts.length) return json({ ok: true, translations: [], engine: "custom" })
  if (!source || !target) return json({ ok: false, error: "missing_langs", message: "source and target language codes are required" }, 400)
  if (source === target) return json({ ok: true, translations: texts, engine: "same-language" })
  const d = defaults(env)
  const provider = String(body.provider || "auto").toLowerCase()
  const { base: customBase, key: customKey } = resolveCustomCredentials(body, d)
  if (endpointBlocked(env, customBase)) return blockedEndpointResponse()
  const customModels = Array.isArray(body.models) && body.models.length ? body.models.map(String) : d.models
  const customModel = String(body.model || customModels[0] || d.model).trim()
  const useCustom = provider === "custom" || (provider === "auto" && customBase && customKey)
  const useGemini = provider === "gemini" || (provider === "auto" && !useCustom)
  const isProbe = String(body.strategy || "").toLowerCase() === "probe"
  const requestTimeoutMs = isProbe ? 20_000 : 120_000
  const maxOutputTokens = isProbe ? 256 : 4096
  try {
    let engine = ""
    let model = ""
    let callProvider: (prompt: string) => Promise<string>
    if (useCustom) {
      if (!customBase || !customKey || !customModel) return json({ ok: false, error: "not_configured", message: "Custom endpoint, key, and model are required" }, 503)
      const protocol = resolveCustomProtocol(
        body.protocol || d.protocol || "auto",
        customBase,
        customModel,
      )
      callProvider = (prompt) =>
        callCustom(
          {
            baseUrl: customBase,
            apiKey: customKey,
            model: customModel,
            protocol,
          },
          prompt,
          requestTimeoutMs,
          maxOutputTokens,
        )
      engine = `custom:${protocol}`
      model = customModel
    } else if (useGemini) {
      const key = String(body.geminiApiKey || envString(env, "GEMINI_API_KEY")).trim()
      if (!key) return json({ ok: false, error: "not_configured", message: "Gemini API key is required" }, 503)
      model = String(body.model || envString(env, "GEMINI_TRANSLATE_MODEL") || "gemini-2.5-flash")
      callProvider = (prompt) =>
        callGemini(key, model, prompt, requestTimeoutMs, maxOutputTokens)
      engine = "gemini"
    } else {
      return json({ ok: false, error: "not_configured", message: "No translation API configured on the server" }, 503)
    }

    const batches: number[][] = []
    for (let offset = 0; offset < texts.length; offset += TRANSLATE_BATCH_SIZE) {
      batches.push(
        Array.from(
          { length: Math.min(TRANSLATE_BATCH_SIZE, texts.length - offset) },
          (_, index) => offset + index,
        ),
      )
    }
    const batchResults = await mapWithConcurrency(
      batches,
      isProbe ? 1 : TRANSLATE_BATCH_CONCURRENCY,
      async (indexes) => {
        const batchTexts = indexes.map((index) => texts[index])
        const batchBudgets = budgets.length
          ? indexes.map((index) => budgets[index])
          : []
        const translateOnce = async () =>
          parseTranslationOutput(
            await callProvider(
              promptFor(batchTexts, source, target, batchBudgets),
            ),
            batchTexts.length,
          )
        let parsed = await translateOnce()
        let retried = false
        if (!isProbe && !parsed.exact) {
          retried = true
          parsed = await translateOnce()
        }
        return { indexes, parsed, retried }
      },
    )
    const malformed = batchResults.find(({ parsed }) => !parsed.exact)
    if (malformed) {
      return json(
        {
          ok: false,
          error: "invalid_translation_shape",
          message:
            `Translation API returned ${malformed.parsed.received}/` +
            `${malformed.indexes.length} cues after retry.`,
          expected: malformed.indexes.length,
          received: malformed.parsed.received,
          format: malformed.parsed.format,
          retried: malformed.retried,
        },
        502,
      )
    }
    const translations = Array.from({ length: texts.length }, () => "")
    batchResults.forEach(({ indexes, parsed }) => {
      indexes.forEach((sourceIndex, translatedIndex) => {
        translations[sourceIndex] = parsed.translations[translatedIndex]
      })
    })
    const missingFinal = translations.map((translation, index) => !translation || translation === texts[index] ? index : -1).filter((index) => index >= 0)
    return json({
      ok: true,
      engine,
      model,
      source,
      target,
      translations,
      missingFinal,
      strategy: isProbe ? "probe" : "server-batched",
      batches: batchResults.length,
      retries: batchResults.filter(({ retried }) => retried).length,
    })
  } catch (error) {
    // Structural fallback keeps metadata intact across Worker/bundler realms.
    const candidate = error as Partial<UpstreamApiError> | null
    const upstreamStatus = Number(candidate?.status || 0)
    const upstreamProtocol = ["anthropic", "openai", "responses"].includes(
      String(candidate?.protocol || ""),
    )
      ? candidate?.protocol
      : undefined
    return json({
      ok: false,
      error: "translate_failed",
      message: String(error instanceof Error ? error.message : error),
      upstreamStatus: upstreamStatus || undefined,
      protocol: upstreamProtocol,
    }, upstreamStatus || 502)
  }
}
