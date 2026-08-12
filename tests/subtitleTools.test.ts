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
import {
  normalizeCustomBaseUrl,
  resolveProtocol as resolveLocalCustomProtocol,
} from "../scripts/localCustomTranslate.mjs"
import {
  buildAss,
  buildSubtitleFile,
  buildTxt,
  buildVtt,
  createStoredZip,
} from "../src/scripts/subtitleFormats.ts"
import { sanitizeSubtitleSourceText } from "../src/scripts/subtitleArtifacts.ts"
import {
  distributeTranslatedText,
  groupSentenceCues,
  reflowTranslatedSegments,
  splitOversizedCues,
  wrapSubtitleText,
} from "../src/scripts/subtitles.ts"
import {
  handleTranslateApi,
  parseCustomApiResponse,
  parseTranslationOutput,
  promptFor,
  resolveCustomProtocol,
} from "../src/server/translateApi.ts"

/** A real zh→vi cue: 27 Chinese characters expand to 118 Vietnamese ones. */
const LONG_VI =
  "Ngươi đừng thấy hắn tuổi còn nhỏ, khinh công và thân pháp của hắn đều là mạnh nhất trong toàn bộ môn phái của chúng ta"

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

test("overflowing text wraps into balanced lines instead of one long dump", () => {
  const lengths = wrapSubtitleText(LONG_VI, 42, 2)
    .split("\n")
    .map((line) => line.length)
  assert.equal(lengths.length, 2)
  // The old wrapper filled line 1 to the limit and dumped the remainder on line
  // 2 (39/78). Both lines must now carry a comparable share.
  const longestWord = LONG_VI.split(" ").reduce((max, word) => Math.max(max, word.length), 0)
  assert.ok(
    Math.max(...lengths) - Math.min(...lengths) <= longestWord,
    `unbalanced lines: ${JSON.stringify(lengths)}`,
  )
  assert.equal(lengths.reduce((sum, value) => sum + value, 0) + 1, LONG_VI.length)
  // Short text is never touched.
  assert.equal(wrapSubtitleText("Thật sao?", 42, 2), "Thật sao?")
})

test("splitting an oversized cue tiles the original time span exactly", () => {
  const source = { start: 4, end: 8.2, text: LONG_VI }
  const parts = splitOversizedCues([source], { targetLang: "vi" })
  assert.ok(parts.length > 1, "an over-long cue should be split")
  // The source track is the only timing authority: the outer edges must stay
  // bit-identical and the parts must cover the span without gaps or overlap.
  assert.equal(parts[0].start, source.start)
  assert.equal(parts[parts.length - 1].end, source.end)
  parts.forEach((part, index) => {
    if (index > 0) assert.equal(part.start, parts[index - 1].end)
    assert.ok(part.end - part.start >= 0.75, `part ${index} is shorter than the minimum cue`)
    assert.ok(part.text.trim(), `part ${index} is empty`)
    assert.equal(part.words, undefined)
  })
  // No text is invented or lost by the split.
  assert.equal(
    parts.map((part) => part.text.replace(/\s+/g, "")).join(""),
    LONG_VI.replace(/\s+/g, ""),
  )
})

test("cues that already fit, or are too short to divide, are left alone", () => {
  const short = [{ start: 0, end: 1.2, text: "Thật sao?" }]
  assert.deepEqual(splitOversizedCues(short, { targetLang: "vi" }), short)
  // Long text but no room for two readable cues ⇒ keep one cue.
  const cramped = [{ start: 0, end: 1.0, text: LONG_VI }]
  assert.equal(splitOversizedCues(cramped, { targetLang: "vi" }).length, 1)
})

