import assert from "node:assert/strict"
import test from "node:test"
import { normalizeSpeechSegments } from "../src/server/speechApi.ts"

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

