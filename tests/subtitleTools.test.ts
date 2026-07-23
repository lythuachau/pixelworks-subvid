import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { analyzeSubtitleTrack } from "../src/scripts/qualityChecks.ts"
import {
  isMemoryAllocationError,
  memoryAllocationError,
} from "../src/scripts/memoryErrors.ts"
import {
  needsRepair,
  parseNumberedLines,
} from "../scripts/localGoogleTranslate.mjs"
import {
  isPermanentApiFailure,
  isSuspiciousContextTranslation,
  translateWithContextStrategy,
} from "../scripts/localContextTranslate.mjs"
import { normalizeCustomBaseUrl } from "../scripts/localCustomTranslate.mjs"
import {
  buildAss,
  buildSubtitleFile,
  buildTxt,
  buildVtt,
  createStoredZip,
} from "../src/scripts/subtitleFormats.ts"
import { sanitizeSubtitleSourceText } from "../src/scripts/subtitleArtifacts.ts"
import { reflowTranslatedSegments } from "../src/scripts/subtitles.ts"
import { isDevtoolsShortcut } from "../src/scripts/devtoolsGuard.ts"
import {
  handleTranslateApi,
  parseCustomApiResponse,
  resolveCustomProtocol,
} from "../src/server/translateApi.ts"

test("developer-tool shortcuts are blocked without affecting ordinary keys", () => {
  const shortcut = (overrides: Partial<Parameters<typeof isDevtoolsShortcut>[0]>) =>
    isDevtoolsShortcut({
      key: "",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    })

  assert.equal(shortcut({ key: "F12" }), true)
  assert.equal(shortcut({ key: "I", ctrlKey: true, shiftKey: true }), true)
  assert.equal(shortcut({ key: "j", metaKey: true, altKey: true }), true)
  assert.equal(shortcut({ key: "u", ctrlKey: true }), true)
  assert.equal(shortcut({ key: "c", ctrlKey: true }), false)
  assert.equal(shortcut({ key: "F5" }), false)
})

test("subtitle source sanitizer removes stray brackets but preserves sound cues", () => {
  assert.equal(sanitizeSubtitleSourceText("["), "")
  assert.equal(sanitizeSubtitleSourceText("[ ä½ å¥½"), "ä½ å¥½")
  assert.equal(sanitizeSubtitleSourceText("[MUSIC] ä½ å¥½"), "[MUSIC] ä½ å¥½")
  assert.equal(sanitizeSubtitleSourceText("ä½ å¥½]"), "ä½ å¥½")
})

test("reflow does not restore a sanitized artifact from the source cue", () => {
  const result = reflowTranslatedSegments(
    [{ start: 0, end: 0.5, text: "[" }],
    [{ start: 0, end: 0.5, text: "" }],
  )
  assert.equal(result[0].text, "")
})

test("quality analysis reports timing, content and readability issues", () => {
  const issues = analyzeSubtitleTrack(
    [
      { start: -1, end: 0, text: "" },
      { start: 0.5, end: 1, text: "This subtitle line is intentionally much too long for one line" },
      { start: 0.8, end: 0.7, text: "invalid" },
    ],
    "en",
  )
  const codes = new Set(issues.map((issue) => issue.code))
  assert.ok(codes.has("negative_time"))
  assert.ok(codes.has("empty_text"))
  assert.ok(codes.has("overlap"))
  assert.ok(codes.has("invalid_duration"))
  assert.ok(codes.has("high_cps"))
  assert.ok(codes.has("long_line"))
  assert.ok(codes.has("too_short"))
})

test("quality analysis catches untranslated text, internal silence and repeated boundaries", () => {
  const issues = analyzeSubtitleTrack(
    [
      {
        start: 0,
        end: 3,
        text: "Phản tác dụng",
        words: [
          { start: 0, end: 0.4, text: "Phản" },
          { start: 2.2, end: 2.8, text: "tác dụng" },
        ],
      },
      { start: 3.2, end: 5, text: "Phản tác dụng nhưng vẫn còn 轻功" },
    ],
    "vi",
  )
  const codes = new Set(issues.map((issue) => issue.code))
  assert.ok(codes.has("internal_silence"))
  assert.ok(codes.has("repeated_boundary"))
  assert.ok(codes.has("untranslated_text"))
})

test("memory allocation errors are classified and wrapped for a recoverable UI", () => {
  assert.equal(
    isMemoryAllocationError(
      "Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc",
    ),
    true,
  )
  const error = memoryAllocationError(new Error("std::bad_alloc"))
  assert.equal(error.code, "TRANSLATION_MEMORY")
  assert.match(error.message, /Close other tabs|switch to API translation/i)
})

test("Gemini translation parser keeps exact JSON cue order and repairs source copies", () => {
  assert.deepEqual(
    parseNumberedLines('["Xin chào", "Cảm ơn"]', 2),
    ["Xin chào", "Cảm ơn"],
  )
  assert.equal(needsRepair("谢谢", "谢谢", "zh", "vi"), true)
  assert.equal(needsRepair("谢谢", "Cảm ơn", "zh", "vi"), false)
})

test("translation validation rejects unrelated success responses and lost numbers", () => {
  assert.equal(needsRepair("我不想写作家了", "Cái gì vậy?", "zh", "vi"), true)
  assert.equal(needsRepair("我有2个问题", "Tôi có 2 câu hỏi", "zh", "vi"), false)
  assert.equal(needsRepair("我有2个问题", "Tôi có hai câu hỏi", "zh", "vi"), true)
  assert.equal(
    isSuspiciousContextTranslation("我不想写作家了", "Dễ thương quá!", "zh", "vi"),
    true,
  )
})

