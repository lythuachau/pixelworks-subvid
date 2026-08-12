import assert from "node:assert/strict"
import test from "node:test"
import {
  materializeCuePlan,
  normalizeCuePlanWords,
} from "../src/server/cuePlan.ts"
import {
  canPlanSubtitleCues,
  MAX_CUE_PLAN_WORDS,
} from "../src/scripts/cuePlanClient.ts"

const words = [
  { id: "w1", text: "chào bạn", start: 5.12, end: 5.38 },
  { id: "w2", text: "hôm nay bạn thế nào", start: 5.38, end: 5.66 },
  { id: "w3", text: "tôi khỏe còn bạn", start: 5.66, end: 5.91 },
]

test("AI cue plan derives timestamps from contiguous word IDs", () => {
  const cues = materializeCuePlan(words, {
    cues: [
      { from: "w1", to: "w2", translation: "Chào bạn, hôm nay bạn thế nào?" },
      { from: "w3", to: "w3", translation: "Tôi khỏe, còn bạn?" },
    ],
  })

  assert.equal(cues.length, 2)
  assert.deepEqual(cues[0].sourceIds, ["w1", "w2"])
  assert.equal(cues[0].sourceText, "chào bạn hôm nay bạn thế nào")
  assert.ok(cues[0].start >= 5.04 && cues[0].start <= 5.05)
  assert.ok(cues[0].end <= cues[1].start)
  assert.equal(cues[1].translation, "Tôi khỏe, còn bạn?")
})

test("compact cue plan derives every start from the previous end ID", () => {
  const cues = materializeCuePlan(
    words,
    {
      cues: [
        { to: "w1", translation: "Xin chào." },
        { to: "w3", translation: "Bạn khỏe không?" },
      ],
    },
    { targetLang: "vi" },
  )
  assert.deepEqual(cues.map((cue) => cue.sourceIds), [
    ["w1"],
    ["w2", "w3"],
  ])
})

test("AI cue plan rejects skipped, repeated, and unknown word IDs", () => {
  assert.throws(
    () =>
      materializeCuePlan(words, {
        cues: [{ from: "w2", to: "w3", translation: "Sai" }],
      }),
    /skipped, repeated, or reordered/,
  )
  assert.throws(
    () =>
      materializeCuePlan(words, {
        cues: [{ from: "w1", to: "w99", translation: "Sai" }],
      }),
    /unknown word ID/,
  )
})

test("AI cue plan rejects hard silences and untranslated target text", () => {
  assert.throws(
    () =>
      materializeCuePlan(
        [
          { id: "w1", text: "你", start: 0, end: 0.2 },
          { id: "w2", text: "好", start: 2, end: 2.2 },
        ],
        {
          cues: [{ from: "w1", to: "w2", translation: "Xin chào" }],
        },
      ),
    /hard silence/,
  )
  assert.throws(
    () =>
      materializeCuePlan(
        [{ id: "w1", text: "你好", start: 0, end: 0.5 }],
        {
          cues: [{ from: "w1", to: "w1", translation: "你好" }],
        },
        { targetLang: "vi" },
      ),
    /untranslated CJK/,
  )
})

test("word normalizer accepts Groq word/text fields and sorts timestamps", () => {
  assert.deepEqual(
    normalizeCuePlanWords([
      { id: "w2", word: "好", start: 0.4, end: 0.6 },
      { id: "w1", text: "你", start: 0.1, end: 0.3 },
    ]),
    [
      { id: "w1", text: "你", start: 0.1, end: 0.3 },
      { id: "w2", text: "好", start: 0.4, end: 0.6 },
    ],
  )
})

test("client skips AI cue planning before requests above the server limit", () => {
  const word = { id: "w", text: "xin chào", start: 0, end: 0.2 }
  assert.equal(canPlanSubtitleCues(Array(MAX_CUE_PLAN_WORDS).fill(word)), true)
  assert.equal(canPlanSubtitleCues(Array(MAX_CUE_PLAN_WORDS + 1).fill(word)), false)
  assert.equal(canPlanSubtitleCues([]), false)
})
