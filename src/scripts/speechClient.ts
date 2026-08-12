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

export type GroqAudioChunk = {
  startSample: number
  endSample: number
  offsetSeconds: number
  discardBeforeSeconds: number
}

const GROQ_SAMPLE_RATE = 16000
const GROQ_CHUNK_SECONDS = 12 * 60
const GROQ_CHUNK_OVERLAP_SECONDS = 1

export function planGroqAudioChunks(
  sampleCount: number,
  sampleRate = GROQ_SAMPLE_RATE,
): GroqAudioChunk[] {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) return []
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return []

  const maxSamples = Math.floor(GROQ_CHUNK_SECONDS * sampleRate)
  const overlapSamples = Math.floor(GROQ_CHUNK_OVERLAP_SECONDS * sampleRate)
  const chunks: GroqAudioChunk[] = []
  let startSample = 0
  while (startSample < sampleCount) {
    const endSample = Math.min(sampleCount, startSample + maxSamples)
    const offsetSeconds = startSample / sampleRate
    chunks.push({
      startSample,
      endSample,
      offsetSeconds,
      discardBeforeSeconds:
        chunks.length === 0
          ? Number.NEGATIVE_INFINITY
          : offsetSeconds + GROQ_CHUNK_OVERLAP_SECONDS,
    })
    if (endSample >= sampleCount) break
    startSample = endSample - overlapSamples
  }
  return chunks
}

function normalizedBoundaryText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

export function mergeGroqTranscriptions(
  parts: Array<{ chunk: GroqAudioChunk; transcript: GroqTranscription }>,
  duration: number,
): GroqTranscription {
  const segments: SpeechSegment[] = []
  const words: SpeechWord[] = []
  const models = new Set<string>()
  let language = ""

  for (const { chunk, transcript } of parts) {
    if (transcript.model) models.add(transcript.model)
    if (!language && transcript.language) language = transcript.language

    for (const segment of transcript.segments) {
      const candidate = {
        start: segment.start + chunk.offsetSeconds,
        end: segment.end + chunk.offsetSeconds,
        text: segment.text,
      }
      if (candidate.end <= chunk.discardBeforeSeconds) continue
      const previous = segments[segments.length - 1]
      const touchesBoundary =
        Number.isFinite(chunk.discardBeforeSeconds) &&
        candidate.start <= chunk.discardBeforeSeconds + 2 &&
        previous?.end >= chunk.offsetSeconds
      if (
        touchesBoundary &&
        normalizedBoundaryText(previous.text) ===
          normalizedBoundaryText(candidate.text)
      ) {
        previous.end = Math.max(previous.end, candidate.end)
        continue
      }
      segments.push(candidate)
    }

    for (const word of transcript.words) {
      const candidate = {
        id: "",
        start: word.start + chunk.offsetSeconds,
        end: word.end + chunk.offsetSeconds,
        text: word.text,
      }
      if (candidate.end <= chunk.discardBeforeSeconds) continue
      const previous = words[words.length - 1]
      const duplicateBoundaryWord =
        previous &&
        Number.isFinite(chunk.discardBeforeSeconds) &&
        candidate.start <= chunk.discardBeforeSeconds + 0.5 &&
        previous.end >= chunk.offsetSeconds &&
        normalizedBoundaryText(previous.text) ===
          normalizedBoundaryText(candidate.text) &&
        candidate.start <= previous.end + 0.1
      if (duplicateBoundaryWord) {
        previous.end = Math.max(previous.end, candidate.end)
        continue
      }
      words.push(candidate)
    }
  }

  words.forEach((word, index) => {
    word.id = `w${index + 1}`
  })
  return {
    model: [...models].join(", ") || "whisper-large-v3",
    language,
    duration,
    segments,
    words,
  }
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
    onChunk?: (current: number, total: number) => void
  } = {},
): Promise<GroqTranscription> {
  const chunks = planGroqAudioChunks(samples.length, GROQ_SAMPLE_RATE)
  if (!chunks.length)
    throw new Error("Không có dữ liệu audio để nhận dạng.")

  const parts: Array<{
    chunk: GroqAudioChunk
    transcript: GroqTranscription
  }> = []
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    options.signal?.throwIfAborted()
    options.onChunk?.(index + 1, chunks.length)
    options.onProgress?.(45 + (index / chunks.length) * 47)

    const body = new FormData()
    const wav = encodePcm16Wav(
      samples.subarray(chunk.startSample, chunk.endSample),
      GROQ_SAMPLE_RATE,
    )
    body.append(
      "file",
      new File([wav], `audio-part-${index + 1}.wav`, {
        type: "audio/wav",
      }),
    )
    if (options.language) body.append("language", options.language)
    if (options.models?.length)
      body.append("models", options.models.join(","))
    if (options.prompt) body.append("prompt", options.prompt)

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
        const message = String(
          data.message || `Groq Whisper failed (HTTP ${response.status})`,
        )
        throw new Error(
          chunks.length > 1
            ? `Phần ${index + 1}/${chunks.length}: ${message}`
            : message,
        )
      }
      if (!Array.isArray(data.segments) || !data.segments.length)
        throw new Error("Groq Whisper không trả về đoạn lời thoại có timestamp.")
      parts.push({
        chunk,
        transcript: {
          model: String(data.model || "whisper-large-v3"),
          language: String(data.language || options.language || ""),
          duration: Number.isFinite(Number(data.duration))
            ? Number(data.duration)
            : undefined,
          segments: data.segments
            .map((segment: any) => ({
              start: Number(segment.start),
              end: Number(segment.end),
              text: String(segment.text || "").trim(),
            }))
            .filter(
              (segment: SpeechSegment) =>
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.end > segment.start &&
                segment.text,
            ),
          words: Array.isArray(data.words)
            ? data.words
                .map((word: any, wordIndex: number) => ({
                  id: String(word.id || `w${wordIndex + 1}`),
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
        },
      })
      options.onProgress?.(45 + ((index + 1) / chunks.length) * 47)
    } finally {
      window.clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
    }
  }

  return mergeGroqTranscriptions(
    parts,
    samples.length / GROQ_SAMPLE_RATE,
  )
}
