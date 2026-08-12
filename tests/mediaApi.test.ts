import assert from "node:assert/strict"
import test from "node:test"

import { contentDisposition } from "../src/server/httpHeaders.ts"
import {
  isPermanentYtDlpFailure,
  ytDlpErrorDetail,
} from "../src/server/ytDlp.ts"

test("content disposition safely carries a Unicode video title", () => {
  const title = "中文视频.mp4"
  const value = contentDisposition(title)

  assert.doesNotThrow(
    () => new Headers({ "Content-Disposition": value }),
  )
  assert.match(value, /^attachment; filename="____\.mp4";/)
  assert.equal(value.includes(title), false)

  const encoded = value.split("filename*=UTF-8''", 2)[1]
  assert.equal(decodeURIComponent(encoded), title)
})

test("content disposition strips header injection characters", () => {
  const value = contentDisposition("video\r\nX-Injected: yes.mp4")

  assert.equal(value.includes("\r"), false)
  assert.equal(value.includes("\n"), false)
  assert.doesNotThrow(
    () => new Headers({ "Content-Disposition": value }),
  )
})

test("yt-dlp detail keeps the extractor message and drops local paths", () => {
  const stderr = [
    "WARNING: [TikTok] something",
    "ERROR: [TikTok] 7106594312292453675: Unable to extract universal data for rehydration; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template.",
    "  File \"C:\\Tools\\yt-dlp\\yt_dlp\\extractor\\tiktok.py\", line 1234",
    "Confirm you are on the latest version using  yt-dlp -U",
  ].join("\n")

  const detail = ytDlpErrorDetail(stderr)
  assert.match(detail, /^\[TikTok\].*universal data for rehydration/)
  assert.equal(detail.includes("C:\\Tools"), false)
  assert.equal(detail.includes("please report"), false)
  assert.equal(detail.includes("Confirm you are on the latest version"), false)
  assert.ok(detail.length <= 200)
})

test("yt-dlp detail is empty when stderr carries no ERROR line", () => {
  assert.equal(ytDlpErrorDetail("WARNING: nothing serious\n"), "")
  assert.equal(ytDlpErrorDetail(""), "")
})

test("transient TikTok failures are retried, permanent ones are not", () => {
  assert.equal(
    isPermanentYtDlpFailure(
      "[TikTok] 7106594312292453675: Unable to extract universal data for rehydration",
    ),
    false,
  )
  assert.equal(
    isPermanentYtDlpFailure("Unsupported URL: https://v.douyin.com/xyz/"),
    true,
  )
  assert.equal(
    isPermanentYtDlpFailure("[YouTube] abc123: Video unavailable"),
    true,
  )
  assert.equal(isPermanentYtDlpFailure(""), false)
})