test("sentence grouping joins continuing cues and stops at real boundaries", () => {
  const groups = groupSentenceCues([
    { start: 0, end: 1.2, text: "你别看他年纪小" },
    { start: 1.25, end: 2.4, text: "轻功和身法都是最厉害的" },
    { start: 2.45, end: 3.4, text: "真的吗？" },
    { start: 3.5, end: 4.4, text: "我不信" },
    { start: 9.0, end: 10.0, text: "后来呢" },
  ])
  // Cues 0-2 run on without sentence-ending punctuation; cue 3 starts a new
  // group because cue 2 ends with "？", and cue 4 is 4.6s later.
  assert.deepEqual(groups, [[0, 1, 2], [3], [4]])
  // Every cue appears exactly once, in order — the scatter-back depends on it.
  assert.deepEqual(groups.flat(), [0, 1, 2, 3, 4])
})

test("sentence grouping never merges across an empty cue", () => {
  assert.deepEqual(
    groupSentenceCues([
      { start: 0, end: 1, text: "你别看他" },
      { start: 1.05, end: 2, text: "" },
      { start: 2.05, end: 3, text: "年纪小" },
    ]),
    [[0], [1], [2]],
  )
})

test("a sentence translation is redistributed across the cues that carried it", () => {
  const parts = distributeTranslatedText(
    "Ngươi đừng thấy hắn tuổi còn nhỏ, khinh công và thân pháp đều là mạnh nhất",
    ["你别看他年纪小", "轻功和身法都是最厉害的"],
  )
  assert.equal(parts.length, 2)
  assert.ok(parts[0].trim() && parts[1].trim())
  // Split at the clause boundary, and no word duplicated or dropped.
  assert.ok(parts[0].endsWith(","), `expected a clause break, got ${JSON.stringify(parts[0])}`)
  assert.equal(
    `${parts[0]} ${parts[1]}`,
    "Ngươi đừng thấy hắn tuổi còn nhỏ, khinh công và thân pháp đều là mạnh nhất",
  )
  // Always exactly one entry per source cue, even when there is too little text
  // to go around.
  assert.deepEqual(distributeTranslatedText("Vâng", ["嗯", "好的"]), ["Vâng", ""])
  assert.deepEqual(distributeTranslatedText("", ["嗯", "好的"]), ["", ""])
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

test("auto protocol follows the endpoint, not the model name", () => {
  // Regression: picking "anthropic" from a claude-* model name pointed
  // Anthropic-shaped requests at OpenAI-only gateways, so every Claude model
  // failed on api.leeh.dev while GPT models worked.
  assert.equal(
    resolveCustomProtocol("auto", "https://api.leeh.dev", "claude-sonnet-4-6"),
    "openai",
  )
  assert.equal(
    resolveCustomProtocol("auto", "https://api.leeh.dev/v1", "gpt-4o-mini"),
    "openai",
  )
  // Native Anthropic still gets its own wire protocol without being asked.
  assert.equal(
    resolveCustomProtocol("auto", "https://api.anthropic.com", "claude-sonnet-4-6"),
    "anthropic",
  )
})

test("local custom translator also routes Claude IDs by gateway protocol", async () => {
  assert.equal(
    await resolveLocalCustomProtocol({
      protocol: "auto",
      baseUrl: "https://api.leeh.dev",
      apiKey: "test",
      model: "claude-opus-4-6",
    }),
    "openai",
  )
  assert.equal(
    await resolveLocalCustomProtocol({
      protocol: "auto",
      baseUrl: "https://api.anthropic.com",
      apiKey: "test",
      model: "claude-opus-4-6",
    }),
    "anthropic",
  )
})

test("per-line character budgets reach the model prompt", () => {
  const prompt = promptFor(["你好", "真的吗"], "zh", "vi", [40, 24])
  assert.match(prompt, /^1\. \(max 40\) 你好$/m)
  assert.match(prompt, /^2\. \(max 24\) 真的吗$/m)
  assert.match(prompt, /maximum characters allowed/)
  // A mismatched budget array must be ignored rather than shifted onto the
  // wrong lines.
  const unbudgeted = promptFor(["你好", "真的吗"], "zh", "vi", [40])
  assert.match(unbudgeted, /^1\. 你好$/m)
  assert.doesNotMatch(unbudgeted, /max/)
  assert.doesNotMatch(promptFor(["你好"], "zh", "vi"), /max/)
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

test("translation output parser accepts JSON arrays and preserves exact shape", () => {
  assert.deepEqual(
    parseTranslationOutput('```json\n["Xin chào", "Cảm ơn"]\n```', 2),
    {
      translations: ["Xin chào", "Cảm ơn"],
      received: 2,
      format: "json",
      exact: true,
    },
  )
  assert.deepEqual(
    parseTranslationOutput('{"translations":["Một", "Hai"]}', 2),
    {
      translations: ["Một", "Hai"],
      received: 2,
      format: "json",
      exact: true,
    },
  )
  assert.deepEqual(parseTranslationOutput("Chỉ có một dòng", 2), {
    translations: ["Chỉ có một dòng", ""],
    received: 1,
    format: "plain",
    exact: false,
  })
})

test("translation proxy retries one malformed batch before returning success", async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: requests === 1
            ? "Only one line"
            : '["Xin chào", "Cảm ơn"]',
        },
      }],
    }))
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
          model: "llama-test",
          protocol: "openai",
          source: "zh",
          target: "vi",
          texts: ["你好", "谢谢"],
        }),
      }),
      { ALLOW_PRIVATE_TRANSLATE_ENDPOINT: "1" },
    )
    const payload = await response!.json() as any
    assert.equal(response!.status, 200, JSON.stringify(payload))
    assert.equal(requests, 2)
    assert.deepEqual(payload.translations, ["Xin chào", "Cảm ơn"])
    assert.equal(payload.retries, 1)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test("translation proxy splits large requests into stable batches", async () => {
  let requests = 0
  const server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      requests += 1
      const body = JSON.parse(raw)
      const prompt = String(body.messages?.[1]?.content || "")
      const count = [...prompt.matchAll(/^\d+\. /gm)].length
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(
              Array.from({ length: count }, (_, index) => `Dịch ${index + 1}`),
            ),
          },
        }],
      }))
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
          model: "llama-test",
          protocol: "openai",
          source: "zh",
          target: "vi",
          texts: Array.from({ length: 25 }, (_, index) => `Câu ${index + 1}`),
        }),
      }),
      { ALLOW_PRIVATE_TRANSLATE_ENDPOINT: "1" },
    )
    const payload = await response!.json() as any
    assert.equal(response!.status, 200)
    assert.equal(requests, 2)
    assert.equal(payload.translations.length, 25)
    assert.equal(payload.batches, 2)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
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
      { ALLOW_PRIVATE_TRANSLATE_ENDPOINT: "1" },
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

