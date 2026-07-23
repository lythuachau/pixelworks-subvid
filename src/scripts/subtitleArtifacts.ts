/**
 * Remove punctuation accidentally emitted by ASR/OCR at a cue boundary.
 *
 * A leading bracket is meaningful when it is a complete sound cue such as
 * `[MUSIC]`, but a lone `[` (or an unclosed bracket) is not translatable text.
 * Keeping this normalization separate lets the API receive clean cues without
 * changing cue order or timing.
 */
export function sanitizeSubtitleSourceText(text: unknown): string {
  let value = String(text ?? "").replace(/^\uFEFF/u, "").trim()
  if (!value) return ""

  // Strip one or more unmatched opening brackets. Preserve a valid cue label
  // when its closing bracket is nearby, e.g. `[MUSIC] hello`.
  while (value.startsWith("[")) {
    const close = value.indexOf("]", 1)
    const label = close > 1 ? value.slice(1, close).trim() : ""
    if (close > 1 && close <= 48 && label) break
    value = value.slice(1).trim()
  }

  // A dangling closing bracket at the beginning/end is the matching ASR
  // artefact and should not be sent to the translation model either.
  if (value.startsWith("]")) value = value.slice(1).trim()
  if (value.endsWith("]") && value.indexOf("[") < 0)
    value = value.slice(0, -1).trim()

  return value
}
