export type SpeechSegment = {
  start: number
  end: number
  text: string
}

export type SpeechWord = {
  id: string
  start: number
  end: number
  text: string
}

export type GroqTranscription = {
  model: string
  language: string
  duration?: number
  segments: SpeechSegment[]
  words: SpeechWord[]
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1)
    view.setUint8(offset + index, value.charCodeAt(index))
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0))
    view.setInt16(44 + index * 2, value < 0 ? value * 32768 : value * 32767, true)
  }
  return new Blob([buffer], { type: "audio/wav" })
}

export async function transcribeAudioWithGroq(
  samples: Float32Array,
  options: {
    language?: string
    models?: string[]
    prompt?: string
    signal?: AbortSignal
    onProgress?: (percent: number) => void
  } = {},
): Promise<GroqTranscription> {
  const body = new FormData()
  const wav = encodePcm16Wav(samples)
  body.append("file", new File([wav], "audio.wav", { type: "audio/wav" }))
  if (options.language) body.append("language", options.language)
  if (options.models?.length) body.append("models", options.models.join(","))
  if (options.prompt) body.append("prompt", options.prompt)

  options.onProgress?.(45)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 180_000)
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch("/api/speech/transcribe", {
      method: "POST",
      body,
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      throw new Error(String(data.message || `Groq Whisper failed (HTTP ${response.status})`))
    }
    if (!Array.isArray(data.segments) || !data.segments.length)
      throw new Error("Groq Whisper không trả về đoạn lời thoại có timestamp.")
    options.onProgress?.(92)
    return {
      model: String(data.model || "whisper-large-v3"),
      language: String(data.language || options.language || ""),
      duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : undefined,
      segments: data.segments
        .map((segment: any) => ({
          start: Number(segment.start),
          end: Number(segment.end),
          text: String(segment.text || "").trim(),
        }))
        .filter((segment: SpeechSegment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text),
      words: Array.isArray(data.words)
        ? data.words
            .map((word: any, index: number) => ({
              id: String(word.id || `w${index + 1}`),
              start: Number(word.start),
              end: Number(word.end),
              text: String(word.text ?? word.word ?? "").trim(),
            }))
            .filter(
              (word: SpeechWord) =>
                word.id &&
                Number.isFinite(word.start) &&
                Number.isFinite(word.end) &&
                word.end > word.start &&
                word.text,
            )
        : [],
    }
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }
}
