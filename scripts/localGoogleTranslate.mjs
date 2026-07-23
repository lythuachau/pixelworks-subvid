/**
 * Google Gemini API (AI Studio key) for contextual subtitle translation.
 *
 * This is NOT Cloud Translation API — keys like AQ.* / AIza* from AI Studio
 * call generativelanguage.googleapis.com and use Gemini models.
 *
 * Env (any one for key):
 *   GEMINI_API_KEY
 *   GOOGLE_API_KEY
 *   GOOGLE_TRANSLATE_API_KEY
 *   GOOGLE_CLOUD_API_KEY
 *
 * Optional model:
 *   GEMINI_TRANSLATE_MODEL=gemini-2.5-flash
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
/** Cues per request — keep moderate for quality + rate limits. */
const BATCH_SIZE = 24;

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
  const fileEnv = loadDotEnvFile();
  return { ...fileEnv, ...process.env };
}

function getApiKey() {
  const env = envAll();
  return (
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.GOOGLE_TRANSLATE_API_KEY ||
    env.GOOGLE_CLOUD_API_KEY ||
    ""
  ).trim();
}

function getModel() {
  const env = envAll();
  return (env.GEMINI_TRANSLATE_MODEL || DEFAULT_MODEL).trim();
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

export function langLabel(code) {
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

export function isGoogleTranslateConfigured() {
  return !!getApiKey();
}

function buildPrompt(
  texts,
  sourceLang,
  targetLang,
  glossary = [],
  { repair = false } = {},
) {
  const src = langLabel(sourceLang);
  const tgt = langLabel(targetLang);
  const lines = texts
    .map((t, i) => `${i + 1}. ${String(t ?? "").replace(/\r?\n/g, " ").trim()}`)
    .join("\n");

  return [
    `You are a professional subtitle translator for short-form video.`,
    `Translate from ${src} to natural spoken ${tgt}.`,
    repair
      ? `IMPORTANT: a previous response omitted or copied these cues. Translate every cue completely this time.`
      : "",
    `Rules:`,
    `- Preserve meaning, tone, and informal speech when present.`,
    `- Keep each cue short enough for on-screen captions.`,
    `- Return ONLY a valid JSON array containing EXACTLY ${texts.length} translated strings in the same order.`,
    `- Do not merge, split, omit, or copy source cues. Do not add commentary or Markdown.`,
    sourceLang === "zh" && targetLang !== "zh"
      ? `- The output must be written in ${tgt}. Do not leave Chinese Han characters in the translation; transliterate names and translate terms.`
      : "",
    `- Keep [SOUND] markers like [MUSIC] if present; translate the label when obvious.`,
    glossary.length
      ? `- Required glossary (use consistently):\n${glossary.map((term) => `  - ${term}`).join("\n")}`
      : "",
    ``,
    `Source cues:`,
    lines,
  ].join("\n");
}

export function parseNumberedLines(raw, expected) {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim();
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      const output = parsed.slice(0, expected).map((value) => String(value ?? "").trim());
      while (output.length < expected) output.push("");
      return output;
    }
  } catch (error) {
    // Keep compatibility with older numbered-line responses.
    console.warn("[gemini-translate] JSON parse fallback", {
      error: String(error?.message || error),
    });
  }
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
    for (let i = 1; i <= expected; i += 1) {
      out.push(byIndex.get(i) ?? "");
    }
    return out;
  }

  // Fallback: non-empty lines in order
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

