import { LANGS } from "./languages.ts"

export type SubtitleSegment = {
  start: number
  end: number
  text: string
  words?: SubtitleWord[]
  speaker?: string
}

export type SubtitleWord = {
  start: number
  end: number
  text: string
  speaker?: string
}

type NormalizeSegmentsOptions = {
  audio?: Float32Array
  sampleRate?: number
  aspectRatio?: number
}

type SpeechRun = {
  start: number
  end: number
}

const DEFAULT_SAMPLE_RATE = 16_000
const SILENCE_BREAK_SECONDS = 0.55

export function formatSrtTime(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(c / 3600)
  const m = Math.floor((c % 3600) / 60)
  const s = Math.floor(c % 60)
  const ms = Math.floor((c - Math.floor(c)) * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

export function formatClock(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(c / 60)
  const s = Math.floor(c % 60)
  const cs = Math.round((c - Math.floor(c)) * 100)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${m}:${p(s)}.${p(cs)}`
}

export function parseClock(value: string): number | null {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) return null
  const m = Number(match[1])
  const s = Number(match[2])
  const frac = match[3] ? Number(`0.${match[3]}`) : 0
  return m * 60 + s + frac
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.floor((values.length - 1) * ratio)),
  )
  return values[index]
}

function speechRunsForAudio(audio?: Float32Array, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!audio?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return []

  const frameSamples = Math.max(1, Math.round(sampleRate * 0.04))
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.02))
  const frameCount = Math.max(1, Math.floor((audio.length - frameSamples) / hopSamples) + 1)
  const energies = new Array<number>(frameCount)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSamples
    const end = Math.min(audio.length, start + frameSamples)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += audio[i] * audio[i]
    energies[frame] = Math.sqrt(sum / Math.max(1, end - start))
  }

  const sorted = [...energies].sort((a, b) => a - b)
  const noiseFloor = percentile(sorted, 0.2)
  const speechLevel = percentile(sorted, 0.85)
  const threshold = Math.max(0.003, noiseFloor * 4, speechLevel * 0.12)
  const runs: SpeechRun[] = []
  let activeStart = -1

  energies.forEach((energy, frame) => {
    if (energy >= threshold) {
      if (activeStart < 0) activeStart = frame
      return
    }
    if (activeStart < 0) return
    const start = (activeStart * hopSamples) / sampleRate
    const end = (frame * hopSamples + frameSamples) / sampleRate
    if (end - start >= 0.06) runs.push({ start, end })
    activeStart = -1
  })

  if (activeStart >= 0) {
    const start = (activeStart * hopSamples) / sampleRate
    const end = audio.length / sampleRate
    if (end - start >= 0.06) runs.push({ start, end })
  }

  return runs.reduce<SpeechRun[]>((merged, run) => {
    const previous = merged[merged.length - 1]
    if (previous && run.start - previous.end <= 0.16) {
      previous.end = Math.max(previous.end, run.end)
    } else {
      merged.push({ ...run })
    }
    return merged
  }, [])
}

function nearestRunEdge(
  runs: SpeechRun[],
  time: number,
  edge: "start" | "end",
  before: number,
  after: number,
) {
  let best: { value: number; distance: number } | null = null
  for (const run of runs) {
    if (run.end < time - before || run.start > time + after) continue
    const value = edge === "start" ? run.start : run.end
    const distance = Math.abs(value - time)
    if (!best || distance < best.distance) best = { value, distance }
  }
  return best?.value
}

function refineSegmentsWithSpeechRuns(
  segments: SubtitleSegment[],
  audio?: Float32Array,
  sampleRate = DEFAULT_SAMPLE_RATE,
) {
  const runs = speechRunsForAudio(audio, sampleRate)
  if (!runs.length) return segments
  const audioEnd = audio ? audio.length / sampleRate : Number.POSITIVE_INFINITY

  const refined = segments.map((segment) => {
    const startEdge = nearestRunEdge(runs, segment.start, "start", 0.35, 0.65)
    const endEdge = nearestRunEdge(runs, segment.end, "end", 0.65, 0.35)
    const start =
      startEdge == null ? segment.start : Math.max(0, startEdge - 0.04)
    const end =
      endEdge == null ? segment.end : Math.min(audioEnd, endEdge + 0.08)
    const next = {
      ...segment,
      start,
      end: Math.max(start + 0.35, end),
    }
    if (next.words?.length) {
      next.words = next.words.map((word) => ({ ...word }))
      next.words[0].start = next.start
      next.words[next.words.length - 1].end = next.end
    }
    return next
  })

  for (let i = 1; i < refined.length; i += 1) {
    const previous = refined[i - 1]
    const current = refined[i]
    if (current.start > previous.end) continue
    const boundary = (previous.end + current.start) / 2
    previous.end = Math.max(previous.start + 0.25, boundary - 0.01)
    current.start = Math.min(current.end - 0.25, previous.end + 0.02)
  }

  return refined
}

function normalizedRange(chunk: any, index: number) {
  const range = Array.isArray(chunk?.timestamp)
    ? chunk.timestamp
    : [index * 2, index * 2 + 2]
  const start = Number.isFinite(range[0]) ? range[0] : index * 2
  const end = Number.isFinite(range[1]) ? range[1] : start + 2
  return {
    start,
    end: Math.max(start + 0.08, end),
  }
}

function normalizeWordChunk(chunk: any, index: number): SubtitleWord | null {
  const text = String(chunk?.text || "").trim()
  if (!text) return null
  const { start, end } = normalizedRange(chunk, index)
  return {
    start,
    end,
    text,
    speaker: String(chunk?.speaker || "").trim() || undefined,
  }
}

function isWordLevelChunks(chunks: any[]) {
  const textChunks = chunks
    .map((chunk) => String(chunk?.text || "").trim())
    .filter(Boolean)
  if (textChunks.length < 2) return false
  const singleWordChunks = textChunks.filter((text) => !/\s/.test(text)).length
  return singleWordChunks / textChunks.length > 0.82
}

function wordsText(words: SubtitleWord[]) {
  return words.reduce((text, word) => appendWordText(text, word.text), "").trim()
}

function appendWordText(text: string, word: string) {
  if (!text) return word
  if (shouldJoinWithoutSpace(text, word)) return `${text}${word}`
  return `${text} ${word}`
}

function shouldJoinWithoutSpace(previous: string, next: string) {
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  return (
    /^[,.;:!?%\)\]\}\u2026]/.test(next) ||
    /[(\[\{]$/.test(previous) ||
    (cjk.test(previous.at(-1) || "") && cjk.test(next.charAt(0)))
  )
}

function tokenizeSubtitleText(text: string) {
  if (/\s/.test(text)) return text.split(/\s+/).filter(Boolean)
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text))
    return Array.from(text)
  return text ? [text] : []
}

function buildWordSegment(words: SubtitleWord[]): SubtitleSegment {
  const start = words[0]?.start || 0
  const end = words[words.length - 1]?.end || start + 2
  return {
    start,
    end: Math.max(start + 0.35, end),
    text: wordsText(words),
    words,
    speaker: words.find((word) => word.speaker)?.speaker,
  }
}

function lineLimitsForAspectRatio(aspectRatio: number) {
  // For portrait videos (< 1.0) shorten lines proportionally so text fits the narrow frame.
  // For landscape (>= 1.0) keep the defaults.
  const ratio = Math.min(1, aspectRatio * 1.2)
  return {
    maxChars: Math.max(24, Math.round(46 * ratio)),
    maxWords: Math.max(4, Math.round(8 * ratio)),
  }
}

function normalizeWordLevelSegments(chunks: any[], aspectRatio = 16 / 9): SubtitleSegment[] {
  const { maxChars, maxWords } = lineLimitsForAspectRatio(aspectRatio)
  const words = chunks
    .map((chunk, index) => normalizeWordChunk(chunk, index))
    .filter((word): word is SubtitleWord => !!word)
    .sort((a, b) => a.start - b.start)

  const segments: SubtitleSegment[] = []
  let line: SubtitleWord[] = []
  const flush = () => {
    if (!line.length) return
    segments.push(buildWordSegment(line))
    line = []
  }

  words.forEach((word) => {
    if (line.length) {
      const previousWord = line[line.length - 1]
      const silenceBefore = word.start - previousWord.end
      const nextText = wordsText([...line, word])
      const nextDuration = word.end - line[0].start
      const shouldBreak =
        (!!word.speaker &&
          !!previousWord.speaker &&
          word.speaker !== previousWord.speaker) ||
        silenceBefore > SILENCE_BREAK_SECONDS ||
        line.length >= maxWords ||
        nextText.length > maxChars ||
        nextDuration > 5.2
      if (shouldBreak) flush()
    }

    line.push(word)

    const text = wordsText(line)
    const duration = line[line.length - 1].end - line[0].start
    if (
      /[.!?\u2026]$/.test(word.text) &&
      line.length >= 3 &&
      duration >= 1.1 &&
      text.length >= 18
    )
      flush()
  })

  flush()
  return segments
}

export function estimatedWordsForSegment(segment: SubtitleSegment): SubtitleWord[] {
  const text = String(segment.text || "").trim()
  if (!text) return []

  const textWords = tokenizeSubtitleText(text)
  const storedWords =
    Array.isArray(segment.words) && segment.words.length ? segment.words : []
  if (
    storedWords.length &&
    wordsText(storedWords).replace(/\s+/g, " ") === text.replace(/\s+/g, " ")
  ) {
    return storedWords
  }

  const start = Number.isFinite(segment.start) ? segment.start : 0
  const end = Math.max(
    start + 0.35,
    Number.isFinite(segment.end) ? segment.end : start + 2,
  )
  const duration = end - start
  const totalWeight = textWords.reduce(
    (sum, word) => sum + Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length),
    0,
  )
  let cursor = start

  return textWords.map((word, index) => {
    const weight = Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length)
    const isLast = index === textWords.length - 1
    const wordEnd = isLast ? end : cursor + (duration * weight) / totalWeight
    const result = {
      start: cursor,
      end: Math.max(cursor + 0.05, wordEnd),
      text: word,
    }
    cursor = result.end
    return result
  })
}

export function normalizeSegments(
  output: any,
  options: NormalizeSegmentsOptions = {},
): SubtitleSegment[] {
  if (!output || !Array.isArray(output.chunks)) {
    const text = output?.text?.trim()
    return text ? [{ start: 0, end: 6, text }] : []
  }
  if (isWordLevelChunks(output.chunks)) {
    return refineSegmentsWithSpeechRuns(
      normalizeWordLevelSegments(output.chunks, options.aspectRatio),
      options.audio,
      options.sampleRate,
    )
  }

  const segments = output.chunks
    .map((chunk: any, index: number) => {
      const { start, end } = normalizedRange(chunk, index)
      return {
        start,
        end: Math.max(start + 0.35, end),
        text: (chunk.text || "").trim(),
        speaker: String(chunk.speaker || "").trim() || undefined,
      }
    })
    .filter((s: SubtitleSegment) => s.text.length > 0)

  return refineSegmentsWithSpeechRuns(segments, options.audio, options.sampleRate)
}

export function buildSrt(segments: SubtitleSegment[]): string {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}`,
    )
    .join("\n\n")
}

export function normalizeLanguageCode(code: string): string {
  if (!code) return ""
  const short = String(code).toLowerCase().slice(0, 2)
  return short in LANGS ? short : ""
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Soft-wrap subtitle text into at most `maxLines` lines of ~`maxChars`. */
export function wrapSubtitleText(
  text: string,
  maxChars = 42,
  maxLines = 2,
): string {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned || cleaned.length <= maxChars) return cleaned

  const isCjk = CJK_RE.test(cleaned)
  const tokens = isCjk
    ? Array.from(cleaned)
    : cleaned.split(/\s+/).filter(Boolean)

  const lines: string[] = []
  let current = ""

  const joinToken = (line: string, token: string) => {
    if (!line) return token
    return isCjk ? `${line}${token}` : `${line} ${token}`
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const candidate = joinToken(current, token)
    if (candidate.length <= maxChars || !current) {
      current = candidate
      continue
    }
    lines.push(current)
    current = token
    if (lines.length >= maxLines - 1) {
      // Dump the rest into the last line (may exceed maxChars slightly).
      current = tokens.slice(i).reduce((acc, t) => joinToken(acc, t), "")
      break
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines).join("\n")
}

type ReflowOptions = {
  targetLang?: string
  maxChars?: number
  maxLines?: number
}

type OptimizeSegmentsOptions = {
  /** Never join cues separated by more than this amount of silence. */
  maxGap?: number
  /** Upper bound for a merged spoken sentence. */
  maxDuration?: number
  /** Upper bound for merged source text before starting a new cue. */
  maxChars?: number
}

const SENTENCE_END_RE = /[.!?\u2026\u3002\uff01\uff1f]\s*$/u

/**
 * Rebuild ASR-sized chunks into readable source cues before translation.
 *
 * Whisper word chunks are intentionally conservative, which can leave a
 * predicate or one-character suffix in a 300 ms cue. Translating those chunks
 * one-by-one destroys sentence context. This pass joins adjacent chunks only
 * while their timing is continuous and keeps every hard silence as a boundary.
 */
export function optimizeSubtitleSegments(
  segments: SubtitleSegment[],
  lang = "",
  options: OptimizeSegmentsOptions = {},
): SubtitleSegment[] {
  if (segments.length < 2) return segments.map((segment) => ({ ...segment }))

  const isCjk = ["zh", "ja", "ko"].includes(lang) ||
    segments.some((segment) => CJK_RE.test(segment.text))
  const maxGap = options.maxGap ?? 0.65
  const maxDuration = options.maxDuration ?? (isCjk ? 6.2 : 5.5)
  const maxChars = options.maxChars ?? (isCjk ? 32 : 96)
  const softGap = Math.min(maxGap, 0.22)
  const shortDuration = 0.95
  const shortChars = isCjk ? 4 : 16
  const ordered = segments
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const optimized: SubtitleSegment[] = []
  let group: SubtitleSegment[] = []

  const groupText = (items: SubtitleSegment[]) =>
    items.reduce((text, item) => appendWordText(text, item.text.trim()), "").trim()

  const flush = () => {
    if (!group.length) return
    if (group.length === 1) {
      optimized.push({ ...group[0] })
      group = []
      return
    }

    const first = group[0]
    const last = group[group.length - 1]
    const allWords = group.every((segment) => Array.isArray(segment.words))
      ? group.flatMap((segment) => segment.words || [])
      : undefined
    const speakers = new Set(group.map((segment) => segment.speaker).filter(Boolean))
    optimized.push({
      start: first.start,
      end: last.end,
      text: groupText(group),
      words: allWords?.length ? allWords.map((word) => ({ ...word })) : undefined,
      speaker: speakers.size === 1 ? first.speaker : undefined,
    })
    group = []
  }

  for (const segment of ordered) {
    if (!group.length) {
      group.push(segment)
      continue
    }

    const previous = group[group.length - 1]
    const first = group[0]
    const gap = Math.max(0, segment.start - previous.end)
    const candidateText = groupText([...group, segment])
    const candidateDuration = segment.end - first.start
    const previousDuration = previous.end - previous.start
    const segmentDuration = segment.end - segment.start
    const previousChars = visibleTextLength(previous.text)
    const segmentChars = visibleTextLength(segment.text)
    const hasHardBoundary =
      gap > maxGap ||
      (!!previous.speaker && !!segment.speaker && previous.speaker !== segment.speaker) ||
      SENTENCE_END_RE.test(previous.text)
    const fragmentBoundary =
      previousDuration < shortDuration ||
      segmentDuration < shortDuration ||
      previousChars <= shortChars ||
      segmentChars <= shortChars
    const continuousSpeech = gap <= softGap
    const absorbTinyTail =
      continuousSpeech &&
      segmentDuration < 0.75 &&
      segmentChars <= shortChars &&
      candidateDuration <= maxDuration + 1.1 &&
      candidateText.length <= maxChars + shortChars
    const candidateTooLarge =
      !absorbTinyTail &&
      (candidateDuration > maxDuration || candidateText.length > maxChars)

    if (hasHardBoundary || candidateTooLarge || (!continuousSpeech && !fragmentBoundary)) {
      flush()
    }
    group.push(segment)
  }

  flush()
  return optimized
}

function visibleTextLength(text: string) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length
}

/**
 * Keep the source track as the sole timing authority. Translation may wrap text,
 * but it must never stretch/shift cues or fabricate per-word timestamps.
 */
export function reflowTranslatedSegments(
  source: SubtitleSegment[],
  translated: SubtitleSegment[],
  options: ReflowOptions = {},
): SubtitleSegment[] {
  const maxChars = options.maxChars ?? 42
  const maxLines = options.maxLines ?? 2

  return source.map((src, index) => {
    const dst = translated[index]
    // Once a destination cue exists, its text is authoritative. Do not fall
    // back to the raw source: a sanitized empty cue must not reintroduce an
    // ASR artefact such as a lone `[` into the translated track.
    const rawText = String(dst ? dst.text : src.text || "").trim()
    return {
      start: src.start,
      end: src.end,
      text: rawText ? wrapSubtitleText(rawText, maxChars, maxLines) : "",
      speaker: src.speaker,
      // No `words`: distributing translated characters over time is synthetic.
    }
  })
}
