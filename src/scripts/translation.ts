import {
  isApiTranslateAvailable,
  loadSavedGeminiSettings,
  loadSavedTranslateSettings,
  translateTextsWithGoogle,
  type TranslateProvider,
} from "@/scripts/googleTranslateClient.ts"
import { LANGS } from "@/scripts/languages.ts"
import { reflowTranslatedSegments } from "@/scripts/subtitles.ts"
import { sanitizeSubtitleSourceText } from "@/scripts/subtitleArtifacts.ts"

const TRANSLATION_DEBUG = import.meta.env.DEV
const BRACKETED_CUE_PATTERN = /\[([^\[\]]{1,80})\]/g

const BUILT_IN_GLOSSARIES: Record<string, string[]> = {
  "zh:vi": [
    "轻功 => khinh công",
    "身法 => thân pháp",
    "比武 => tỷ võ",
    "燃元爆灵丹 => Nhiên Nguyên Bạo Linh Đan",
    "姐姐 => tỷ tỷ (trong bối cảnh cổ trang hoặc tiên hiệp)",
  ],
}

const BRACKETED_SOUND_TRANSLATIONS: Record<string, Record<string, string>> = {
  es: {
    APPLAUSE: "APLAUSOS",
    CLAPPING: "APLAUSOS",
    LAUGHTER: "RISAS",
    LAUGHING: "RISAS",
    MUSIC: "MUSICA",
    CHEERING: "VITORES",
    SILENCE: "SILENCIO",
    NOISE: "RUIDO",
    "BACKGROUND NOISE": "RUIDO DE FONDO",
    INAUDIBLE: "INAUDIBLE",
    SIGH: "SUSPIRO",
    COUGH: "TOS",
    COUGHING: "TOS",
    CRYING: "LLANTO",
    GASP: "JADEO",
    BEEP: "PITIDO",
    WHISTLE: "SILBIDO",
  },
}

function normalizeProvider(value: unknown): TranslateProvider {
  // Migrate the removed browser-local option saved by an older build.
  return value === "gemini" ? "gemini" : "custom"
}

function selectedTranslateProvider(): TranslateProvider {
  if (typeof document !== "undefined") {
    const element = document.getElementById(
      "translate-provider",
    ) as HTMLSelectElement | null
    if (element?.value) return normalizeProvider(element.value)
  }
  return normalizeProvider(loadSavedTranslateSettings().provider)
}

