const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const DEFAULT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"]
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export type SpeechEnv = {
  GROQ_API_KEY?: string
  GROQ_API_URL?: string
  GROQ_TRANSCRIBE_MODELS?: string
  [key: string]: unknown
}

export type SpeechSegment = {
  start: number
  end: number
  text: string
}

export function normalizeSpeechSegments(value: unknown): SpeechSegment[] {
  if (!Array.isArray(value)) return []
  return value
    .map((segment) => {
      const item = segment as Record<string, unknown>
      const start = Number(item.start)
      const end = Number(item.end)
      const text = String(item.text ?? "").trim()
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text)
        return null
      return { start: Math.max(0, start), end: Math.max(start, end), text }
    })
    .filter((segment): segment is SpeechSegment => !!segment)
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

function modelList(env: SpeechEnv, requested: string) {
  const configured = String(env.GROQ_TRANSCRIBE_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  const requestedModels = requested
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  return [...new Set([...requestedModels, ...configured, ...DEFAULT_MODELS])]
}

export async function handleSpeechApi(request: Request, env: SpeechEnv) {
  const { pathname } = new URL(request.url)
  if (pathname !== "/api/speech/transcribe") return null
  if (request.method.toUpperCase() !== "POST")
    return json({ ok: false, error: "method_not_allowed", message: "POST required." }, 405)

  const apiKey = String(env.GROQ_API_KEY || "").trim()
  if (!apiKey)
    return json(
      {
        ok: false,
        error: "not_configured",
        message: "Groq Whisper chưa được cấu hình trên máy chủ (thiếu GROQ_API_KEY).",
      },
      503,
    )

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ ok: false, error: "invalid_form", message: "Không đọc được tệp audio tải lên." }, 400)
  }

  const fileValue = form.get("file")
  if (!(fileValue instanceof File) || fileValue.size === 0)
    return json({ ok: false, error: "missing_file", message: "Thiếu tệp audio." }, 400)
  if (fileValue.size > MAX_AUDIO_BYTES)
    return json(
      {
        ok: false,
        error: "file_too_large",
        message: "Audio vượt quá giới hạn 25 MB của Groq. Hãy dùng clip ngắn hơn.",
      },
      413,
    )

  const language = String(form.get("language") || "").trim()
  const prompt = String(form.get("prompt") || "").trim()
  const requestedModels = String(form.get("models") || form.get("model") || "")
  const models = modelList(env, requestedModels)
  const endpoint = String(env.GROQ_API_URL || DEFAULT_GROQ_URL).trim() || DEFAULT_GROQ_URL
  const attempts: Array<{ model: string; status?: number; message?: string }> = []

  for (const model of models) {
    const body = new FormData()
    body.append("file", fileValue, fileValue.name || "audio.wav")
    body.append("model", model)
    body.append("response_format", "verbose_json")
    // Groq's multipart field uses the OpenAI-style array name.
    body.append("timestamp_granularities[]", "segment")
    if (language) body.append("language", language)
    if (prompt) body.append("prompt", prompt)

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      })
      const raw = await response.text()
      let data: any = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }
      if (!response.ok) {
        const message = String(data?.error?.message || raw || `HTTP ${response.status}`).slice(0, 300)
        attempts.push({ model, status: response.status, message })
        if (response.status < 500 && response.status !== 429) break
        continue
      }

      const segments = normalizeSpeechSegments(data?.segments)
      if (!segments.length) {
        attempts.push({ model, status: response.status, message: "Groq returned no timestamped segments." })
        continue
      }
      return json({
        ok: true,
        model,
        language: String(data?.language || language || ""),
        duration: Number.isFinite(Number(data?.duration)) ? Number(data.duration) : undefined,
        segments,
      })
    } catch (error) {
      attempts.push({ model, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return json(
    {
      ok: false,
      error: "upstream_failed",
      message: "Groq Whisper không thể nhận dạng audio.",
      attempts,
    },
    502,
  )
}
