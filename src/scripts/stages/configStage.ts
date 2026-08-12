import {
  loadSavedTranslateSettings,
  saveTranslateSettings,
  TRANSLATE_SETTINGS_CHANGED_EVENT,
  TRANSLATE_SETTINGS_STORAGE_KEY,
  type TranslateProvider,
} from "@/scripts/googleTranslateClient.ts"
import {
  canPlanSubtitleCues,
  planAndTranslateSubtitleCues,
} from "@/scripts/cuePlanClient.ts"
import { createAudioService } from "@/scripts/media/audio.ts"
import { normalizeLanguageCode } from "@/scripts/subtitles.ts"
import { transcribeAudioWithGroq } from "@/scripts/speechClient.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>

type GeneratedState = {
  detectedLang: string
  baseSegments: Segment[]
  segmentsByLang: SegmentsByLang
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
}

type ConfigStageOptions = {
  ui: typeof appUi
  tt: (path: string, vars?: Record<string, unknown>) => string
  downloads: any
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>
  updateDownloadStatus: (key: string, state: string) => void
  translateSegments: (
    segments: Segment[],
    sourceLang: string,
    targetLang: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Segment[]>
  cancelTranslation?: () => void
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setGeneratedState: (state: GeneratedState) => void
  renderTabs: () => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  resetHistory: () => void
  updateCaption: () => void
  setStage: (stage: Stage) => void
}

export function createConfigStageController({
  ui,
  tt,
  fetchWithProgress,
  updateDownloadStatus,
  translateSegments,
  selectedVideoFile,
  setGeneratedState,
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
}: ConfigStageOptions) {
  let progressRaf = 0
  let progressIndeterminate = false
  let generationController: AbortController | null = null

  const audioService = createAudioService({
    tt,
    fetchWithProgress,
    updateDownloadStatus,
    setStatus,
    setProgress,
    applyProgress,
    setIndeterminate,
    startProgressCreep,
    stopProgressCreep,
  })

  function setStatus(message: string, kind = "ok") {
    if (!ui.configStatus) return
    ui.configStatus.textContent = message
    ui.configStatus.dataset.kind = kind
  }

  function applyProgress(percent: number) {
    if (progressIndeterminate) return
    const clamped = Math.max(0, Math.min(100, percent))
    const rounded = Math.round(clamped)
    ui.configProgressFill.style.width = `${clamped}%`
    ui.configProgressPct.textContent = `${rounded}%`
    ui.configProgressTrack?.setAttribute("aria-valuenow", String(rounded))
  }

  function setProgress(percent: number) {
    setIndeterminate(false)
    applyProgress(percent)
  }

  function setIndeterminate(on: boolean) {
    if (on) stopProgressCreep()
    progressIndeterminate = on
    ui.configProgressFill.classList.toggle("is-indeterminate", on)
    if (ui.configProgressTrack) {
      ui.configProgressTrack.setAttribute("aria-busy", on ? "true" : "false")
      if (on) ui.configProgressTrack.removeAttribute("aria-valuenow")
    }
    ui.configProgressPct.textContent = on ? "" : ui.configProgressPct.textContent
  }

  function stopProgressCreep() {
    if (progressRaf) {
      cancelAnimationFrame(progressRaf)
      progressRaf = 0
    }
  }

  function startProgressCreep(from: number, ceiling: number, expected: number) {
    stopProgressCreep()
    const started = performance.now()
    const span = ceiling - from
    const tick = (now: number) => {
      const t = (now - started) / Math.max(1, expected)
      applyProgress(from + span * (1 - Math.exp(-1.6 * t)))
      progressRaf = requestAnimationFrame(tick)
    }
    progressRaf = requestAnimationFrame(tick)
  }

  function persistTranslateProvider() {
    saveTranslateSettings({
      provider: (ui.translateProvider?.value || "custom") as TranslateProvider,
    })
  }

  function initTranslateSettings() {
    const saved = loadSavedTranslateSettings()
    if (ui.translateProvider) {
      ui.translateProvider.value = saved.provider === "gemini" ? "gemini" : "custom"
    }
  }

  async function preloadAssetsInBackground() {
    // FFmpeg remains available for export/remux. ASR and all speech models are
    // intentionally absent and are never initialized here.
    updateDownloadStatus("ffmpeg", "ready")
  }

  async function generate() {
    const videoFile = selectedVideoFile()
    if (!videoFile) {
      const message = tt("config.videoRequired")
      setStatus(message, "error")
      ui.configError.textContent = message
      ui.configError.hidden = false
      return
    }

    ui.transcribeBtn.disabled = true
    ui.cancelGenerateBtn.hidden = false
    generationController = new AbortController()
    ui.configError.hidden = true
    ui.configProgress.hidden = false
    setProgress(2)
    try {
      setStatus(tt("config.groqPreparing"), "busy")
      const audio = await audioService.extractAudioBuffer(videoFile)
      setStatus(tt("config.groqTranscribing"), "busy")
      const sourceHint = ui.inputLang?.value?.trim() || undefined
      const transcript = await transcribeAudioWithGroq(audio, {
        language: sourceHint,
        signal: generationController.signal,
        onProgress: (percent) => setProgress(percent),
        onChunk: (current, total) => {
          setStatus(
            total > 1
              ? tt("config.groqTranscribingPart", {
                  current: String(current),
                  total: String(total),
                })
              : tt("config.groqTranscribing"),
            "busy",
          )
        },
      })
      const rawBaseSegments = transcript.segments.map((segment) => ({ ...segment }))
      if (!rawBaseSegments.length) throw new Error(tt("config.groqNoSegments"))

      const sourceLang = normalizeLanguageCode(transcript.language) || normalizeLanguageCode(sourceHint || "") || "zh"
      if (ui.inputLang && !ui.inputLang.value) ui.inputLang.value = sourceLang
      const targetLang = ui.outputLang?.value || "same"
      let baseSegments = rawBaseSegments
      let translated: Segment[] | undefined
      if (targetLang && targetLang !== "same" && targetLang !== sourceLang) {
        if (canPlanSubtitleCues(transcript.words)) {
          try {
            setStatus(tt("config.translatingTo", { lang: targetLang }), "busy")
            const planned = await planAndTranslateSubtitleCues(
              transcript.words,
              rawBaseSegments,
              sourceLang,
              targetLang,
              { signal: generationController.signal },
            )
            baseSegments = planned.sourceSegments
            translated = planned.translatedSegments
            console.info(
              `[cue-plan] ${planned.inputWords} words → ${planned.outputCues} cues ` +
                `model=${planned.model}`,
            )
          } catch (error) {
            console.warn(
              "[cue-plan] AI grouping failed; using stable translation fallback",
              error,
            )
            baseSegments = rawBaseSegments
            translated = await translateSegments(
              rawBaseSegments,
              sourceLang,
              targetLang,
              { signal: generationController.signal },
            )
          }
        } else {
          translated = await translateSegments(
            rawBaseSegments,
            sourceLang,
            targetLang,
            { signal: generationController.signal },
          )
        }
      }
      const segmentsByLang: SegmentsByLang = { [sourceLang]: baseSegments }
      const orderedLangs = [sourceLang]
      let activeLang = sourceLang
      if (translated?.length) {
        segmentsByLang[targetLang] = translated
        orderedLangs.push(targetLang)
        activeLang = targetLang
      }

      setGeneratedState({
        detectedLang: sourceLang,
        baseSegments,
        segmentsByLang,
        orderedLangs,
        activeLang,
        dualTrackMode: false,
        dualTrackLangs: [],
      })
      resetHistory()
      renderTabs()
      renderSegments()
      enableExports(true)
      ui.addSegBtn.disabled = false
      setStatus(tt("config.groqReady", { count: baseSegments.length, model: transcript.model }), "ok")
      setProgress(100)
      updateCaption()
      setStage("editor")
    } catch (error: any) {
      console.error("[groq-whisper]", error)
      const message = error?.name === "AbortError" ? tt("config.cancelled") : String(error?.message || error)
      setStatus(message, "error")
      ui.configError.textContent = message
      ui.configError.hidden = false
    } finally {
      ui.cancelGenerateBtn.hidden = true
      ui.transcribeBtn.disabled = false
      ui.configProgress.hidden = true
      generationController = null
    }
  }

  function wireConfigStage() {
    ui.transcribeBtn.disabled = false
    ui.transcribeBtn.addEventListener("click", () => void generate())
    ui.cancelGenerateBtn.addEventListener("click", () => {
      generationController?.abort()
      setStatus(tt("config.cancelled"), "error")
    })
    ui.translateProvider?.addEventListener("change", () => {
      persistTranslateProvider()
    })
    document.querySelector("#config-open-api-btn")?.addEventListener("click", () => {
      document.querySelector<HTMLButtonElement>("#nav-api-tool")?.click()
    })
    window.addEventListener(TRANSLATE_SETTINGS_CHANGED_EVENT, () => {
      initTranslateSettings()
    })
    window.addEventListener("storage", (event) => {
      if (event.key === TRANSLATE_SETTINGS_STORAGE_KEY) initTranslateSettings()
    })
    initTranslateSettings()
  }

  return {
    setStatus,
    setProgress,
    applyProgress,
    setIndeterminate,
    startProgressCreep,
    stopProgressCreep,
    ensureRecognizer: async () => {
      throw new Error(tt("config.asrDisabled"))
    },
    preloadAssetsInBackground,
    startEarlyTranscription: () => undefined,
    resetTranscriptionCache: () => undefined,
    generate,
    cancelGeneration: () => {
      generationController?.abort()
    },
    wireConfigStage,
    remuxAudioToAacLc: audioService.remuxAudioToAacLc,
  }
}
