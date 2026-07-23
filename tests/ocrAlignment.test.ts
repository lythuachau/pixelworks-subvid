import assert from "node:assert/strict"
import test from "node:test"

import {
  alignOcrToAsr,
  characterErrorRate,
  normalizeTextForCer,
} from "../src/scripts/ocrAlignment.ts"
import {
  optimizeSubtitleSegments,
  reflowTranslatedSegments,
} from "../src/scripts/subtitles.ts"

test("CER normalizes Chinese punctuation and spacing", () => {
  assert.equal(normalizeTextForCer(" 你好，世界！ "), "你好世界")
  assert.equal(characterErrorRate("你好，世界！", "你好世界"), 0)
  assert.equal(characterErrorRate("你好世界", "你好世间"), 0.25)
})

test("OCR alignment accepts a close Chinese cue and preserves ASR timing", () => {
  const source = [{ start: 1.25, end: 3.75, text: "今天天气很好" }]
  const result = alignOcrToAsr(source, [
    { start: 1.3, end: 3.7, text: "今天天气很好", confidence: 91 },
  ])

  assert.equal(result.segments[0].text, "今天天气很好")
  assert.equal(result.segments[0].start, source[0].start)
  assert.equal(result.segments[0].end, source[0].end)
  assert.equal("words" in result.segments[0], false)
  assert.equal(result.report.cer, 0)
  assert.equal(result.report.coverage, 1)
})

test("OCR alignment rejects high-CER text and keeps ASR text", () => {
  const source = [{ start: 0, end: 2, text: "这是原始字幕" }]
  const result = alignOcrToAsr(source, [
    { start: 0, end: 2, text: "完全不同内容", confidence: 99 },
  ])

  assert.equal(result.segments[0].text, source[0].text)
  assert.equal(result.report.matchedCues, 0)
  assert.equal(result.report.cues[0].accepted, false)
})

test("OCR alignment rejects a partial caption that would erase valid ASR text", () => {
  const source = [{ start: 0, end: 3, text: "这里离山境采药方便" }]
  const result = alignOcrToAsr(source, [
    { start: 0, end: 3, text: "这里离山近", confidence: 96 },
  ])

  assert.equal(result.segments[0].text, source[0].text)
  assert.equal(result.report.cues[0].accepted, false)
  assert.ok(result.report.cues[0].lengthRatio < 0.72)
})

test("OCR alignment trims one high-confidence trailing artifact conservatively", () => {
  const source = [{ start: 0, end: 2, text: "给你的上房为何不准" }]
  const result = alignOcrToAsr(source, [
    { start: 0, end: 2, text: "给你的上房为何不住过", confidence: 91 },
  ])
  assert.equal(result.segments[0].text, "给你的上房为何不住")
  assert.equal(result.report.cues[0].accepted, true)
})

test("translated cues keep exact source timing and have no synthetic words", () => {
  const source = [
    { start: 0.42, end: 1.17, text: "你好" },
    { start: 1.3, end: 2.05, text: "世界" },
  ]
  const translated = [
    { start: 0, end: 9, text: "Xin chào" },
    { start: 9, end: 18, text: "thế giới rất dài" },
  ]
  const result = reflowTranslatedSegments(source, translated, { targetLang: "vi" })

  assert.deepEqual(
    result.map(({ start, end }) => ({ start, end })),
    source.map(({ start, end }) => ({ start, end })),
  )
  assert.equal(result.every((cue) => !("words" in cue)), true)
})

test("source optimization merges adjacent fragments but preserves hard silences", () => {
  const result = optimizeSubtitleSegments(
    [
      { start: 0, end: 2, text: "这次比武有人押姐姐" },
      { start: 2, end: 2.35, text: "输" },
      { start: 3.2, end: 4.4, text: "他们押了谁" },
      { start: 8, end: 8.4, text: "后来" },
    ],
    "zh",
  )

  assert.equal(result.length, 3)
  assert.equal(result[0].text, "这次比武有人押姐姐输")
  assert.equal(result[0].start, 0)
  assert.equal(result[0].end, 2.35)
  assert.equal(result[1].text, "他们押了谁")
  assert.equal(result[2].start, 8)
})

test("source optimization absorbs a tiny tail just beyond the normal duration cap", () => {
  const result = optimizeSubtitleSegments(
    [
      { start: 10, end: 16.1, text: "看风我看你大眼别看下面看风我睁不开" },
      { start: 16.1, end: 16.72, text: "眼" },
    ],
    "zh",
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].text.endsWith("眼"), true)
  assert.equal(result[0].end, 16.72)
})
