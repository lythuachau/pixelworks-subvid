/**
 * Full-context subtitle translation with:
 *  - glossary pass (optional, short)
 *  - windows of N cues (default 100)
 *  - validate every index is filled
 *  - retry only missing indices (continuation)
 *
 * How we know something is missing:
 *  1. Build expected index set [0..total-1] or [windowStart..windowEnd)
 *  2. Parse agent output into Map<index, text>
 *  3. missing = expected.filter(i => !map[i] || blank)
 *  4. If missing.length > 0 → retry request with only those indices
 *  5. After retries, leftover still missing → keep source text (or empty) and log
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnvFile() {
  const filePath = resolve(process.cwd(), ".env");
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(filePath)) return out;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
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

function numEnv(name, fallback, min, max) {
  const n = Number(envAll()[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function contextTranslateConfig() {
  return {
    // Smaller windows = more reliable JSON + fewer gateway 403s
    windowSize: numEnv("CUSTOM_TRANSLATE_WINDOW_SIZE", 80, 20, 200),
    // freemodel/Cloudflare often 403s under parallel load — default sequential
    concurrency: numEnv("CUSTOM_TRANSLATE_CONCURRENCY", 1, 1, 6),
    maxRetries: numEnv("CUSTOM_TRANSLATE_MAX_RETRIES", 2, 0, 8),
    contextPrev: numEnv("CUSTOM_TRANSLATE_CONTEXT_PREV", 6, 0, 20),
    maxTokens: numEnv("CUSTOM_TRANSLATE_MAX_TOKENS", 8192, 1024, 32000),
    requestTimeoutMs: numEnv(
      "CUSTOM_TRANSLATE_REQUEST_TIMEOUT_MS",
      30_000,
      15_000,
      120_000,
    ),
    maxElapsedMs: numEnv(
      "CUSTOM_TRANSLATE_MAX_ELAPSED_MS",
      180_000,
      30_000,
      600_000,
    ),
    // Fail the job (don't return Chinese source as "translation") if more than this % missing
    maxMissingRatio: Number(envAll().CUSTOM_TRANSLATE_MAX_MISSING_RATIO || 0.05),
  };
}

const FALLBACK_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
];

function langLabel(code) {
  const c = String(code || "")
    .toLowerCase()
    .slice(0, 2);
  const map = {
    zh: "Chinese",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    vi: "Vietnamese",
    ja: "Japanese",
    ko: "Korean",
    ru: "Russian",
  };
  return map[c] || code || "Unknown";
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Authentication/configuration errors cannot be fixed by retries or model fallback. */
export function isPermanentApiFailure(error) {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (?:api[ -]?key|x-api-key)|authentication failed|permission denied)/i.test(
    String(error?.message || error || ""),
  );
}

function normalizedTranslationText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

const GENERIC_TRANSLATION_RE = /^(?:cai gi(?: day| vay)?|de thuong qua|trong giong (?:meo|cho) qua|con (?:meo|cho)|gioi qua|nho qua|what(?: is this| is that)|so cute|looks like (?:a )?(?:cat|dog)|good job|wow|haha)[!?.,\s]*$/u;

/** Reject plausible-looking HTTP-200 output that is clearly unrelated to the cue. */
export function isSuspiciousContextTranslation(
  source,
  translated,
  sourceLang,
  targetLang,
) {
  const src = String(source || "").trim();
  const dst = String(translated || "").trim();
  if (!src || !dst || sourceLang === targetLang) return false;
  if (GENERIC_TRANSLATION_RE.test(normalizedTranslationText(dst)) && src.length >= 4) {
    return true;
  }
  const sourceNumbers = src.match(/\d+(?:[.,]\d+)?/g) || [];
  return sourceNumbers.some((number) => !dst.includes(number));
}

/**
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 */
async function mapPool(tasks, limit) {
  /** @type {T[]} */
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(1, tasks.length)) }, () =>
      worker(),
    ),
  );
  return results;
}

