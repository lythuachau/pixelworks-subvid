import type { SubtitleSegment } from "@/scripts/subtitles.ts"

export type OcrObservation = SubtitleSegment & {
  confidence?: number
}

export type OcrCueQuality = {
  index: number
  cer: number
  confidence: number
  lengthRatio: number
  accepted: boolean
  asrText: string
  ocrText: string
}

export type OcrAlignmentReport = {
  cer: number
  matchedCues: number
  totalCues: number
  coverage: number
  referenceCharacters: number
  detectedBand?: "top" | "middle" | "bottom"
  observations?: number
  cues: OcrCueQuality[]
}

export type OcrAlignmentResult = {
  segments: SubtitleSegment[]
  report: OcrAlignmentReport
}

type AlignmentOptions = {
  maxCer?: number
  minConfidence?: number
  maxTimeDistance?: number
}

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/** Normalize punctuation/spacing variants before comparing Chinese captions. */
export function normalizeTextForCer(text: string): string {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu, "")
}

export function levenshteinDistance(reference: string, hypothesis: string): number {
  const a = Array.from(reference)
  const b = Array.from(hypothesis)
  if (!a.length) return b.length
  if (!b.length) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1)
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[b.length]
}

/** Character error rate, using the ASR text as the reference. */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const normalizedReference = normalizeTextForCer(reference)
  const normalizedHypothesis = normalizeTextForCer(hypothesis)
  if (!normalizedReference.length) return normalizedHypothesis.length ? 1 : 0
  return levenshteinDistance(normalizedReference, normalizedHypothesis) /
    normalizedReference.length
}

function timeDistance(source: SubtitleSegment, candidate: OcrObservation) {
  const sourceMid = (source.start + source.end) / 2
  const candidateMid = (candidate.start + candidate.end) / 2
  if (candidate.end >= source.start && candidate.start <= source.end) return 0
  return Math.abs(sourceMid - candidateMid)
}

function conservativeOcrText(
  asrNormalized: string,
  ocrText: string,
  confidence: number,
) {
  const normalized = normalizeTextForCer(ocrText)
  if (confidence < 85 || normalized.length !== asrNormalized.length + 1) {
    return ocrText
  }
  let prefix = 0
  while (
    prefix < asrNormalized.length &&
    asrNormalized[prefix] === normalized[prefix]
  ) {
    prefix += 1
  }
  // A high-confidence OCR line occasionally contains one UI glyph/caption
  // character at the tail. Trim only when all but the final ASR character
  // already align, so normal longer captions are never truncated.
  if (prefix < asrNormalized.length - 1) return ocrText
  return Array.from(normalized).slice(0, asrNormalized.length).join("")
}

/**
 * Align OCR text to ASR cues. ASR is the timing authority; accepted OCR only
 * replaces text and never contributes timestamps or synthetic word timings.
 */
export function alignOcrToAsr(
  asrSegments: SubtitleSegment[],
  observations: OcrObservation[],
  options: AlignmentOptions = {},
): OcrAlignmentResult {
  const maxCer = options.maxCer ?? 0.65
  const minConfidence = options.minConfidence ?? 80
  const maxTimeDistance = options.maxTimeDistance ?? 1.25
  const cues: OcrCueQuality[] = []
  let matchedCues = 0
  let distanceTotal = 0
  let referenceCharacters = 0

  const segments = asrSegments.map((asr, index) => {
    const candidates = observations
      .filter((item) => timeDistance(asr, item) <= maxTimeDistance)
      .map((item) => {
        const cer = characterErrorRate(asr.text, item.text)
        const temporalPenalty = Math.min(1, timeDistance(asr, item) / maxTimeDistance)
        const confidencePenalty = Math.max(0, 50 - (item.confidence ?? 0)) / 100
        return { item, cer, score: cer + temporalPenalty * 0.15 + confidencePenalty * 0.1 }
      })
      .sort((a, b) => a.score - b.score)

    const best = candidates[0]
    const asrNormalized = normalizeTextForCer(asr.text)
    const confidence = best?.item.confidence ?? 0
    const ocrText = best
      ? conservativeOcrText(asrNormalized, best.item.text, confidence)
      : ""
    const ocrNormalized = normalizeTextForCer(ocrText)
    const cer = best ? characterErrorRate(asr.text, ocrText) : 1
    const lengthRatio = asrNormalized.length
      ? ocrNormalized.length / asrNormalized.length
      : 0
    const hasChineseText = HAN_RE.test(ocrNormalized)
    const accepted =
      !!best &&
      hasChineseText &&
      ocrNormalized.length >= 2 &&
      lengthRatio >= 0.72 &&
      lengthRatio <= 1.35 &&
      confidence >= minConfidence &&
      cer <= maxCer

    referenceCharacters += asrNormalized.length
    distanceTotal += cer * asrNormalized.length
    if (accepted) matchedCues += 1
    cues.push({
      index,
      cer,
      confidence,
      lengthRatio,
      accepted,
      asrText: asr.text,
      ocrText,
    })

    return {
      start: asr.start,
      end: asr.end,
      text: accepted ? ocrText.trim() : asr.text,
      // Deliberately omit `words`: OCR/translated character timings would be fake.
    }
  })

  return {
    segments,
    report: {
      cer: referenceCharacters ? distanceTotal / referenceCharacters : 0,
      matchedCues,
      totalCues: asrSegments.length,
      coverage: asrSegments.length ? matchedCues / asrSegments.length : 0,
      referenceCharacters,
      cues,
    },
  }
}
