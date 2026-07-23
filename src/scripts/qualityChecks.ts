import type { SubtitleSegment } from "@/scripts/subtitles.ts"

export type QualityIssueCode =
  | "negative_time"
  | "invalid_duration"
  | "overlap"
  | "empty_text"
  | "high_cps"
  | "long_line"
  | "too_short"
  | "internal_silence"
  | "repeated_boundary"
  | "untranslated_text"

export type QualityIssue = {
  lang: string
  index: number
  code: QualityIssueCode
  severity: "error" | "warning"
  value?: number
  limit?: number
}

export type QualityLimits = {
  maxCpsLatin?: number
  maxCpsCjk?: number
  maxCharsLatin?: number
  maxCharsCjk?: number
  minCueDuration?: number
  maxInternalSilence?: number
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export const DEFAULT_QUALITY_LIMITS: Required<QualityLimits> = {
  maxCpsLatin: 20,
  maxCpsCjk: 14,
  maxCharsLatin: 42,
  maxCharsCjk: 22,
  minCueDuration: 0.75,
  maxInternalSilence: 1.2,
}

function visibleCharacters(text: string) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length
}

function normalizedWords(text: string) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function hasRepeatedBoundary(current: string, next: string) {
  const a = normalizedWords(current)
  const b = normalizedWords(next)
  if (!a.length || !b.length) return false
  const phraseLength = Math.min(3, a.length, b.length)
  for (let size = phraseLength; size >= 2; size -= 1) {
    if (a.slice(-size).join(" ") === b.slice(0, size).join(" ")) return true
  }
  return a.length <= 3 && b.length <= 3 && a.join(" ") === b.join(" ")
}

export function analyzeSubtitleTrack(
  segments: SubtitleSegment[],
  lang: string,
  limits: QualityLimits = {},
): QualityIssue[] {
  const resolved = { ...DEFAULT_QUALITY_LIMITS, ...limits }
  const issues: QualityIssue[] = []

  segments.forEach((segment, index) => {
    const start = Number(segment.start)
    const end = Number(segment.end)
    const text = String(segment.text || "")
    const isCjk = CJK_RE.test(text) || ["zh", "ja", "ko"].includes(lang)

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
      issues.push({ lang, index, code: "negative_time", severity: "error" })
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      issues.push({ lang, index, code: "invalid_duration", severity: "error" })
    }
    if (!text.trim()) {
      issues.push({ lang, index, code: "empty_text", severity: "error" })
    }

    const previous = segments[index - 1]
    if (previous && Number.isFinite(start) && start < Number(previous.end) - 0.001) {
      issues.push({
        lang,
        index,
        code: "overlap",
        severity: "error",
        value: Number(previous.end) - start,
      })
    }

    const duration = end - start
    if (duration > 0 && text.trim()) {
      if (duration < resolved.minCueDuration) {
        issues.push({
          lang,
          index,
          code: "too_short",
          severity: "warning",
          value: duration,
          limit: resolved.minCueDuration,
        })
      }

      const cps = visibleCharacters(text) / duration
      const maxCps = isCjk ? resolved.maxCpsCjk : resolved.maxCpsLatin
      if (cps > maxCps) {
        issues.push({
          lang,
          index,
          code: "high_cps",
          severity: "warning",
          value: cps,
          limit: maxCps,
        })
      }
    }

    const words = Array.isArray(segment.words) ? segment.words : []
    for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
      const silence = Number(words[wordIndex].start) - Number(words[wordIndex - 1].end)
      if (Number.isFinite(silence) && silence > resolved.maxInternalSilence) {
        issues.push({
          lang,
          index,
          code: "internal_silence",
          severity: "warning",
          value: silence,
          limit: resolved.maxInternalSilence,
        })
        break
      }
    }

    if (!["zh", "ja", "ko"].includes(lang) && CJK_RE.test(text)) {
      issues.push({
        lang,
        index,
        code: "untranslated_text",
        severity: "warning",
      })
    }

    const next = segments[index + 1]
    if (next && hasRepeatedBoundary(text, String(next.text || ""))) {
      issues.push({
        lang,
        index: index + 1,
        code: "repeated_boundary",
        severity: "warning",
      })
    }

    const maxChars = isCjk ? resolved.maxCharsCjk : resolved.maxCharsLatin
    for (const line of text.split(/\r?\n/)) {
      const length = Array.from(line.trim()).length
      if (length > maxChars) {
        issues.push({
          lang,
          index,
          code: "long_line",
          severity: "warning",
          value: length,
          limit: maxChars,
        })
        break
      }
    }
  })

  return issues
}

export function analyzeSubtitleTracks(
  tracks: Record<string, SubtitleSegment[]>,
  limits: QualityLimits = {},
) {
  return Object.entries(tracks).flatMap(([lang, segments]) =>
    analyzeSubtitleTrack(segments || [], lang, limits),
  )
}
