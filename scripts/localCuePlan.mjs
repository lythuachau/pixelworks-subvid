import {
  buildCuePlanPrompt,
  materializeCuePlan,
  normalizeCuePlanWords,
} from "../src/server/cuePlan.ts";
import {
  generateStructuredWithGoogle,
} from "./localGoogleTranslate.mjs";

const MAX_WORDS = 900;
const CUE_PLAN_SCHEMA = {
  type: "OBJECT",
  required: ["cues"],
  properties: {
    cues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["to", "translation"],
        properties: {
          to: { type: "STRING" },
          translation: { type: "STRING" },
        },
      },
    },
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseJson(raw) {
  const cleaned = String(raw || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export const buildPrompt = buildCuePlanPrompt;

export async function handleLocalCuePlan(request) {
  if ((request.method || "GET").toUpperCase() !== "POST")
    return json({ ok: false, error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json", message: "Invalid JSON body." }, 400);
  }

  const words = normalizeCuePlanWords(body?.words);
  const segments = Array.isArray(body?.segments) ? body.segments : [];
  const sourceLang = String(body?.source || body?.sourceLang || "").trim();
  const targetLang = String(body?.target || body?.targetLang || "").trim();
  if (!words.length || !sourceLang || !targetLang)
    return json(
      {
        ok: false,
        error: "invalid_input",
        message: "Timestamped words, source, and target are required.",
      },
      400,
    );
  if (words.length > MAX_WORDS)
    return json(
      {
        ok: false,
        error: "too_many_words",
        message: `AI cue planning currently supports at most ${MAX_WORDS} word units.`,
      },
      413,
    );

  try {
    const prompt = buildPrompt(words, segments, sourceLang, targetLang);
    const generated = await generateStructuredWithGoogle(prompt, {
      maxOutputTokens: 8192,
      responseSchema: CUE_PLAN_SCHEMA,
    });
    const plan = parseJson(generated.text);
    const cues = materializeCuePlan(words, plan, { targetLang });
    return json({
      ok: true,
      engine: "gemini",
      model: generated.model,
      cues,
      sourceSegments: cues.map((cue) => ({
        start: cue.start,
        end: cue.end,
        text: cue.sourceText,
      })),
      translatedSegments: cues.map((cue) => ({
        start: cue.start,
        end: cue.end,
        text: cue.translation,
      })),
      diagnostics: {
        inputWords: words.length,
        outputCues: cues.length,
      },
    });
  } catch (error) {
    console.error("[cue-plan]", error);
    return json(
      {
        ok: false,
        error: "cue_plan_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}
