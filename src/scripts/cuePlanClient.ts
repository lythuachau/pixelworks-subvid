export type TimestampedSpeechWord = {
  id: string
  start: number
  end: number
  text: string
}

type SubtitleSegment = {
  start: number
  end: number
  text: string
}

export type CuePlanResult = {
  engine: string
  model: string
  sourceSegments: SubtitleSegment[]
  translatedSegments: SubtitleSegment[]
  inputWords: number
  outputCues: number
}

export async function planAndTranslateSubtitleCues(
  words: TimestampedSpeechWord[],
  segments: SubtitleSegment[],
  sourceLang: string,
  targetLang: string,
  options: { signal?: AbortSignal } = {},
): Promise<CuePlanResult> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException("Cue planning timed out", "TimeoutError")),
    240_000,
  )

  try {
    const response = await fetch("/api/translate/cue-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        words,
        segments,
        source: sourceLang,
        target: targetLang,
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok)
      throw new Error(
        String(data.message || `AI cue planning failed (HTTP ${response.status})`),
      )
    if (
      !Array.isArray(data.sourceSegments) ||
      !Array.isArray(data.translatedSegments) ||
      data.sourceSegments.length !== data.translatedSegments.length ||
      !data.sourceSegments.length
    )
      throw new Error("AI cue planning returned an invalid cue list.")

    return {
      engine: String(data.engine || "gemini"),
      model: String(data.model || ""),
      sourceSegments: data.sourceSegments,
      translatedSegments: data.translatedSegments,
      inputWords: Number(data.diagnostics?.inputWords) || words.length,
      outputCues:
        Number(data.diagnostics?.outputCues) || data.sourceSegments.length,
    }
  } catch (error) {
    if (!options.signal?.aborted && controller.signal.aborted)
      throw new Error("AI cue planning timed out after 240 seconds.")
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }
}