// ─── Parse agent output into Map<index, text> ───────────────────────────────

/**
 * Extract a JSON array/object of cues from free-form agent text / tool_use dumps.
 * @param {string} raw
 * @returns {any[]}
 */
export function extractCueItems(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];

  // 1) Direct JSON
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.cues)) return data.cues;
    if (Array.isArray(data?.translations)) return data.translations;
    // tool_use style: { content: "{ \"cues\": [...] }" }
    if (typeof data?.content === "string") {
      try {
        const inner = JSON.parse(data.content);
        if (Array.isArray(inner)) return inner;
        if (Array.isArray(inner?.cues)) return inner.cues;
      } catch {
        /* continue */
      }
    }
  } catch {
    /* continue */
  }

  // 2) tool_use dump containing "content": "{...cues...}"
  const contentMatch = text.match(
    /"content"\s*:\s*"((?:\\.|[^"\\])*)"/s,
  );
  if (contentMatch) {
    try {
      const unescaped = JSON.parse(`"${contentMatch[1]}"`);
      const inner = JSON.parse(unescaped);
      if (Array.isArray(inner?.cues)) return inner.cues;
      if (Array.isArray(inner)) return inner;
    } catch {
      /* continue */
    }
  }

  // 3) Largest {...} or [...] block containing "cues" or "i"
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    const slice = text.slice(braceStart, braceEnd + 1);
    try {
      const data = JSON.parse(slice);
      if (Array.isArray(data?.cues)) return data.cues;
      if (Array.isArray(data)) return data;
    } catch {
      /* continue */
    }
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const data = JSON.parse(text.slice(arrStart, arrEnd + 1));
      if (Array.isArray(data)) return data;
    } catch {
      /* continue */
    }
  }

  // 4) Numbered lines: "12. text" or "12|text" (absolute index)
  /** @type {Array<{i:number,text:string}>} */
  const numbered = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[.、:|)\-]\s*(.*)$/);
    if (!m) continue;
    numbered.push({ i: Number(m[1]), text: m[2].trim() });
  }
  return numbered;
}

/**
 * Normalize parsed items into Map of absolute index → text.
 *
 * Detection order (pick ONE mapping mode — avoids filling holes with wrong rows):
 *  1. Absolute indices already in [indexMin, indexMax)
 *  2. Window-local 0-based [0, expected)
 *  3. Window-local 1-based [1, expected]
 *  4. Positional ordered strings
 *
 * @param {any[]} items
 * @param {{ indexMin: number, indexMax: number }} range inclusive min, exclusive max
 * @returns {Map<number, string>}
 */