function soundCueKey(label: string) {
  return label
    .trim()
    .replace(/^[\s.!?¡¿…]+|[\s.!?¡¿…]+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function translatedSoundCueLabels(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return []
  const labels: string[] = []
  for (const match of text.matchAll(BRACKETED_CUE_PATTERN)) {
    const translated = glossary[soundCueKey(match[1])]
    if (translated) labels.push(translated)
  }
  return labels
}

function translateBracketedSoundCues(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return text
  return text.replace(BRACKETED_CUE_PATTERN, (match, label) => {
    const translated = glossary[soundCueKey(label)]
    return translated ? `[${translated}]` : match
  })
}

function enforceBracketedSoundCues(
  translatedText: string,
  sourceText: string,
  targetLang: string,
) {
  const expected = translatedSoundCueLabels(sourceText, targetLang)
  if (!expected.length) return translatedText

  let index = 0
  const text = translatedText.replace(BRACKETED_CUE_PATTERN, (match) => {
    const label = expected[index]
    if (!label) return match
    index += 1
    return `[${label}]`
  })
  if (index >= expected.length) return text
  return `${text.trimEnd()} ${expected
    .slice(index)
    .map((label) => `[${label}]`)
    .join(" ")}`.trim()
}

function correctKnownChineseAsrTerms(text: string, sourceLang: string) {
  if (sourceLang !== "zh") return text
  return String(text || "")
    .replace(/燃[源原]暴灵丹/gu, "燃元爆灵丹")
    .replace(/清宫(?=是|的|借|腿|发力)/gu, "轻功")
    .replace(/山法(?=决定|关乎|影响)/gu, "身法")
    .replace(/上房为何不准/gu, "上房为何不住")
}

function terminalPunctuation(sourceText = "") {
  const source = sourceText.trim()
  if (/[?？]\s*$/.test(source)) return "?"
  if (/[!！]\s*$/.test(source)) return "!"
  return "."
}

function cleanTranslationArtifacts(text: string, sourceText = "") {
  return String(text || "")
    .trim()
    .replace(/(?:[.!?…]\s*){4,}$/u, terminalPunctuation(sourceText))
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .trim()
}

function apiFailureMessage(error: unknown) {
  const detail = String((error as any)?.message || error || "Unknown API error")
  return `Dịch qua API thất bại: ${detail}`
}

type TranslationServiceOptions = {
  downloads: any
  renderDownloads: () => void
  updateDownloadStatus: (key: string, state: string) => void
  tt: (path: string, vars?: Record<string, unknown>) => string
  langName: (code: string) => string
  setStatus: (message: string, kind?: string) => void
}

export function createTranslationService(options: TranslationServiceOptions) {
  let translationReady = false
  const activeAbortControllers = new Set<AbortController>()

  function glossaryForPair(sourceLang: string, targetLang: string) {
    return [
      ...new Set(
        [
          ...(BUILT_IN_GLOSSARIES[`${sourceLang}:${targetLang}`] || []),
        ]
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ]
  }

  function markApiReady(provider: TranslateProvider) {
    const saved = loadSavedTranslateSettings()
    const savedGemini = loadSavedGeminiSettings()
    const item = options.downloads.translation
    item.readyNote =
      provider === "gemini"
        ? `Gemini API · ${savedGemini.model || "model"}`
        : provider === "custom"
          ? `Custom API · ${saved.model || "model"}`
          : "API translation"
    item.total = 0
    item.loaded = 0
    item.progress = 100
    translationReady = true
    options.updateDownloadStatus("translation", "ready")
    options.renderDownloads()
  }

  async function ensureTranslation() {
    const provider = selectedTranslateProvider()
    if (!(await isApiTranslateAvailable(provider))) {
      translationReady = false
      options.updateDownloadStatus("translation", "error")
      throw new Error(
        "Chưa cấu hình API dịch. Hãy chọn Gemini hoặc nhập endpoint và API key hợp lệ.",
      )
    }
    markApiReady(provider)
    return "api" as const
  }

  async function translateWithApi(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    signal: AbortSignal,
    provider: TranslateProvider,
  ) {
    const saved = loadSavedTranslateSettings()
    const savedGemini = loadSavedGeminiSettings()
    options.setStatus(
      options.tt("steps.translatingTo", { lang: options.langName(targetLang) }),
      "busy",
    )
    const output = await translateTextsWithGoogle(texts, sourceLang, targetLang, {
      provider,
      model: provider === "gemini" ? savedGemini.model : saved.model,
      models: provider === "gemini" ? undefined : saved.models,
      baseUrl: saved.baseUrl,
      apiKey: saved.apiKey,
      geminiApiKey: provider === "gemini" ? savedGemini.apiKey : undefined,
      protocol: saved.protocol,
      glossary: glossaryForPair(sourceLang, targetLang),
      signal,
    })
    if (TRANSLATION_DEBUG) {
      console.info(
        `[translate:api] provider=${provider} cues=${texts.length} ${sourceLang}→${targetLang}`,
      )
    }
    return output
  }

  async function translateSegments(
    segments: any[],
    sourceLang: string,
    targetLang: string,
    requestOptions: { signal?: AbortSignal } = {},
  ) {
    if (!segments.length || sourceLang === targetLang)
      return segments.map((segment) => ({ ...segment }))
    if (!(LANGS as any)[sourceLang] || !(LANGS as any)[targetLang])
      return segments.map((segment) => ({ ...segment }))

    await ensureTranslation()
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(requestOptions.signal?.reason)
    requestOptions.signal?.addEventListener("abort", abortFromCaller, {
      once: true,
    })
    if (requestOptions.signal?.aborted) abortFromCaller()
    activeAbortControllers.add(controller)

    try {
      controller.signal.throwIfAborted()
      const preparedTexts = segments.map((segment) =>
        translateBracketedSoundCues(
          sanitizeSubtitleSourceText(
            correctKnownChineseAsrTerms(segment.text, sourceLang),
          ),
          targetLang,
        ),
      )
      const requestIndices = preparedTexts
        .map((text, index) => (text.trim() ? index : -1))
        .filter((index): index is number => index >= 0)
      const requestTexts = requestIndices.map((index) => preparedTexts[index])
      const selectedProvider = selectedTranslateProvider()
      const primaryProvider =
        selectedProvider === "auto" &&
        (await isApiTranslateAvailable("gemini"))
          ? "gemini"
          : selectedProvider
      let translatedTexts = preparedTexts.map(() => "")
      if (requestTexts.length) {
        let apiTranslations: string[]
        try {
          apiTranslations = await translateWithApi(
            requestTexts,
            sourceLang,
            targetLang,
            controller.signal,
            primaryProvider,
          )
      } catch (primaryError) {
        if (controller.signal.aborted) throw primaryError
        const fallbackProvider: TranslateProvider | null =
          selectedProvider === "auto" &&
          primaryProvider === "gemini" &&
          (await isApiTranslateAvailable("custom"))
            ? "custom"
            : primaryProvider !== "gemini" &&
                (await isApiTranslateAvailable("gemini"))
              ? "gemini"
              : null
        if (fallbackProvider) {
          options.setStatus(options.tt("steps.translationFallback"), "busy")
          console.warn(
            `[translate] ${primaryProvider} failed; retrying with ${fallbackProvider} API`,
            primaryError,
          )
          try {
            apiTranslations = await translateWithApi(
              requestTexts,
              sourceLang,
              targetLang,
              controller.signal,
              fallbackProvider,
            )
          } catch (fallbackError) {
            if (controller.signal.aborted) throw fallbackError
            throw new Error(
              `${apiFailureMessage(primaryError)}; API ${fallbackProvider} dự phòng cũng thất bại: ${String(
                (fallbackError as any)?.message || fallbackError,
              )}`,
            )
          }
        } else {
          throw new Error(apiFailureMessage(primaryError))
        }
        }
        requestIndices.forEach((originalIndex, apiIndex) => {
          translatedTexts[originalIndex] = apiTranslations[apiIndex] ?? ""
        })
      }

      controller.signal.throwIfAborted()
      const translatedSegments = segments.map((segment, index) => ({
        ...segment,
        text:
          cleanTranslationArtifacts(
            enforceBracketedSoundCues(
              translatedTexts[index] || preparedTexts[index],
              segment.text,
              targetLang,
            ),
            preparedTexts[index],
          ) || preparedTexts[index],
        words: undefined,
      }))
      return reflowTranslatedSegments(segments, translatedSegments, {
        targetLang,
      })
    } finally {
      requestOptions.signal?.removeEventListener("abort", abortFromCaller)
      activeAbortControllers.delete(controller)
    }
  }

  function cancelActiveTranslations() {
    for (const controller of activeAbortControllers) controller.abort()
    activeAbortControllers.clear()
  }

  return {
    ensureTranslation,
    isTranslationReady: () => translationReady,
    translateSegments,
    cancelActiveTranslations,
  }
}