async function callGemini(model, key, prompt, attempt = 1) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (res.status === 429 && attempt < 4) {
    const wait = attempt * 2500;
    console.warn(
      `[gemini-translate] rate limited, retry in ${wait}ms (attempt ${attempt})`,
    );
    await sleep(wait);
    return callGemini(model, key, prompt, attempt + 1);
  }

  if (!res.ok) {
    const detail =
      payload?.error?.message || payload?.error?.status || res.statusText;
    throw new Error(
      `Gemini HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => p?.text || "").join("")
    : "";
  if (!text.trim()) {
    throw new Error("Gemini returned empty translation");
  }
  return text;
}

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(
    String(text || ""),
  );
}

const GENERIC_TRANSLATION_RE = /^(?:cái gì(?: đây| vậy)?[!?。.]*|dễ thương quá[!?。.]*|trông giống (?:mèo|chó) quá[.!?。]*|con mèo[.!?。]*|con chó[.!?。]*|wow[.!?。]*|haha[.!?。]*|giỏi quá[.!?。]*|nhỏ quá[.!?。]*|what(?: is this| is that)[!?。.]*|so cute[.!?。.]*|looks like (?:a )?(?:cat|dog)[.!?。.]*|wow[.!?。.]*|good job[.!?。.]*|haha[.!?。.]*)$/iu

function hasSameNumbers(source, translated) {
  const sourceNumbers = String(source || "").match(/\d+(?:[.,]\d+)?/g) || []
  if (!sourceNumbers.length) return true
  const target = String(translated || "")
  return sourceNumbers.every((number) => target.includes(number))
}

/** Catch HTTP-200 responses that are shaped correctly but clearly unrelated. */
export function isSemanticallySuspicious(source, translated, sourceLang, targetLang) {
  const src = String(source || "").trim()
  const dst = String(translated || "").trim()
  if (!src || !dst || sourceLang === targetLang) return false
  if (GENERIC_TRANSLATION_RE.test(dst) && src.length >= 4) return true
  if (!hasSameNumbers(src, dst)) return true
  return false
}

export function needsRepair(source, translated, sourceLang, targetLang) {
  const src = String(source || "").trim();
  const dst = String(translated || "").trim();
  if (!dst) return true;
  if (src && src === dst) return true;
  if (sourceLang === "zh" && targetLang !== "zh" && containsCjk(dst)) return true;
  return isSemanticallySuspicious(src, dst, sourceLang, targetLang);
}

async function translateBatch(model, key, texts, sourceLang, targetLang, glossary) {
  const prompt = buildPrompt(texts, sourceLang, targetLang, glossary);
  const raw = await callGemini(model, key, prompt);
  const output = parseNumberedLines(raw, texts.length);

  // Retry only omitted/copied/untranslated cues. This also repairs responses
  // whose numbering/shape caused the parser to leave blank slots.
  for (let round = 1; round <= 2; round += 1) {
    const missing = output
      .map((translated, index) =>
        needsRepair(texts[index], translated, sourceLang, targetLang)
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (!missing.length) break;

    console.warn(
      `[gemini-translate] repair round=${round} missing=${missing.length}/${texts.length}`,
    );
    const retryTexts = missing.map((index) => texts[index]);
    const retryPrompt = buildPrompt(
      retryTexts,
      sourceLang,
      targetLang,
      glossary,
      { repair: true },
    );
    const retryRaw = await callGemini(model, key, retryPrompt);
    const repaired = parseNumberedLines(retryRaw, retryTexts.length);
    missing.forEach((originalIndex, retryIndex) => {
      const candidate = String(repaired[retryIndex] || "").trim();
      if (!needsRepair(texts[originalIndex], candidate, sourceLang, targetLang)) {
        output[originalIndex] = candidate;
      }
    });
  }

  const unresolved = output
    .map((translated, index) =>
      needsRepair(texts[index], translated, sourceLang, targetLang) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (unresolved.length) {
    const error = new Error(
      `Gemini left ${unresolved.length}/${texts.length} cues untranslated after repair`,
    );
    error.missingFinal = unresolved;
    error.partialTranslations = output;
    throw error;
  }
  return output;
}

/**
 * @param {string[]} texts
 * @param {string} sourceLang
 * @param {string} targetLang
 */
export async function translateWithGoogle(texts, sourceLang, targetLang, glossary = []) {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "Gemini API key missing. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env",
    );
  }

  const model = getModel();
  const outputs = new Array(texts.length);
  const started = Date.now();
  const totalBatches = Math.max(1, Math.ceil(texts.length / BATCH_SIZE));

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    console.info(
      `[gemini-translate] batch ${batchNumber}/${totalBatches} model=${model} ${sourceLang}→${targetLang} n=${batch.length}`,
    );

    const lines = await translateBatch(
      model,
      key,
      batch,
      sourceLang,
      targetLang,
      glossary,
    );

    // Gentle pacing to reduce free-tier 429s on long subtitle lists.
    if (i + BATCH_SIZE < texts.length) await sleep(400);
  }

  console.info(
    `[gemini-translate] done model=${model} ${sourceLang}→${targetLang} cues=${texts.length} elapsed=${Date.now() - started}ms`,
  );
  return outputs;
}

export async function handleGoogleTranslateStatus() {
  const configured = isGoogleTranslateConfigured();
  const model = getModel();
  return json({
    ok: configured,
    engine: "gemini",
    provider: "google-ai-studio",
    model,
    configured,
    message: configured
      ? `Gemini translation ready (model=${model})`
      : "Set GEMINI_API_KEY in .env to enable Gemini contextual translation",
  });
}

export async function handleGoogleTranslate(request) {
  if ((request.method || "GET").toUpperCase() !== "POST") {
    return json({ ok: false, error: "method", message: "POST required" }, 405);
  }
  if (!isGoogleTranslateConfigured()) {
    return json(
      {
        ok: false,
        error: "not_configured",
        message:
          "GEMINI_API_KEY is not set. Add it to .env and restart the dev server.",
      },
      503,
    );
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

  const texts = Array.isArray(body?.texts)
    ? body.texts.map((t) => String(t ?? ""))
    : [];
  const sourceLang = String(body?.source || body?.sourceLang || "").trim();
  const targetLang = String(body?.target || body?.targetLang || "").trim();
  const modelOverride = String(body?.model || "").trim();

  if (!texts.length) {
    return json({
      ok: true,
      translations: [],
      engine: "gemini",
      model: getModel(),
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
      engine: "gemini",
      model: modelOverride || getModel(),
    });
  }

  // Temporary model override for this request only.
  const prev = process.env.GEMINI_TRANSLATE_MODEL;
  if (modelOverride) process.env.GEMINI_TRANSLATE_MODEL = modelOverride;

  try {
    const translations = await translateWithGoogle(
      texts,
      sourceLang,
      targetLang,
      Array.isArray(body?.glossary) ? body.glossary.map(String) : [],
    );
    return json({
      ok: true,
      engine: "gemini",
      model: modelOverride || getModel(),
      source: sourceLang,
      target: targetLang,
      translations,
    });
  } catch (error) {
    console.error("[gemini-translate]", error);
    return json(
      {
        ok: false,
        error: "translate_failed",
        message: String(error?.message || error),
      },
      500,
    );
  } finally {
    if (modelOverride) {
      if (prev == null) delete process.env.GEMINI_TRANSLATE_MODEL;
      else process.env.GEMINI_TRANSLATE_MODEL = prev;
    }
  }
}
