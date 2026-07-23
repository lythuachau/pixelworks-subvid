/**
 * Custom OpenAI / Anthropic-compatible translation backends.
 * Used for gateways like https://api.freemodel.dev (OpenAI-compatible API).
 *
 * Env defaults:
 *   CUSTOM_TRANSLATE_BASE_URL
 *   CUSTOM_TRANSLATE_API_KEY
 *   CUSTOM_TRANSLATE_MODEL
 *   CUSTOM_TRANSLATE_PROTOCOL=auto|anthropic|openai
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Cues per API call — larger = fewer round-trips (quality still OK for captions). */
function batchSize() {
  const n = Number(envAll().CUSTOM_TRANSLATE_BATCH_SIZE || 40);
  return Number.isFinite(n) && n > 0 ? Math.min(80, Math.floor(n)) : 40;
}

/** Parallel in-flight API calls. */
function concurrency() {
  const n = Number(envAll().CUSTOM_TRANSLATE_CONCURRENCY || 4);
  return Number.isFinite(n) && n > 0 ? Math.min(8, Math.floor(n)) : 4;
}

function loadDotEnvFile() {
  const filePath = resolve(process.cwd(), ".env");
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(filePath)) return out;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envAll() {
  return { ...loadDotEnvFile(), ...process.env };
}

export function normalizeCustomBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
}

export function getCustomTranslateDefaults() {
  const env = envAll();
  return {
    baseUrl: normalizeCustomBaseUrl(
      env.CUSTOM_TRANSLATE_BASE_URL ||
      env.OPENAI_BASE_URL ||
      "",
    ),
    apiKey: (
      env.CUSTOM_TRANSLATE_API_KEY ||
      env.OPENAI_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      ""
    ).trim(),
    model: (env.CUSTOM_TRANSLATE_MODEL || "").trim(),
    models: String(env.CUSTOM_TRANSLATE_MODELS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    protocol: (
      env.CUSTOM_TRANSLATE_PROTOCOL ||
      "auto"
    )
      .trim()
      .toLowerCase(),
  };
}

export function isCustomTranslateConfigured() {
  const d = getCustomTranslateDefaults();
  return !!(d.baseUrl && d.apiKey);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function langLabel(code) {
  const c = String(code || "")
    .toLowerCase()
    .slice(0, 2);
  const map = {
    zh: "Chinese (Simplified)",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    pt: "Portuguese",
    it: "Italian",
    nl: "Dutch",
    ru: "Russian",
    ja: "Japanese",
    ko: "Korean",
    vi: "Vietnamese",
    ar: "Arabic",
    hi: "Hindi",
    pl: "Polish",
    tr: "Turkish",
  };
  return map[c] || code || "Unknown";
}

function buildPrompt(texts, sourceLang, targetLang, glossary = []) {
  const src = langLabel(sourceLang);
  const tgt = langLabel(targetLang);
  const lines = texts
    .map((t, i) => `${i + 1}. ${String(t ?? "").replace(/\r?\n/g, " ").trim()}`)
    .join("\n");
  return [
    `You are a professional subtitle translator for short-form video.`,
    `Translate from ${src} to natural spoken ${tgt}.`,
    `Rules:`,
    `- Preserve meaning, tone, and informal speech when present.`,
    `- Keep each cue short enough for on-screen captions.`,
    `- Output EXACTLY ${texts.length} lines in the same order.`,
    `- Each line format: N. translated text  (N starts at 1).`,
    `- Do not merge or split cues. Do not add commentary, quotes, or blank lines.`,
    `- Keep [SOUND] markers like [MUSIC] if present; translate the label when obvious.`,
    glossary.length
      ? `- Required glossary (use consistently):\n${glossary.map((term) => `  - ${term}`).join("\n")}`
      : "",
    ``,
    `Source cues:`,
    lines,
  ].join("\n");
}

function parseNumberedLines(raw, expected) {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim();
  /** @type {Map<number, string>} */
  const byIndex = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[.、:)\-]\s*(.*)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx) || idx < 1) continue;
    byIndex.set(idx, m[2].trim());
  }
  if (byIndex.size >= Math.ceil(expected * 0.8)) {
    const out = [];
    for (let i = 1; i <= expected; i += 1) out.push(byIndex.get(i) ?? "");
    return out;
  }
  const plain = text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*[.、:)\-]\s*/, "").trim())
    .filter(Boolean);
  if (plain.length === expected) return plain;
  if (plain.length > expected) return plain.slice(0, expected);
  while (plain.length < expected) plain.push("");
  return plain;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ baseUrl: string, apiKey: string, protocol?: string }} cfg
 */
