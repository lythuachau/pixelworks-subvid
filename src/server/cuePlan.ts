export type CuePlanWord = {
  id: string
  text: string
  start: number
  end: number
}

export type CuePlanSelection = {
  from?: string
  to: string
  translation: string
}

export type MaterializedCue = {
  sourceIds: string[]
  start: number
  end: number
  sourceText: string
  translation: string
}

export type CuePlanContextSegment = {
  start: number
  end: number
  text: string
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const LEADING_PUNCTUATION_RE = /^[,.;:!?%\)\]\}\u2026\u3001\uff0c\uff1b\uff1a\u3002\uff01\uff1f]/u
const TRAILING_OPEN_RE = /[(\[\{\u201c\u2018]$/u
const MAX_HARD_GAP_SECONDS = 0.7
const MAX_CUE_SECONDS = 8
const SENTENCE_END_RE = /[.!?\u3002\uff01\uff1f\u2026]$/u

function roundMillis(value: number) {
  return Math.round(value * 1000) / 1000
}

function appendToken(text: string, token: string) {
  if (!text) return token
  const previous = text.at(-1) || ""
  const next = token.charAt(0)
  if (
    LEADING_PUNCTUATION_RE.test(token) ||
    TRAILING_OPEN_RE.test(text) ||
    (CJK_RE.test(previous) && CJK_RE.test(next))
  )
    return `${text}${token}`
  return `${text} ${token}`
}

export function normalizeCuePlanWords(value: unknown): CuePlanWord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .map((word, index) => {
      const item = word as Record<string, unknown>
      const id = String(item.id || `w${index + 1}`).trim()
      const text = String(item.text ?? item.word ?? "").trim()
      const start = Number(item.start)
      const end = Number(item.end)
      if (
        !id ||
        seen.has(id) ||
        !text ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      )
        return null
      seen.add(id)
      return { id, text, start: Math.max(0, start), end, index }
    })
    .filter(
      (
        word,
      ): word is CuePlanWord & {
        index: number
      } => !!word,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index)
    .map(({ index: _index, ...word }) => word)
}

function sourceTextFor(words: CuePlanWord[]) {
  return words.reduce((text, word) => appendToken(text, word.text), "").trim()
}

export function buildCuePlanPrompt(
  wordsValue: unknown,
  segmentsValue: unknown,
  sourceLang: string,
  targetLang: string,
) {
  const words = normalizeCuePlanWords(wordsValue)
  const segments = Array.isArray(segmentsValue)
    ? segmentsValue
        .map((segment) => {
          const item = segment as Record<string, unknown>
          return {
            start: Number(item.start),
            end: Number(item.end),
            text: String(item.text || "").replace(/\r?\n/g, " ").trim(),
          }
        })
        .filter(
          (segment) =>
            Number.isFinite(segment.start) &&
            Number.isFinite(segment.end) &&
            segment.end > segment.start &&
            segment.text,
        )
    : []
  const wordLines = words
    .map(
      (word) =>
        `${word.id}|${word.start.toFixed(3)}-${word.end.toFixed(3)}|${word.text.replace(/\r?\n/g, " ")}`,
    )
    .join("\n")
  const segmentLines = segments
    .map(
      (segment, index) =>
        `s${index + 1}|${segment.start.toFixed(3)}-${segment.end.toFixed(3)}|${segment.text}`,
    )
    .join("\n")
  const lastId = words.at(-1)?.id || ""
  const mandatoryEndIds = words
    .slice(0, -1)
    .filter(
      (word, index) =>
        words[index + 1].start - word.end > MAX_HARD_GAP_SECONDS,
    )
    .map((word) => word.id)

  return [
    "You are a subtitle sentence-boundary planner and professional translator.",
    `Source language code: ${sourceLang}.`,
    `Target language: natural spoken ${targetLang}.`,
    "Read all supplied context, identify complete semantic sentences or dialogue turns, and translate each resulting cue.",
    "You do NOT need to identify speaker names.",
    "Return ONLY JSON in exactly this shape:",
    '{"cues":[{"to":"w8","translation":"..."}]}',
    "Hard rules:",
    "- `to` is the final word ID of a cue. The first cue starts at the first supplied word; every later cue starts immediately after the previous `to`.",
    `- Output \`to\` IDs in strictly increasing order. The final cue must end at ${lastId}.`,
    "- Do not output `from`; the server derives it so no word can be skipped or repeated.",
    "- Do not cross a silence longer than 0.7 seconds.",
    ...(mandatoryEndIds.length
      ? [
          `- Mandatory cue endings caused by hard silence: ${mandatoryEndIds.join(", ")}. Every one of these IDs MUST appear as a \`to\` value.`,
        ]
      : []),
    "- Prefer complete sentences or clauses lasting 1.2-5 seconds; never exceed 8 seconds.",
    "- Avoid cues shorter than 0.8 seconds. Attach a tiny reaction or filler to a natural neighbor unless a mandatory hard silence prevents it.",
    "- Keep questions and their answers as separate cues.",
    "- Keep a new reaction, reply, vocative, or clear change of thought as a separate cue.",
    "- Attach tiny fillers only when they naturally belong to the neighboring sentence.",
    "- Use the full ASR context to keep names, pronouns, and terminology consistent across chunks.",
    "- For Chinese personal names translated to Vietnamese, prefer a conventional Sino-Vietnamese reading when confident (for example 陈→Trần, 胡→Hồ); otherwise use one consistent transliteration.",
    "- Make the translation concise and natural for short-video subtitles, and preserve names and numbers.",
    "- Never output timestamps. The server computes them from word IDs.",
    "",
    "Existing ASR segments (context only; you may split them):",
    segmentLines,
    "",
    "Timestamped word units:",
    wordLines,
  ].join("\n")
}

/**
 * Split a long transcript near ASR/silence/sentence boundaries. Each word
 * belongs to exactly one chunk; neighboring ASR segments are supplied later as
 * read-only context.
 */
export function splitCuePlanWords(
  wordsValue: unknown,
  segmentsValue: unknown,
  targetSize = 80,
) {
  const words = normalizeCuePlanWords(wordsValue)
  if (!words.length) return [] as CuePlanWord[][]
  const size = Math.max(40, Math.min(120, Math.round(targetSize)))
  const minSize = Math.max(28, Math.round(size * 0.68))
  const maxSize = Math.min(140, Math.round(size * 1.22))
  const segmentEnds = Array.isArray(segmentsValue)
    ? segmentsValue
        .map((segment) => Number((segment as Record<string, unknown>).end))
        .filter(Number.isFinite)
    : []
  const chunks: CuePlanWord[][] = []
  let start = 0

  while (words.length - start > maxSize) {
    const desired = Math.min(words.length - 1, start + size)
    const low = Math.min(words.length - 1, start + minSize)
    const high = Math.min(words.length - 2, start + maxSize)
    let bestCut = desired
    let bestScore = Number.NEGATIVE_INFINITY
    for (let cut = low; cut <= high; cut += 1) {
      const previous = words[cut - 1]
      const next = words[cut]
      if (!previous || !next) continue
      const gap = Math.max(0, next.start - previous.end)
      const nearSegmentEnd = segmentEnds.some(
        (end) => Math.abs(end - previous.end) <= 0.22,
      )
      const sentenceEnd = SENTENCE_END_RE.test(previous.text)
      const distancePenalty = Math.abs(cut - desired) * 0.035
      const score =
        gap * 9 +
        (gap > MAX_HARD_GAP_SECONDS ? 8 : 0) +
        (nearSegmentEnd ? 3 : 0) +
        (sentenceEnd ? 4 : 0) -
        distancePenalty
      if (score > bestScore) {
        bestScore = score
        bestCut = cut
      }
    }
    chunks.push(words.slice(start, bestCut))
    start = bestCut
  }
  chunks.push(words.slice(start))
  return chunks.filter((chunk) => chunk.length)
}

function planArray(value: unknown): CuePlanSelection[] {
  const root = value as { cues?: unknown } | null
  if (!root || !Array.isArray(root.cues)) throw new Error("AI cue plan has no cues array.")
  return root.cues.map((cue) => {
    const item = cue as Record<string, unknown>
    return {
      from: String(item.from ?? item.from_word ?? "").trim(),
      to: String(item.to ?? item.to_word ?? "").trim(),
      translation: String(item.translation ?? "").replace(/\s+/g, " ").trim(),
    }
  })
}

/**
 * Turn an AI-selected list of contiguous word ranges into subtitle cues.
 * The model never controls timestamps: it only references existing word IDs.
 */
export function materializeCuePlan(
  wordsValue: unknown,
  planValue: unknown,
  options: { targetLang?: string } = {},
): MaterializedCue[] {
  const words = normalizeCuePlanWords(wordsValue)
  if (!words.length) throw new Error("No valid timestamped words.")
  const selections = planArray(planValue)
  if (!selections.length) throw new Error("AI cue plan is empty.")

  const indexById = new Map(words.map((word, index) => [word.id, index]))
  const cues: Array<
    MaterializedCue & { fromIndex: number; toIndex: number }
  > = []
  let cursor = 0

  for (const selection of selections) {
    // The compact plan only asks the model for sentence-ending IDs. Deriving
    // the next start from the cursor makes skipped/repeated timestamp ranges
    // structurally impossible. Legacy from/to plans remain accepted.
    const fromIndex = selection.from
      ? indexById.get(selection.from)
      : cursor
    const toIndex = indexById.get(selection.to)
    if (fromIndex == null || toIndex == null)
      throw new Error("AI cue plan references an unknown word ID.")
    if (fromIndex !== cursor || toIndex < fromIndex)
      throw new Error("AI cue plan skipped, repeated, or reordered word IDs.")
    if (!selection.translation)
      throw new Error("AI cue plan contains an empty translation.")
    if (
      options.targetLang &&
      !["zh", "ja", "ko"].includes(options.targetLang) &&
      CJK_RE.test(selection.translation)
    )
      throw new Error("AI cue plan left untranslated CJK text.")

    const members = words.slice(fromIndex, toIndex + 1)
    for (let index = 1; index < members.length; index += 1) {
      if (members[index].start - members[index - 1].end > MAX_HARD_GAP_SECONDS)
        throw new Error("AI cue plan crossed a hard silence.")
    }

    const start = Math.max(0, members[0].start - 0.08)
    const end = members[members.length - 1].end + 0.12
    if (end - start > MAX_CUE_SECONDS)
      throw new Error("AI cue plan created a cue longer than 8 seconds.")

    cues.push({
      sourceIds: members.map((word) => word.id),
      start: roundMillis(start),
      end: roundMillis(end),
      sourceText: sourceTextFor(members),
      translation: selection.translation,
      fromIndex,
      toIndex,
    })
    cursor = toIndex + 1
  }

  if (cursor !== words.length)
    throw new Error("AI cue plan did not cover every timestamped word.")

  // Padding around adjacent ranges can overlap. Split the overlap at the
  // acoustic boundary while preserving a small blank frame between captions.
  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1]
    const current = cues[index]
    if (previous.end < current.start) continue
    const previousWordEnd = words[previous.toIndex].end
    const currentWordStart = words[current.fromIndex].start
    const boundary = (previousWordEnd + currentWordStart) / 2
    previous.end = roundMillis(
      Math.max(previous.start + 0.2, boundary - 0.01),
    )
    current.start = roundMillis(
      Math.min(current.end - 0.2, boundary + 0.01),
    )
  }

  return cues.map(({ fromIndex: _from, toIndex: _to, ...cue }) => cue)
}
