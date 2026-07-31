import { requireApiAdmin, type ApiAdminEnv } from "./apiAdmin.ts"
import {
  clientIp,
  recordRateLimitFailure,
  type RateLimitEnv,
} from "./rateLimit.ts"

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const DEFAULT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"]
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
/**
 * Every transcription spends the server's Groq quota, and a failed model is
 * retried against the next one, so cap how fast a single client can burn it.
 */
const RATE_MAX = 20
const RATE_WINDOW_MS = 5 * 60_000

export type SpeechEnv = ApiAdminEnv &
  RateLimitEnv & {
    GROQ_API_KEY?: string
    GROQ_API_URL?: string
    GROQ_TRANSCRIBE_MODELS?: string
    /** Set only by the loopback Vite middleware behind Caddy forward_auth. */
    TRUSTED_LOCAL_REQUEST?: boolean
    [key: string]: unknown
  }

export type SpeechSegment = {
  start: number
  end: number
  text: string
}

export type SpeechWord = {
  start: number
  end: number
  text: string
}

const WORD_PRE_ROLL_SECONDS = 0.08
const WORD_POST_ROLL_SECONDS = 0.12
const MIN_REFINED_CUE_SECONDS = 0.75

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

export function normalizeSpeechWords(value: unknown): SpeechWord[] {
  if (!Array.isArray(value)) return []
  return value
    .map((word) => {
      const item = word as Record<string, unknown>
      const start = Number(item.start)
      const end = Number(item.end)
      const text = String(item.word ?? item.text ?? "").trim()
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text)
        return null
      return { start: Math.max(0, start), end: Math.max(start, end), text }
    })
    .filter((word): word is SpeechWord => !!word)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function roundMillis(value: number) {
  return Math.round(value * 1000) / 1000
}

/**
 * Groq's segment timestamps may include several seconds of leading/trailing
 * silence. Tighten only the outer edges using word timestamps while keeping
 * cue count, text, order, and every boundary inside the original segment.
 *
 * Word data remains server-internal: callers still receive plain segments, so
 * this does not re-enable per-word subtitle effects.
 */
export function refineSpeechSegmentTimings(
  segments: SpeechSegment[],
  wordsValue: unknown,
): SpeechSegment[] {
  const words = normalizeSpeechWords(wordsValue)
  if (!words.length) return segments.map((segment) => ({ ...segment }))

  return segments.map((segment) => {
    const matching = words.filter(
      (word) => word.end > segment.start && word.start < segment.end,
    )
    if (!matching.length) return { ...segment }

    const first = matching[0]
    const last = matching[matching.length - 1]
    let start = Math.max(
      segment.start,
      first.start - WORD_PRE_ROLL_SECONDS,
    )
    let end = Math.min(
      segment.end,
      last.end + WORD_POST_ROLL_SECONDS,
    )
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return { ...segment }

    const originalDuration = segment.end - segment.start
    const minimumDuration = Math.min(
      MIN_REFINED_CUE_SECONDS,
      originalDuration,
    )
    let missing = Math.max(0, minimumDuration - (end - start))
    if (missing > 0) {
      const before = Math.min(missing / 2, start - segment.start)
      start -= before
      missing -= before

      const after = Math.min(missing, segment.end - end)
      end += after
      missing -= after

      if (missing > 0) {
        start -= Math.min(missing, start - segment.start)
      }
    }

    return {
      ...segment,
      start: roundMillis(Math.max(segment.start, start)),
      end: roundMillis(Math.min(segment.end, end)),
    }
  })
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
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

  // Transcription runs on the server's GROQ_API_KEY, so it is admin-only —
  // same gate as /api/translate. Without this the endpoint is an open,
  // anonymous spend of the owner's Groq quota.
  if (!env.TRUSTED_LOCAL_REQUEST) {
    const denied = await requireApiAdmin(request, env)
    if (denied) return denied
  }

  const limited = await recordRateLimitFailure(env, `speech:${clientIp(request)}`, {
    limit: RATE_MAX,
    windowMs: RATE_WINDOW_MS,
  })
  if (limited.blocked)
    return json(
      {
        ok: false,
        error: "rate_limited",
        message: "Quá nhiều yêu cầu nhận dạng. Vui lòng thử lại sau ít phút.",
      },
      429,
      { "Retry-After": String(limited.retryAfter) },
    )

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
    body.append("timestamp_granularities[]", "word")
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

      const rawSegments = normalizeSpeechSegments(data?.segments)
      const words = normalizeSpeechWords(data?.words)
      const segments = refineSpeechSegmentTimings(rawSegments, words)
      if (!segments.length) {
        attempts.push({ model, status: response.status, message: "Groq returned no timestamped segments." })
        continue
      }
      const refinedSegments = segments.reduce(
        (count, segment, index) =>
          count +
          (segment.start !== rawSegments[index]?.start ||
          segment.end !== rawSegments[index]?.end
            ? 1
            : 0),
        0,
      )
      return json({
        ok: true,
        model,
        language: String(data?.language || language || ""),
        duration: Number.isFinite(Number(data?.duration)) ? Number(data.duration) : undefined,
        segments,
        timing: {
          source: words.length ? "word" : "segment",
          wordCount: words.length,
          refinedSegments,
        },
        words: words.map((word, index) => ({
          id: `w${index + 1}`,
          start: word.start,
          end: word.end,
          text: word.text,
        })),
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