test("anthropic requests to a gateway keep the bearer token and drop length hints", async () => {
  let headers: Record<string, string | string[] | undefined> = {}
  let requestedPath = ""
  const server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      headers = request.headers
      requestedPath = request.url || ""
      response.writeHead(200, { "Content-Type": "application/json" })
      // Echo the length marker back, the way models sometimes do.
      response.end(
        JSON.stringify({ content: [{ type: "text", text: "1. (max 40) Xin chào" }] }),
      )
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
          model: "claude-sonnet-4-6",
          protocol: "anthropic",
          source: "zh",
          target: "vi",
          texts: ["你好"],
          budgets: [40],
          strategy: "probe",
        }),
      }),
      { ALLOW_PRIVATE_TRANSLATE_ENDPOINT: "1" },
    )
    assert.ok(response)
    const payload = await response.json() as any
    assert.equal(response.status, 200)
    assert.equal(requestedPath, "/v1/messages")
    // Gateways that expose /v1/messages behind an OpenAI-style auth wall read
    // Authorization and never look at x-api-key; only native Anthropic rejects
    // a stray bearer token.
    assert.equal(headers.authorization, "Bearer test-key")
    assert.equal(headers["x-api-key"], "test-key")
    assert.deepEqual(payload.translations, ["Xin chào"])
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
      { ALLOW_PRIVATE_TRANSLATE_ENDPOINT: "1" },
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
