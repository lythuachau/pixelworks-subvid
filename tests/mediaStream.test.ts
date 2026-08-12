import assert from "node:assert/strict"
import test from "node:test"

import {
  completedExpectedTransfer,
  resumedTransferTotal,
} from "../src/server/mediaStream.ts"

test("a reset after every advertised byte is treated as complete", () => {
  assert.equal(completedExpectedTransfer(19_730_453, "19730453"), true)
})

test("missing, invalid, or partial lengths never hide a stream failure", () => {
  assert.equal(completedExpectedTransfer(10, null), false)
  assert.equal(completedExpectedTransfer(10, "invalid"), false)
  assert.equal(completedExpectedTransfer(9, "10"), false)
  assert.equal(completedExpectedTransfer(11, "10"), false)
})

test("a ranged retry must continue at the exact delivered byte", () => {
  assert.equal(
    resumedTransferTotal(206, "bytes 20971520-39999999/40000000", 20_971_520),
    40_000_000,
  )
  assert.equal(
    resumedTransferTotal(206, "bytes 0-39999999/40000000", 20_971_520),
    null,
  )
  assert.equal(
    resumedTransferTotal(200, "bytes 20971520-39999999/40000000", 20_971_520),
    null,
  )
})