test("translation authentication failures are classified as non-retryable", () => {
  assert.equal(isPermanentApiFailure(new Error("Anthropic HTTP 401")), true)
  assert.equal(isPermanentApiFailure(new Error("invalid API key")), true)
  assert.equal(isPermanentApiFailure(new Error("HTTP 429 rate limit")), false)
  assert.equal(isPermanentApiFailure(new Error("fetch failed")), false)
})

test("custom API base URL accepts either root or official /v1 form", () => {
  assert.equal(
    normalizeCustomBaseUrl("https://api.freemodel.dev/v1/"),
    "https://api.freemodel.dev",
  )
  assert.equal(
    normalizeCustomBaseUrl("https://api.freemodel.dev"),
    "https://api.freemodel.dev",
  )
})

test("FreeModel endpoints select their documented wire protocol", () => {
  assert.equal(
    resolveCustomProtocol("openai", "https://cc.freemodel.dev", "claude-sonnet-4-6"),
    "anthropic",
  )
  assert.equal(
    resolveCustomProtocol("openai", "https://api.freemodel.dev", "gpt-5.6-terra"),
    "responses",
  )
  assert.equal(
    resolveCustomProtocol("responses", "https://example.com/v1", "gpt-test"),
    "responses",
  )
})

test("custom API parser reads Anthropic and OpenAI Responses SSE", () => {
  const anthropic = [
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"1. Xin "}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chào"}}',
    "",
  ].join("\n")
  assert.equal(
    parseCustomApiResponse(anthropic, "anthropic", "text/event-stream"),
    "1. Xin chào",
  )

  const responses = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"1. Cảm "}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"ơn"}',
    "",
    "data: [DONE]",
  ].join("\n")
  assert.equal(
    parseCustomApiResponse(responses, "responses", "text/event-stream"),
    "1. Cảm ơn",
  )
  assert.equal(
    parseCustomApiResponse(
      JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "1. Tạm biệt" }] }],
      }),
      "responses",
      "application/json",
    ),
    "1. Tạm biệt",
  )
})

test("translation proxy sends OpenAI Responses request and parses its stream", async () => {
  let requestedPath = ""
  let requestedBody: Record<string, unknown> = {}
  const server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      requestedPath = request.url || ""
      requestedBody = JSON.parse(raw)
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end([
        'data: {"type":"response.output_text.delta","delta":"1. Xin chào"}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await handleTranslateApi(
      new Request("http://subvid.local/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: "test-key",
          model: "gpt-test",
          protocol: "responses",
          source: "zh",
          target: "vi",
          texts: ["你好"],
          strategy: "probe",
        }),
      }),
      {},
    )
    assert.ok(response)
    const payload = await response.json() as any
    assert.equal(response.status, 200)
    assert.equal(requestedPath, "/v1/responses")
    assert.equal(requestedBody.stream, true)
    assert.equal(requestedBody.store, false)
    assert.deepEqual(payload.translations, ["Xin chào"])
    assert.equal(payload.engine, "custom:responses")
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test("translation proxy preserves upstream status and protocol diagnostics", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: "Account tier does not allow this request" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await handleTranslateApi(
      new Request("http://subvid.local/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: "test-key",
          model: "claude-test",
          protocol: "anthropic",
          source: "zh",
          target: "vi",
          texts: ["你好"],
          strategy: "probe",
        }),
      }),
      {},
    )
    assert.ok(response)
    const payload = await response.json() as any
    assert.equal(response.status, 403)
    assert.equal(payload.upstreamStatus, 403)
    assert.equal(payload.protocol, "anthropic")
    assert.match(payload.message, /HTTP 403/)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test("context translation stops after the first HTTP 401 response", async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(401, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: "bad key" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    await assert.rejects(
      translateWithContextStrategy(["你好"], "zh", "vi", {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "invalid",
        model: "test-model",
        protocol: "openai",
      }),
      /HTTP 401.*bad key/i,
    )
    assert.equal(requests, 1)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test("context translation falls back through the user-selected model order", async () => {
  const requestedModels: string[] = []
  const server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      const body = JSON.parse(raw)
      requestedModels.push(body.model)
      response.setHeader("Content-Type", "application/json")
      if (body.model === "primary-model") {
        response.writeHead(503)
        response.end(JSON.stringify({ error: { message: "temporarily unavailable" } }))
        return
      }
      response.writeHead(200)
      response.end(JSON.stringify({
        choices: [{ message: { content: '{"cues":[{"i":0,"text":"Xin chào"}]}' } }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const result = await translateWithContextStrategy(["你好"], "zh", "vi", {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "primary-model",
      models: ["primary-model", "fallback-model"],
      protocol: "openai",
    })
    assert.deepEqual(result.translations, ["Xin chào"])
    assert.deepEqual(requestedModels, ["primary-model", "fallback-model"])
    assert.equal(result.model, "fallback-model")
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test("subtitle formatters include timing and speaker data", () => {
  const segments = [
    { start: 1.25, end: 3.5, text: "Xin chào", speaker: "SPEAKER_00" },
  ]
  assert.match(buildSubtitleFile(segments, "srt"), /\[SPEAKER_00\] Xin chào/)
  assert.match(buildVtt(segments), /^WEBVTT/)
  assert.match(buildVtt(segments), /00:00:01\.250 --> 00:00:03\.500/)
  assert.match(buildAss(segments), /Dialogue: 0,0:00:01\.25,0:00:03\.50,Default,SPEAKER_00/)
  assert.match(buildTxt(segments), /\[00:01\.250\] \[SPEAKER_00\] Xin chào/)
})

test("all-track exporter creates a valid stored ZIP container", async () => {
  const blob = createStoredZip([
    { name: "clip.zh.srt", content: "source" },
    { name: "clip.vi.vtt", content: "target" },
  ])
  const bytes = new Uint8Array(await blob.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.ok(bytes.length > 100)
})
