import assert from "node:assert/strict"
import test from "node:test"

import {
  mergeGroqTranscriptions,
  planGroqAudioChunks,
  type GroqTranscription,
} from "../src/scripts/speechClient.ts"

const sampleRate = 16_000

function transcript(
  segments: GroqTranscription["segments"],
  words: GroqTranscription["words"] = [],
): GroqTranscription {
  return {
    model: "whisper-large-v3",
    language: "zh",
    segments,
    words,
  }
}

test("22-minute audio is split below Groq's 25 MiB upload limit", () => {
  const chunks = planGroqAudioChunks(
    Math.floor(1321.352993 * sampleRate),
    sampleRate,
  )

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].startSample, 0)
  assert.equal(chunks[0].endSample, 12 * 60 * sampleRate)
  assert.equal(
    chunks[1].startSample,
    chunks[0].endSample - sampleRate,
  )
  assert.equal(chunks[1].offsetSeconds, 719)
  assert.equal(chunks[1].discardBeforeSeconds, 720)
  for (const chunk of chunks) {
    const wavBytes = 44 + (chunk.endSample - chunk.startSample) * 2
    assert.ok(wavBytes < 25 * 1024 * 1024)
  }
})

test("chunk planning covers the complete sample range without gaps", () => {
  const chunks = planGroqAudioChunks(75 * 60 * sampleRate, sampleRate)

  assert.ok(chunks.length > 2)
  assert.equal(chunks[0].startSample, 0)
  assert.equal(chunks.at(-1)?.endSample, 75 * 60 * sampleRate)
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(
      chunks[index].startSample,
      chunks[index - 1].endSample - sampleRate,
    )
  }
})

test("chunk merge offsets timestamps and removes overlap duplicates", () => {
  const chunks = planGroqAudioChunks(13 * 60 * sampleRate, sampleRate)
  const merged = mergeGroqTranscriptions(
    [
      {
        chunk: chunks[0],
        transcript: transcript(
          [{ start: 719, end: 720, text: "Xin chào" }],
          [{ id: "w1", start: 719.2, end: 719.8, text: "xin" }],
        ),
      },
      {
        chunk: chunks[1],
        transcript: transcript(
          [
            { start: 0.2, end: 0.8, text: "Xin chào" },
            { start: 0.5, end: 2, text: "Xin chào" },
            { start: 2.1, end: 3, text: "Tiếp tục" },
          ],
          [
            { id: "w1", start: 0.1, end: 0.7, text: "xin" },
            { id: "w2", start: 1.2, end: 1.6, text: "chào" },
          ],
        ),
      },
    ],
    13 * 60,
  )

  assert.deepEqual(merged.segments, [
    { start: 719, end: 721, text: "Xin chào" },
    { start: 721.1, end: 722, text: "Tiếp tục" },
  ])
  assert.deepEqual(merged.words, [
    { id: "w1", start: 719.2, end: 719.8, text: "xin" },
    { id: "w2", start: 720.2, end: 720.6, text: "chào" },
  ])
  assert.equal(merged.duration, 13 * 60)
})
