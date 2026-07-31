import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeSpeechSegments,
  normalizeSpeechWords,
  refineSpeechSegmentTimings,
} from "../src/server/speechApi.ts"

test("speech API normalizes and drops invalid timestamped segments", () => {
  assert.deepEqual(
    normalizeSpeechSegments([
      { start: "0.2", end: "1.4", text: "  你好  " },
      { start: 2, end: 1, text: "invalid" },
      { start: 3, end: 4, text: "" },
    ]),
    [{ start: 0.2, end: 1.4, text: "你好" }],
  )
})

test("speech API normalizes Groq word timestamps", () => {
  assert.deepEqual(
    normalizeSpeechWords([
      { start: "5.12", end: "5.38", word: " 快 " },
      { start: 5.38, end: 5.66, text: "好" },
      { start: 6, end: 5, word: "invalid" },
      { start: 7, end: 8, word: "" },
    ]),
    [
      { start: 5.12, end: 5.38, text: "快" },
      { start: 5.38, end: 5.66, text: "好" },
    ],
  )
})

test("word timestamps trim leading and trailing segment silence", () => {
  const source = [{ start: 0, end: 7.28, text: "快好了。" }]
  const refined = refineSpeechSegmentTimings(source, [
    { start: 5.12, end: 5.38, word: "快" },
    { start: 5.38, end: 5.66, word: "好" },
    { start: 5.66, end: 5.91, word: "了" },
  ])

  assert.deepEqual(refined, [
    { start: 5.04, end: 6.03, text: "快好了。" },
  ])
  assert.equal(source[0].start, 0, "source segment must not be mutated")
})

test("word refinement preserves cue count, text, and original boundaries", () => {
  const segments = [
    { start: 0, end: 3, text: "第一句" },
    { start: 3.2, end: 5, text: "第二句" },
    { start: 8, end: 9, text: "没有词时间" },
  ]
  const refined = refineSpeechSegmentTimings(segments, [
    { start: 1.2, end: 1.5, word: "第一句" },
    { start: 3.5, end: 3.72, word: "第二句" },
  ])

  assert.equal(refined.length, segments.length)
  assert.deepEqual(refined.map((segment) => segment.text), segments.map((segment) => segment.text))
  assert.ok(refined[0].start >= segments[0].start && refined[0].end <= segments[0].end)
  assert.ok(refined[1].start >= segments[1].start && refined[1].end <= segments[1].end)
  assert.deepEqual(refined[2], segments[2])
  assert.ok(refined[0].end <= refined[1].start)
})

test("word refinement safely falls back when Groq omits word timestamps", () => {
  const segments = [{ start: 0, end: 7.28, text: "快好了。" }]
  assert.deepEqual(refineSpeechSegmentTimings(segments, undefined), segments)
  assert.deepEqual(
    refineSpeechSegmentTimings(segments, [{ start: 2, end: 1, word: "bad" }]),
    segments,
  )
})
