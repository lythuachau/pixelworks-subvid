import { baseFileName } from "@/scripts/file.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import {
  buildSubtitleFile,
  createStoredZip,
  type SubtitleFormat,
} from "@/scripts/subtitleFormats.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }

type EditorStageOptions = {
  ui: typeof appUi
  currentSegments: () => Segment[]
  allSegmentsByLang: () => Record<string, Segment[]>
  activeLang: () => string
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setStage: (stage: Stage) => void
  undo: () => void
  redo: () => void
}

function isTextInputTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  )
}

export function createEditorStageController({
  ui,
  currentSegments,
  allSegmentsByLang,
  activeLang,
  selectedVideoFile,
  isExporting,
  setStage,
  undo,
  redo,
}: EditorStageOptions) {
  function enableExports(on: boolean) {
    const ready = on && currentSegments().length > 0
    ui.downloadSrtBtn.disabled = !ready
    ui.downloadAllTracksBtn.disabled = !(
      on && Object.values(allSegmentsByLang()).some((segments) => segments.length)
    )
    ui.qualityCheckBtn.disabled = !ready
    ui.compareOpenBtn.disabled = !(
      on && Object.values(allSegmentsByLang()).filter((segments) => segments.length).length > 1
    )
    ui.subtitleFormat.disabled = !ready
    ui.downloadVideoBtn.disabled = !ready || !selectedVideoFile()
    ui.exportFormat.disabled = !ready
    ui.exportQuality.disabled = !ready
  }

  function backToConfig() {
    if (isExporting()) return
    ui.video.pause()
    setStage("config")
  }

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function selectedSubtitleFormat(): SubtitleFormat {
    const value = ui.subtitleFormat?.value
    return value === "vtt" || value === "ass" || value === "txt" ? value : "srt"
  }

  function downloadSrt() {
    const segments = currentSegments()
    if (!segments.length) return

    const format = selectedSubtitleFormat()
    const blob = new Blob(
      [buildSubtitleFile(segments, format, baseFileName(selectedVideoFile()))],
      {
      type: "text/plain;charset=utf-8",
      },
    )
    saveBlob(
      blob,
      `${baseFileName(selectedVideoFile())}.${activeLang()}.${format}`,
    )
  }

  function downloadAllTracks() {
    const format = selectedSubtitleFormat()
    const stem = baseFileName(selectedVideoFile())
    const files = Object.entries(allSegmentsByLang())
      .filter(([, segments]) => segments.length)
      .map(([lang, segments]) => ({
        name: `${stem}.${lang}.${format}`,
        content: buildSubtitleFile(segments, format, stem),
      }))
    if (!files.length) return
    saveBlob(createStoredZip(files), `${stem}.subtitles.zip`)
  }

  function handleKeyboardShortcut(event: KeyboardEvent) {
    if (!ui.stageEditor.hidden && ui.exportModal.hidden) {
      const key = event.key.toLowerCase()

      if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) {
        if (isTextInputTarget(event.target)) return

        const wantsRedo = key === "y" || (key === "z" && event.shiftKey)
        event.preventDefault()
        if (wantsRedo) redo()
        else undo()
        return
      }

      if (event.key === " " && !isTextInputTarget(event.target)) {
        event.preventDefault()
        if (ui.video.paused) ui.video.play().catch(() => {})
        else ui.video.pause()
        return
      }

      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !isTextInputTarget(event.target)
      ) {
        const duration = ui.video.duration
        if (!Number.isFinite(duration)) return
        event.preventDefault()
        const step = event.shiftKey ? 5 : 1
        const delta = event.key === "ArrowRight" ? step : -step
        ui.video.currentTime = Math.max(
          0,
          Math.min(duration, (ui.video.currentTime || 0) + delta),
        )
      }
    }
  }

  function wireEditorStage() {
    ui.backBtn.addEventListener("click", backToConfig)
    ui.undoBtn?.addEventListener("click", undo)
    ui.redoBtn?.addEventListener("click", redo)
    ui.downloadSrtBtn.addEventListener("click", downloadSrt)
    ui.downloadAllTracksBtn.addEventListener("click", downloadAllTracks)
    document.addEventListener("keydown", handleKeyboardShortcut)
  }

  return {
    enableExports,
    backToConfig,
    downloadSrt,
    downloadAllTracks,
    wireEditorStage,
  }
}