export function itemsToIndexMap(items, range) {
  /** @type {Map<number, string>} */
  const map = new Map();
  const { indexMin, indexMax } = range;
  const expected = indexMax - indexMin;

  /** @type {string[]} */
  const ordered = [];
  /** @type {Array<{ idx: number, text: string }>} */
  const pairs = [];

  for (const item of items) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) ordered.push(t);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const text = String(
      item.text ?? item.vi ?? item.translation ?? item.t ?? "",
    ).trim();
    let idx = item.i ?? item.index ?? item.id;
    if (idx != null && idx !== "" && Number.isFinite(Number(idx))) {
      pairs.push({ idx: Number(idx), text });
    } else if (text) {
      ordered.push(text);
    }
  }

  if (pairs.length) {
    const inAbsolute = pairs.filter(
      (p) => p.idx >= indexMin && p.idx < indexMax && p.text,
    );
    const local0 = pairs.filter(
      (p) => p.idx >= 0 && p.idx < expected && p.text,
    );
    const local1 = pairs.filter(
      (p) => p.idx >= 1 && p.idx <= expected && p.text,
    );
    const hasZero = pairs.some((p) => p.idx === 0);

    // Prefer absolute when enough hits land in the real range.
    if (inAbsolute.length >= Math.ceil(Math.min(pairs.length, expected) * 0.6)) {
      for (const p of inAbsolute) map.set(p.idx, p.text);
    } else if (
      local1.length >= Math.ceil(expected * 0.6) &&
      !hasZero &&
      indexMin > 0
    ) {
      // 1-based local only when window is not starting at 0 (avoids 0..N absolute clash)
      for (const p of local1) map.set(indexMin + p.idx - 1, p.text);
    } else if (local0.length >= Math.ceil(expected * 0.6)) {
      for (const p of local0) map.set(indexMin + p.idx, p.text);
    } else if (inAbsolute.length) {
      for (const p of inAbsolute) map.set(p.idx, p.text);
    } else if (local0.length) {
      for (const p of local0) map.set(indexMin + p.idx, p.text);
    } else if (local1.length) {
      for (const p of local1) map.set(indexMin + p.idx - 1, p.text);
    }
  }

  // Positional fallback when indices are missing/unreliable
  if (
    ordered.length >= Math.ceil(expected * 0.9) &&
    findMissingIndices(indexMin, indexMax, map).length > expected * 0.2
  ) {
    for (let j = 0; j < expected; j += 1) {
      const abs = indexMin + j;
      if (!map.get(abs) && ordered[j]) map.set(abs, ordered[j]);
    }
  }

  return map;
}

/**
 * @param {number} indexMin inclusive
 * @param {number} indexMax exclusive
 * @param {Map<number, string>} map
 * @returns {number[]}
 */
export function findMissingIndices(indexMin, indexMax, map) {
  /** @type {number[]} */
  const missing = [];
  for (let i = indexMin; i < indexMax; i += 1) {
    const t = map.get(i);
    if (!t || !String(t).trim()) missing.push(i);
  }
  return missing;
}

// ─── API calls ──────────────────────────────────────────────────────────────

/**
 * @param {{ baseUrl: string, apiKey: string, model: string, models?: string[], protocol: string }} cfg
 * @param {string} system
 * @param {string} user
 * @param {number} maxTokens
 */
async function callModel(cfg, system, user, maxTokens) {
  const protocol = cfg.protocol === "openai" ? "openai" : "anthropic";
  const selectedModels = Array.isArray(cfg.models)
    ? cfg.models.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  const modelsTry = [
    ...new Set(
      selectedModels.length
        ? [cfg.model, ...selectedModels]
        : [cfg.model, ...FALLBACK_MODELS],
    ),
  ];
  let lastError = null;
  for (let modelIndex = 0; modelIndex < modelsTry.length; modelIndex += 1) {
    const model = modelsTry[modelIndex];
    try {
      const next = { ...cfg, model };
      const result =
        protocol === "anthropic"
          ? await callAnthropic(next, system, user, maxTokens)
          : await callOpenAI(next, system, user, maxTokens);
      if (model !== cfg.model) {
        console.warn(
          `[context-translate] model fallback ${cfg.model} → ${model}`,
        );
        cfg.model = model; // prefer working model for later windows
      }
      return result;
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || error);
      if (isPermanentApiFailure(error)) throw error;
      // Try the next user-selected model for transient/provider-specific errors.
      if (
        modelIndex < modelsTry.length - 1 &&
        /timeout|305|429|rate|overload|fetch failed|5\d\d|unavailable/i.test(msg)
      ) {
        console.warn(
          `[context-translate] ${model} failed (${msg.slice(0, 120)}); trying next model`,
        );
        await sleep(600);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("All translation models failed");
}

async function callAnthropic(cfg, system, user, maxTokens) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 60_000),
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": "subvid-context-translate/1.0",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
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
  return extractTextFromAnthropicPayload(payload);
}