export async function listCustomModels(cfg) {
  const baseUrl = normalizeCustomBaseUrl(cfg.baseUrl);
  const res = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "x-api-key": cfg.apiKey,
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        `List models HTTP ${res.status}`,
    );
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((m) => ({
    id: m.id || m.name,
    owned_by: m.owned_by || "",
    supported_endpoint_types: m.supported_endpoint_types || [],
  })).filter((m) => m.id);
}

/**
 * Detect protocol from models list or explicit config.
 * @param {{ baseUrl: string, apiKey: string, protocol?: string, model?: string }} cfg
 */
export async function resolveProtocol(cfg) {
  const explicit = (cfg.protocol || "auto").toLowerCase();
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  try {
    const models = await listCustomModels(cfg);
    const match = cfg.model
      ? models.find((m) => m.id === cfg.model)
      : models[0];
    const types = match?.supported_endpoint_types || [];
    if (types.includes("anthropic")) return "anthropic";
    if (types.includes("openai") || types.includes("openai-chat"))
      return "openai";
    // Older FreeModel deployments reported provider ownership instead of
    // endpoint types; keep this compatibility fallback for Anthropic-owned IDs.
    if (match?.owned_by === "anthropic") return "anthropic";
  } catch {
    /* fall through */
  }
  // Heuristic: many Claude gateways only support Anthropic messages.
  if (/claude/i.test(cfg.model || "")) return "anthropic";
  return "openai";
}

