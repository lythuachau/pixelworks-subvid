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

function hostname(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ""
  }
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
  return /^claude(?:-|$)/i.test(model) ? "anthropic" : "openai"
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

function parseNumbered(text: unknown, count: number) {
  const result = Array.from({ length: count }, () => "")
  const numbered = new Map<number, string>()
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s*[.)：:\-]\s*(.*?)\s*$/)
    if (match) numbered.set(Number(match[1]) - 1, match[2].trim())
  }
  if (numbered.size >= Math.ceil(count * 0.6)) {
    numbered.forEach((value, index) => {
      if (index >= 0 && index < result.length) result[index] = value
    })
    return result
  }
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, count)
}

function promptFor(texts: string[], source: string, target: string) {
  return [
    `Translate subtitle cues from ${source} to natural spoken ${target}.`,
    `Output exactly ${texts.length} numbered lines in the same order. Do not add commentary.`,
    ...texts.map((text, index) => `${index + 1}. ${String(text).replace(/\r?\n/g, " ").trim()}`),
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
    delete headers.Authorization
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
  const url = baseUrl(body.baseUrl || body.endpoint || d.baseUrl)
  const key = String(body.apiKey || body.key || d.apiKey).trim()
  if (!url || !key) return json({ ok: false, error: "not_configured", message: "baseUrl and apiKey required to list models" }, 400)
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
  ].includes(pathname)) return null
  if (pathname === "/api/translate/status") {
    const d = defaults(env)
    const gemini = !!envString(env, "GEMINI_API_KEY")
    return json({ ok: !!(d.baseUrl && d.apiKey) || gemini, preferred: d.baseUrl && d.apiKey ? "custom" : gemini ? "gemini" : "local", custom: { ok: !!(d.baseUrl && d.apiKey), configured: !!(d.baseUrl && d.apiKey), baseUrl: d.baseUrl, model: d.model, models: d.models, protocol: d.protocol, hasApiKey: !!d.apiKey }, gemini: { ok: gemini, configured: gemini, model: envString(env, "GEMINI_TRANSLATE_MODEL") || "gemini-2.5-flash" } })
  }
  if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "method_not_allowed", message: "POST required" }, 405)
  if (pathname === "/api/translate/gemini/models") return handleGeminiModels(request, env)
  if (pathname === "/api/translate/models") return handleModels(request, env)
  let body: any
  try { body = await request.json() } catch { return json({ ok: false, error: "bad_json", message: "Invalid JSON body" }, 400) }
  const texts = Array.isArray(body.texts) ? body.texts.map((text: unknown) => String(text ?? "")) : []
  const source = String(body.source || body.sourceLang || "").trim()
  const target = String(body.target || body.targetLang || "").trim()
  if (!texts.length) return json({ ok: true, translations: [], engine: "custom" })
  if (!source || !target) return json({ ok: false, error: "missing_langs", message: "source and target language codes are required" }, 400)
  if (source === target) return json({ ok: true, translations: texts, engine: "same-language" })
  const d = defaults(env)
  const provider = String(body.provider || "auto").toLowerCase()
  const customBase = baseUrl(body.baseUrl || body.endpoint || d.baseUrl)
  const customKey = String(body.apiKey || body.key || d.apiKey).trim()
  const customModels = Array.isArray(body.models) && body.models.length ? body.models.map(String) : d.models
  const customModel = String(body.model || customModels[0] || d.model).trim()
  const useCustom = provider === "custom" || (provider === "auto" && customBase && customKey)
  const useGemini = provider === "gemini" || (provider === "auto" && !useCustom)
  const isProbe = String(body.strategy || "").toLowerCase() === "probe"
  const requestTimeoutMs = isProbe ? 20_000 : 120_000
  const maxOutputTokens = isProbe ? 256 : 4096
  try {
    const prompt = promptFor(texts, source, target)
    let raw: string
    let engine: string
    let model: string
    if (useCustom) {
      if (!customBase || !customKey || !customModel) return json({ ok: false, error: "not_configured", message: "Custom endpoint, key, and model are required" }, 503)
      const protocol = resolveCustomProtocol(
        body.protocol || d.protocol || "auto",
        customBase,
        customModel,
      )
      raw = await callCustom(
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
      engine = `custom:${protocol}`; model = customModel
    } else if (useGemini) {
      const key = String(body.geminiApiKey || envString(env, "GEMINI_API_KEY")).trim()
      if (!key) return json({ ok: false, error: "not_configured", message: "Gemini API key is required" }, 503)
      model = String(body.model || envString(env, "GEMINI_TRANSLATE_MODEL") || "gemini-2.5-flash")
      raw = await callGemini(key, model, prompt, requestTimeoutMs, maxOutputTokens); engine = "gemini"
    } else {
      return json({ ok: false, error: "not_configured", message: "No translation API configured on the server" }, 503)
    }
    const translations = parseNumbered(raw, texts.length)
    const missingFinal = translations.map((translation, index) => !translation || translation === texts[index] ? index : -1).filter((index) => index >= 0)
    return json({ ok: true, engine, model, source, target, translations, missingFinal, strategy: isProbe ? "probe" : "server-numbered" })
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