function extractTextFromAnthropicPayload(payload) {
  const parts = payload?.content || [];
  /** @type {string[]} */
  const chunks = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && p.text) chunks.push(String(p.text));
    if (p.type === "tool_use" && p.input) {
      if (typeof p.input === "string") chunks.push(p.input);
      else if (typeof p.input?.content === "string") chunks.push(p.input.content);
      else chunks.push(JSON.stringify(p.input));
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Empty model response");
  return {
    text,
    stop: payload?.stop_reason || null,
    usage: payload?.usage || {},
  };
}

async function callOpenAI(cfg, system, user, maxTokens) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 60_000),
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
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
      `OpenAI HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const text = payload?.choices?.[0]?.message?.content || "";
  if (!String(text).trim()) throw new Error("Empty model response");
  return { text: String(text), stop: null, usage: payload?.usage || {} };
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function systemPrompt() {
  return (
    "You are a professional short-form video subtitle translator. " +
    "Return ONLY valid JSON. Never omit required cue indices. " +
    "Do not use tools or write files — put the full JSON in your message text."
  );
}

function glossaryPrompt(texts, sourceLang, targetLang) {
  const sample = texts
    .filter(Boolean)
    .slice(0, 80)
    .map((t, i) => `${i}. ${String(t).replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return `Extract a compact translation glossary for subtitle work.

Source language: ${langLabel(sourceLang)}
Target language: ${langLabel(targetLang)}

From the sample transcript below, list:
- character / place names (keep consistent)
- recurring terms / slang
- preferred ${langLabel(targetLang)} renderings

Return ONLY JSON:
{"glossary":["source => target", "..."],"notes":"one short paragraph about tone"}

Sample cues:
${sample}`;
}

function mergeGlossaryTerms(primary, additions) {
  const output = [];
  const seen = new Set();
  for (const raw of [...(primary || []), ...(additions || [])]) {
    const term = String(raw || "").trim();
    if (!term) continue;
    const source = term.split(/\s*(?:=>|→|:)\s*/u, 1)[0]
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "");
    const key = source || term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(term);
  }
  return output;
}

function windowPrompt({
  texts,
  sourceLang,
  targetLang,
  indexMin,
  indexMax,
  glossary,
  prevLines,
  onlyIndices,
}) {
  const tgt = langLabel(targetLang);
  const src = langLabel(sourceLang);
  /** @type {number[]} */
  const indices =
    onlyIndices && onlyIndices.length
      ? onlyIndices
      : Array.from({ length: indexMax - indexMin }, (_, k) => indexMin + k);

  const lines = indices
    .map((i) => {
      const t = String(texts[i] ?? "")
        .replace(/\r?\n/g, " ")
        .trim();
      return `${i}|${t}`;
    })
    .join("\n");

  const prev =
    prevLines && prevLines.length
      ? `Previous cues (context only — do NOT re-translate):\n${prevLines.join("\n")}\n\n`
      : "";

  const gloss =
    glossary && glossary.length
      ? `Glossary (keep consistent):\n${glossary.map((g) => `- ${g}`).join("\n")}\n\n`
      : "";

  return `Translate subtitle cues from ${src} to natural spoken ${tgt} for Douyin/TikTok.

${gloss}${prev}CRITICAL:
1. Translate ONLY these absolute indices: [${indices[0]}..${indices[indices.length - 1]}] (${indices.length} cues).
2. Output EXACTLY ${indices.length} objects — one per index listed.
3. Do not merge/split/skip/reorder.
4. Keep informal narration tone; fix obvious ASR typos using surrounding context.
5. For Chinese fantasy / historical dialogue, use established Vietnamese terms
   (for example: 轻功 = khinh công, 身法 = thân pháp). Never invent unrelated meaning.
6. Timeline is fixed elsewhere — only return text.
7. Glossary entries supplied above have priority over your own terminology. If a
   source cue contains the left side, use the exact target term on the right side.

Return ONLY JSON (no markdown):
{"cues":[{"i":${indices[0]},"text":"..."},{"i":${indices[Math.min(1, indices.length - 1)]},"text":"..."}]}

Cues (index|text):
${lines}`;
}