async function callAnthropic(cfg, model, prompt) {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 60_000),
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        // Do not send temperature — some Claude models reject it.
        system:
          "You are a professional subtitle translator. Follow the user instructions exactly.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Translation request timeout after ${cfg.requestTimeoutMs || 60_000}ms`);
    }
    throw error;
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.message || res.statusText;
    throw new Error(
      `Anthropic HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const blocks = payload?.content;
  const text = Array.isArray(blocks)
    ? blocks.map((b) => (b?.type === "text" ? b.text : "")).join("")
    : "";
  if (!text.trim()) throw new Error("Anthropic returned empty translation");
  return text;
}

async function callOpenAI(cfg, model, prompt) {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 60_000),
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          {
            role: "system",
            content:
              "You are a professional subtitle translator. Follow the user instructions exactly.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Translation request timeout after ${cfg.requestTimeoutMs || 60_000}ms`);
    }
    throw error;
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.message || res.statusText;
    throw new Error(
      `OpenAI-compatible HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const text = payload?.choices?.[0]?.message?.content || "";
  if (!String(text).trim())
    throw new Error("OpenAI-compatible API returned empty translation");
  return String(text);
}

/**
 * @param {string[]} texts
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {{ baseUrl: string, apiKey: string, model: string, protocol?: string }} cfg
 */
async function translateOneBatch(cfg, model, protocol, batch, batchNumber, totalBatches, sourceLang, targetLang) {
  console.info(
    `[custom-translate] batch ${batchNumber}/${totalBatches} protocol=${protocol} model=${model} ${sourceLang}→${targetLang} n=${batch.length}`,
  );
  const prompt = buildPrompt(batch, sourceLang, targetLang, cfg.glossary || []);
  let raw = "";
  let attempt = 0;
  while (attempt < (cfg.probe ? 1 : 3)) {
    attempt += 1;
    try {
      raw =
        protocol === "anthropic"
          ? await callAnthropic(cfg, model, prompt)
          : await callOpenAI(cfg, model, prompt);
      break;
    } catch (error) {
      const msg = String(error?.message || error);
      if (!cfg.probe && attempt < 3 && /rate|429|overload|unavailable|timeout/i.test(msg)) {
        console.warn(
          `[custom-translate] retry ${attempt} after error: ${msg}`,
        );
        await sleep(attempt * 800);
        continue;
      }
      throw error;
    }
  }
  return parseNumberedLines(raw, batch.length).map(
    (line, j) => (line || "").trim() || batch[j],
  );
}

/**
 * Run async tasks with a fixed concurrency pool.
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function mapPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function translateWithCustom(texts, sourceLang, targetLang, cfg) {
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new Error("Custom translate requires baseUrl and apiKey");
  }
  const defaults = getCustomTranslateDefaults();
  const selectedModels = [
    ...new Set(
      (Array.isArray(cfg.models) && cfg.models.length
        ? cfg.models
        : defaults.models
      ).map(String).map((item) => item.trim()).filter(Boolean),
    ),
  ];
  const model = cfg.model || selectedModels[0] || defaults.model;
  if (!model) throw new Error("Custom translate requires a model id");
  if (!selectedModels.includes(model)) selectedModels.unshift(model);

  const env = { ...loadDotEnvFile(), ...process.env };
  const strategy = String(
    cfg.strategy || env.CUSTOM_TRANSLATE_STRATEGY || "context",
  )
    .trim()
    .toLowerCase();
  const probe = strategy === "probe";
  const requestTimeoutMs = Math.min(
    180_000,
    Math.max(
      probe ? 8_000 : 15_000,
      Number(env.CUSTOM_TRANSLATE_REQUEST_TIMEOUT_MS) || (probe ? 12_000 : 60_000),
    ),
  );
  const protocol = await resolveProtocol({ ...cfg, model });

  // Default: windowed full-context + validate N + retry missing indices.
  // Set CUSTOM_TRANSLATE_STRATEGY=simple for old line-batch behavior.
  if (strategy !== "simple" && strategy !== "probe" && texts.length > 0) {
    const { translateWithContextStrategy } = await import(
      "./localContextTranslate.mjs"
    );
    const result = await translateWithContextStrategy(
      texts,
      sourceLang,
      targetLang,
      { ...cfg, model, models: selectedModels, protocol, requestTimeoutMs },
    );
    return result;
  }

  const size = batchSize();
  const parallel = concurrency();
  const started = Date.now();

  /** @type {Array<{ start: number, batch: string[], batchNumber: number }>} */
  const jobs = [];
  const totalBatches = Math.max(1, Math.ceil(texts.length / size));
  for (let i = 0; i < texts.length; i += size) {
    jobs.push({
      start: i,
      batch: texts.slice(i, i + size),
      batchNumber: Math.floor(i / size) + 1,
    });
  }

  console.info(
    `[custom-translate] start cues=${texts.length} batches=${totalBatches} batchSize=${size} concurrency=${parallel} model=${model}`,
  );

  const batchResults = await mapPool(
    jobs.map(
      (job) => () =>
        translateOneBatch(
          { ...cfg, requestTimeoutMs, probe },
          model,
          protocol,
          job.batch,
          job.batchNumber,
          totalBatches,
          sourceLang,
          targetLang,
        ),
    ),
    parallel,
  );

  const outputs = new Array(texts.length);
  for (let j = 0; j < jobs.length; j += 1) {
    const { start, batch } = jobs[j];
    const lines = batchResults[j];
    for (let k = 0; k < batch.length; k += 1) {
      outputs[start + k] = lines[k];
    }
  }

  console.info(
    `[custom-translate] done model=${model} protocol=${protocol} ${sourceLang}→${targetLang} cues=${texts.length} elapsed=${Date.now() - started}ms`,
  );
  return {
    translations: outputs,
    model,
    protocol,
    strategy: "simple-batch",
  };
}

function resolveCfgFromBody(body = {}) {
  const defaults = getCustomTranslateDefaults();
  const fileEnv = loadDotEnvFile();
  return {
    baseUrl: normalizeCustomBaseUrl(
      body.baseUrl || body.endpoint || defaults.baseUrl || "",
    ),
    apiKey: String(body.apiKey || body.key || defaults.apiKey || "").trim(),
    model: String(
      body.model ||
        (Array.isArray(body.models) ? body.models[0] : "") ||
        defaults.model ||
        "",
    ).trim(),
    models: [
      ...new Set(
        (Array.isArray(body.models) ? body.models : defaults.models || [])
          .map(String)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ],
    protocol: String(body.protocol || defaults.protocol || "auto")
      .trim()
      .toLowerCase(),
    strategy: String(
      body.strategy ||
        process.env.CUSTOM_TRANSLATE_STRATEGY ||
        fileEnv.CUSTOM_TRANSLATE_STRATEGY ||
        "context",
    )
      .trim()
      .toLowerCase(),
    glossary: Array.isArray(body.glossary)
      ? body.glossary.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
  };
}

export async function handleCustomTranslateStatus() {
  const d = getCustomTranslateDefaults();
  return json({
    ok: !!(d.baseUrl && d.apiKey),
    engine: "custom",
    configured: !!(d.baseUrl && d.apiKey),
    baseUrl: d.baseUrl || "",
    model: d.model || "",
    models: d.models || [],
    protocol: d.protocol || "auto",
    // Never return the raw key; only whether it is set.
    hasApiKey: !!d.apiKey,
    strategy: "context",
    message: d.baseUrl && d.apiKey
      ? `Custom translate ready (${d.baseUrl}) · context windows + validate/retry`
      : "Set CUSTOM_TRANSLATE_BASE_URL + CUSTOM_TRANSLATE_API_KEY in .env or UI",
  });
}

export async function handleCustomTranslateModels(request) {
  const url = new URL(request.url);
  let body = {};
  if ((request.method || "GET").toUpperCase() === "POST") {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }
  const cfg = {
    baseUrl: normalizeCustomBaseUrl(
      body.baseUrl ||
        body.endpoint ||
        url.searchParams.get("baseUrl") ||
        url.searchParams.get("endpoint") ||
        getCustomTranslateDefaults().baseUrl ||
        "",
    ),
    apiKey: String(
      body.apiKey ||
        body.key ||
        url.searchParams.get("apiKey") ||
        getCustomTranslateDefaults().apiKey ||
        "",
    ).trim(),
  };
  if (!cfg.baseUrl || !cfg.apiKey) {
    return json(
      {
        ok: false,
        error: "not_configured",
        message: "baseUrl and apiKey required to list models",
      },
      400,
    );
  }
  try {
    const models = await listCustomModels(cfg);
    return json({ ok: true, models });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "list_failed",
        message: String(error?.message || error),
      },
      500,
    );
  }
}

export async function handleCustomTranslate(request) {
  if ((request.method || "GET").toUpperCase() !== "POST") {
    return json({ ok: false, error: "method", message: "POST required" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: "bad_json", message: "Invalid JSON body" },
      400,
    );
  }

  const cfg = resolveCfgFromBody(body);
  if (!cfg.baseUrl || !cfg.apiKey) {
    return json(
      {
        ok: false,
        error: "not_configured",
        message: "Custom endpoint and API key are required",
      },
      503,
    );
  }
  if (!cfg.model) {
    return json(
      {
        ok: false,
        error: "missing_model",
        message: "Select a model id (e.g. claude-sonnet-4-6)",
      },
      400,
    );
  }

  const texts = Array.isArray(body?.texts)
    ? body.texts.map((t) => String(t ?? ""))
    : [];
  const sourceLang = String(body?.source || body?.sourceLang || "").trim();
  const targetLang = String(body?.target || body?.targetLang || "").trim();

  if (!texts.length) {
    return json({
      ok: true,
      translations: [],
      engine: "custom",
      model: cfg.model,
    });
  }
  if (!sourceLang || !targetLang) {
    return json(
      {
        ok: false,
        error: "missing_langs",
        message: "source and target language codes are required",
      },
      400,
    );
  }
  if (sourceLang === targetLang) {
    return json({
      ok: true,
      translations: texts,
      engine: "custom",
      model: cfg.model,
    });
  }

  try {
    const result = await translateWithCustom(
      texts,
      sourceLang,
      targetLang,
      cfg,
    );
    return json({
      ok: true,
      engine: "custom",
      model: result.model,
      protocol: result.protocol,
      strategy: result.strategy || cfg.strategy || "context",
      source: sourceLang,
      target: targetLang,
      translations: result.translations,
      missingFinal: result.missingFinal || [],
      windows: result.windows,
      glossaryTerms: result.glossaryTerms,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    console.error("[custom-translate]", error);
    return json(
      {
        ok: false,
        error: "translate_failed",
        message: String(error?.message || error),
      },
      500,
    );
  }
}