// ─── Core strategy ──────────────────────────────────────────────────────────

/**
 * Translate all texts with windowed full-context + validate + retry missing.
 *
 * @param {string[]} texts
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {{ baseUrl: string, apiKey: string, model: string, models?: string[], protocol?: string }} cfg
 */
export async function translateWithContextStrategy(
  texts,
  sourceLang,
  targetLang,
  cfg,
) {
  const conf = contextTranslateConfig();
  const protocol =
    (cfg.protocol || "auto").toLowerCase() === "openai"
      ? "openai"
      : "anthropic";
  const modelCfg = {
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    apiKey: cfg.apiKey,
    model: cfg.model,
    models: Array.isArray(cfg.models) ? cfg.models : [],
    protocol,
    requestTimeoutMs: conf.requestTimeoutMs,
  };

  const total = texts.length;
  /** @type {string[]} */
  const out = new Array(total).fill("");
  /** @type {string[]} */
  let glossary = Array.isArray(cfg.glossary)
    ? cfg.glossary.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  const started = Date.now();
  let terminalTimeout = false;
  const budgetExceeded = () => Date.now() - started >= conf.maxElapsedMs;

  console.info(
    `[context-translate] start cues=${total} window=${conf.windowSize} concurrency=${conf.concurrency} retries=${conf.maxRetries} model=${cfg.model}`,
  );

  // Glossary pass (cheap, improves name consistency across windows)
  if (total >= 30 || texts.join("").length >= 360) {
    try {
      const g = await callModel(
        modelCfg,
        systemPrompt(),
        glossaryPrompt(texts, sourceLang, targetLang),
        1024,
      );
      const items = extractCueItems(g.text);
      // items may be wrong shape; try parse glossary from raw
      try {
        const data = JSON.parse(g.text);
        if (Array.isArray(data?.glossary))
          glossary = mergeGlossaryTerms(glossary, data.glossary.map(String));
      } catch {
        const m = g.text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const data = JSON.parse(m[0]);
            if (Array.isArray(data?.glossary))
              glossary = mergeGlossaryTerms(glossary, data.glossary.map(String));
          } catch {
            /* ignore */
          }
        }
      }
      console.info(
        `[context-translate] glossary terms=${glossary.length}`,
      );
    } catch (error) {
      if (isPermanentApiFailure(error)) throw error;
      console.warn(
        `[context-translate] glossary skipped: ${error?.message || error}`,
      );
    }
  }

  // Build windows
  /** @type {Array<{ indexMin: number, indexMax: number }>} */
  const windows = [];
  for (let i = 0; i < total; i += conf.windowSize) {
    windows.push({
      indexMin: i,
      indexMax: Math.min(total, i + conf.windowSize),
    });
  }

  /**
   * Translate one window with validate + retry missing.
   * @param {{ indexMin: number, indexMax: number }} win
   * @param {number} winIndex
   */
  async function translateWindow(win, winIndex) {
    const { indexMin, indexMax } = win;
    /** @type {Map<number, string>} */
    let filled = new Map();
    let attempt = 0;
    /** @type {number[] | null} */
    let onlyIndices = null;

    while (attempt <= conf.maxRetries && !terminalTimeout && !budgetExceeded()) {
      attempt += 1;
      const prevLines = [];
      for (
        let p = Math.max(0, indexMin - conf.contextPrev);
        p < indexMin;
        p += 1
      ) {
        const src = texts[p];
        const vi = out[p] || filled.get(p) || "";
        prevLines.push(
          `${p}|src=${String(src).replace(/\s+/g, " ")}|vi=${String(vi).replace(/\s+/g, " ")}`,
        );
      }

      const user = windowPrompt({
        texts,
        sourceLang,
        targetLang,
        indexMin,
        indexMax,
        glossary,
        prevLines,
        onlyIndices,
      });

      const label = onlyIndices
        ? `retry missing=${onlyIndices.length}`
        : `full window`;
      console.info(
        `[context-translate] window ${winIndex + 1}/${windows.length} ` +
          `[${indexMin},${indexMax}) attempt=${attempt} ${label}`,
      );

      let rawText = "";
      try {
        const resp = await callModel(
          modelCfg,
          systemPrompt(),
          user,
          conf.maxTokens,
        );
        rawText = resp.text;
      } catch (error) {
        const msg = String(error?.message || error);
        console.warn(
          `[context-translate] window ${winIndex + 1} call failed: ${msg}`,
        );
        if (/timeout/i.test(msg)) {
          terminalTimeout = true;
          break;
        }
        if (isPermanentApiFailure(error)) throw error;
        // Retry gateway/network errors within the attempt budget.
        if (attempt <= conf.maxRetries) {
          await sleep(attempt * 1200);
          continue;
        }
        break;
      }

      const items = extractCueItems(rawText);
      const map = itemsToIndexMap(items, { indexMin, indexMax });

      // Merge into filled — reject copies that are identical to Chinese source
      // when target is not Chinese (partial protection against echo).
      for (const [i, t] of map.entries()) {
        if (i < indexMin || i >= indexMax || !t || !String(t).trim()) continue;
        const translated = String(t).trim();
        const src = String(texts[i] ?? "").trim();
        if (
          targetLang !== "zh" &&
          sourceLang === "zh" &&
          translated === src &&
          /[\u4e00-\u9fff]/.test(translated)
        ) {
          // Model echoed source; treat as missing so we retry
          continue;
        }
        if (
          isSuspiciousContextTranslation(
            src,
            translated,
            sourceLang,
            targetLang,
          )
        ) {
          continue;
        }
        filled.set(i, translated);
      }

      const missing = findMissingIndices(indexMin, indexMax, filled);
      console.info(
        `[context-translate] window ${winIndex + 1} filled=${indexMax - indexMin - missing.length}/${indexMax - indexMin} missing=${missing.length}` +
          (missing.length && missing.length <= 12
            ? ` idx=${missing.join(",")}`
            : missing.length
              ? ` idx=${missing.slice(0, 8).join(",")}…`
              : ""),
      );

      if (missing.length === 0) break;

      // ── Validation failed → retry ONLY missing indices ──
      onlyIndices = missing;
      if (attempt > conf.maxRetries) break;
      await sleep(400);
    }

    // Write into shared out[]
    for (let i = indexMin; i < indexMax; i += 1) {
      out[i] = filled.get(i) || "";
    }

    return {
      indexMin,
      indexMax,
      filled: findMissingIndices(indexMin, indexMax, filled).length === 0,
      missing: findMissingIndices(indexMin, indexMax, filled),
    };
  }

  // Run windows (default concurrency=1: safer on freemodel / Cloudflare)
  const windowResults = await mapPool(
    windows.map(
      (win, idx) => () =>
        translateWindow(win, idx).catch((error) => {
          if (isPermanentApiFailure(error)) throw error;
          console.error(
            `[context-translate] window ${idx + 1} crashed:`,
            error,
          );
          return {
            indexMin: win.indexMin,
            indexMax: win.indexMax,
            filled: false,
            missing: Array.from(
              { length: win.indexMax - win.indexMin },
              (_, k) => win.indexMin + k,
            ),
          };
        }),
    ),
    conf.concurrency,
  );

  // Re-run any fully/partially failed windows sequentially with fresh attempts
  for (const wr of windowResults) {
    if (wr.filled || terminalTimeout || budgetExceeded()) continue;
    console.warn(
      `[context-translate] re-running failed window [${wr.indexMin},${wr.indexMax}) sequential`,
    );
    const again = await translateWindow(
      { indexMin: wr.indexMin, indexMax: wr.indexMax },
      windows.findIndex(
        (w) => w.indexMin === wr.indexMin && w.indexMax === wr.indexMax,
      ),
    );
    Object.assign(wr, again);
  }

  // Global missing pass — chunk large missing sets into window-sized retries
  /** @type {number[]} */
  let globalMissing = [];
  for (let i = 0; i < total; i += 1) {
    if (!out[i]?.trim()) globalMissing.push(i);
  }

  let globalRound = 0;
  while (
    globalMissing.length > 0 &&
    globalRound < conf.maxRetries &&
    !terminalTimeout &&
    !budgetExceeded()
  ) {
    globalRound += 1;
    console.info(
      `[context-translate] global retry #${globalRound} missing=${globalMissing.length}`,
    );
    // Process missing in chunks of windowSize
    for (let c = 0; c < globalMissing.length; c += conf.windowSize) {
      const chunk = globalMissing.slice(c, c + conf.windowSize);
      try {
        const user = windowPrompt({
          texts,
          sourceLang,
          targetLang,
          indexMin: chunk[0],
          indexMax: chunk[chunk.length - 1] + 1,
          glossary,
          prevLines: [],
          onlyIndices: chunk,
        });
        const resp = await callModel(
          modelCfg,
          systemPrompt(),
          user,
          conf.maxTokens,
        );
        const map = itemsToIndexMap(extractCueItems(resp.text), {
          indexMin: 0,
          indexMax: total,
        });
        for (const i of chunk) {
          const t = map.get(i);
          if (
            t?.trim() &&
            !(
              targetLang !== "zh" &&
              sourceLang === "zh" &&
              t.trim() === String(texts[i] ?? "").trim()
            ) &&
            !isSuspiciousContextTranslation(
              String(texts[i] ?? ""),
              t.trim(),
              sourceLang,
              targetLang,
            )
          ) {
            out[i] = t.trim();
          }
        }
      } catch (error) {
        if (isPermanentApiFailure(error)) throw error;
        console.warn(
          `[context-translate] global chunk failed: ${error?.message || error}`,
        );
        if (/timeout/i.test(String(error?.message || error))) {
          terminalTimeout = true;
          break;
        }
        await sleep(1000);
      }
    }
    globalMissing = [];
    for (let i = 0; i < total; i += 1) {
      if (!out[i]?.trim()) globalMissing.push(i);
    }
    if (globalMissing.length === 0) break;
  }

  /** @type {number[]} */
  const stillMissing = [];
  for (let i = 0; i < total; i += 1) {
    if (!out[i]?.trim()) stillMissing.push(i);
  }

  const elapsed = Date.now() - started;
  const missingRatio = total ? stillMissing.length / total : 0;
  console.info(
    `[context-translate] done cues=${total} missing_final=${stillMissing.length} ` +
      `(${(missingRatio * 100).toFixed(1)}%) windows=${windows.length} ` +
      `elapsed=${elapsed}ms model=${modelCfg.model}`,
  );

  // CRITICAL: do NOT silently return Chinese source as "translated" for large holes.
  // That is exactly what made the UI look fully Chinese.
  if (missingRatio > (conf.maxMissingRatio || 0.05)) {
    const err = new Error(
      `Translation incomplete: ${stillMissing.length}/${total} cues missing or failed validation. ` +
        `Retry Generate, verify the API endpoint/key, or switch model.`,
    );
    /** @type {any} */
    const e = err;
    e.missingFinal = stillMissing;
    e.partialTranslations = out;
    throw err;
  }

  // Tiny remainder: keep source only for a few holes so timeline stays aligned
  for (const i of stillMissing) {
    out[i] = String(texts[i] ?? "");
  }

  return {
    translations: out,
    model: modelCfg.model,
    protocol,
    strategy: "context-window+validate+retry",
    windowSize: conf.windowSize,
    windows: windows.length,
    glossaryTerms: glossary.length,
    missingFinal: stillMissing,
    windowResults,
    elapsedMs: elapsed,
  };
}
