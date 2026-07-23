import type { SubtitleSegment } from "@/scripts/subtitles.ts"
import {
  alignOcrToAsr,
  characterErrorRate,
  type OcrAlignmentResult,
  type OcrObservation,
} from "@/scripts/ocrAlignment.ts"

type OcrOptions = {
  onProgress?: (completed: number, total: number, status?: string) => void
  maxCues?: number
}

type ProbeResult = {
  text: string
  confidence: number
}

type SubtitleCropBand = {
  id: "top" | "middle" | "bottom"
  y: number
  height: number
}

const SUBTITLE_CROP_BANDS: SubtitleCropBand[] = [
  // Douyin reposts frequently letterbox captions in the top black bar.
  { id: "top", y: 0, height: 0.24 },
  { id: "middle", y: 0.28, height: 0.38 },
  { id: "bottom", y: 0.57, height: 0.35 },
]

const HAN_GLOBAL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu

function waitForEvent(target: EventTarget, event: string, errorEvent = "error") {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup()
      resolve()
    }
    const failed = () => {
      cleanup()
      reject(new Error(`Video ${event} failed`))
    }
    const cleanup = () => {
      target.removeEventListener(event, done)
      target.removeEventListener(errorEvent, failed)
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener(errorEvent, failed, { once: true })
  })
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.025) return
  const pending = waitForEvent(video, "seeked")
  video.currentTime = time
  await pending
}

function cleanOcrText(raw: string) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  if (!lines.length) return ""

  const scored = lines.map((line) => ({
    line,
    han: line.match(HAN_GLOBAL_RE)?.length || 0,
  }))
  scored.sort((a, b) => b.han - a.han || b.line.length - a.line.length)
  if (scored[0].han < 2) return ""

  // Keep the strongest Chinese run and drop OCR debris from borders/UI chrome
  // (pipes, underscores and short Latin fragments were otherwise persisted).
  const chineseRuns = scored[0].line.match(
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\d，。！？、：；“”‘’（）《》〈〉—…\s]+/gu,
  ) || []
  const bestRun = chineseRuns
    .map((line) => ({ line, han: line.match(HAN_GLOBAL_RE)?.length || 0 }))
    .sort((a, b) => b.han - a.han || b.line.length - a.line.length)[0]
  return bestRun?.han >= 2 ? bestRun.line.replace(/\s+/g, "").trim() : ""
}

function drawSubtitleCrop(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  band: SubtitleCropBand,
) {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  const cropX = Math.round(sourceWidth * 0.05)
  const cropY = Math.round(sourceHeight * band.y)
  const cropWidth = Math.round(sourceWidth * 0.9)
  const cropHeight = Math.round(sourceHeight * band.height)
  const scale = Math.min(2.25, Math.max(1, 1280 / Math.max(1, cropWidth)))
  canvas.width = Math.max(1, Math.round(cropWidth * scale))
  canvas.height = Math.max(1, Math.round(cropHeight * scale))
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("Canvas 2D is unavailable for OCR")

  context.drawImage(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  )

  // Grayscale + moderate contrast preserves white glyphs and their dark outline.
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const luminance =
      image.data[index] * 0.299 +
      image.data[index + 1] * 0.587 +
      image.data[index + 2] * 0.114
    const contrasted = Math.max(0, Math.min(255, (luminance - 128) * 1.45 + 128))
    image.data[index] = contrasted
    image.data[index + 1] = contrasted
    image.data[index + 2] = contrasted
  }
  context.putImageData(image, 0, 0)
}

function probeTimes(segment: SubtitleSegment, duration: number) {
  const start = Math.max(0, segment.start)
  const end = Math.min(duration, Math.max(start, segment.end))
  const span = Math.max(0, end - start)
  // Two samples recover caption changes inside a long ASR chunk. Very short
  // cues keep one sample so OCR does not double its cost unnecessarily.
  const ratios = span >= 1.15 ? [0.3, 0.72] : [0.5]
  return ratios.map((ratio) => start + span * ratio)
    .map((time) => Math.min(Math.max(0, time), Math.max(0, duration - 0.05)))
    .filter((time, index, values) => values.findIndex((value) => Math.abs(value - time) < 0.03) === index)
}

function hanCount(text: string) {
  return text.match(HAN_GLOBAL_RE)?.length || 0
}

/** Merge consecutive burned-in captions without duplicating repeated frames. */
export function mergeSequentialOcrTexts(texts: string[]) {
  const cleaned = texts.map(cleanOcrText).filter(Boolean)
  let merged = ""
  for (const text of cleaned) {
    if (!merged) {
      merged = text
      continue
    }
    if (merged.includes(text)) continue
    if (text.includes(merged)) {
      merged = text
      continue
    }

    const maxOverlap = Math.min(merged.length, text.length)
    let overlap = 0
    for (let size = maxOverlap; size >= 1; size -= 1) {
      if (merged.slice(-size) === text.slice(0, size)) {
        overlap = size
        break
      }
    }
    merged += text.slice(overlap)
  }
  return merged
}

async function recognizeCrop(
  worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  band: SubtitleCropBand,
): Promise<ProbeResult> {
  drawSubtitleCrop(video, canvas, band)
  const result = await worker.recognize(canvas)
  return {
    text: cleanOcrText(result.data.text),
    confidence: Number(result.data.confidence) || 0,
  }
}

async function detectSubtitleBand(
  worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  segments: SubtitleSegment[],
) {
  const probes = segments
    .filter((segment) => segment.end - segment.start >= 1.1 && hanCount(segment.text) >= 4)
    .slice(0, 2)
  if (!probes.length) return SUBTITLE_CROP_BANDS[2]

  const scores = new Map(SUBTITLE_CROP_BANDS.map((band) => [band.id, 0]))
  for (const segment of probes) {
    await seekVideo(video, (segment.start + segment.end) / 2)
    for (const band of SUBTITLE_CROP_BANDS) {
      const candidate = await recognizeCrop(worker, video, canvas, band)
      if (!candidate.text) continue
      const similarity = 1 - Math.min(1, characterErrorRate(segment.text, candidate.text))
      const score = hanCount(candidate.text) * 1.8 + candidate.confidence * 0.04 + similarity * 6
      scores.set(band.id, (scores.get(band.id) || 0) + score)
    }
  }

  return [...SUBTITLE_CROP_BANDS].sort(
    (a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0),
  )[0]
}

/** OCR burned-in Simplified Chinese captions and align them to ASR timing. */
export async function extractAndAlignChineseSubtitles(
  file: File,
  asrSegments: SubtitleSegment[],
  options: OcrOptions = {},
): Promise<OcrAlignmentResult & { observations: OcrObservation[] }> {
  if (typeof document === "undefined") {
    throw new Error("Chinese subtitle OCR is only available in the browser")
  }

  // Default cap keeps browser Tesseract usable; long videos should skip OCR
  // in the config stage rather than grinding hundreds of cues.
  const limitedSegments = asrSegments.slice(0, options.maxCues ?? 48)
  if (!limitedSegments.length) {
    const aligned = alignOcrToAsr(asrSegments, [])
    return { ...aligned, observations: [] }
  }

  const [{ createWorker, PSM }] = await Promise.all([import("tesseract.js")])
  const video = document.createElement("video")
  const canvas = document.createElement("canvas")
  const objectUrl = URL.createObjectURL(file)
  video.muted = true
  video.preload = "auto"
  video.playsInline = true
  video.src = objectUrl

  let worker: Awaited<ReturnType<typeof createWorker>> | null = null
  try {
    await waitForEvent(video, "loadedmetadata")
    worker = await createWorker(["chi_sim", "eng"], undefined, {
      logger(message: any) {
        if (message?.status) options.onProgress?.(0, limitedSegments.length, message.status)
      },
    })
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      preserve_interword_spaces: "1",
    })

    const detectedBand = await detectSubtitleBand(
      worker,
      video,
      canvas,
      limitedSegments,
    )

    const observations: OcrObservation[] = []
    for (let index = 0; index < limitedSegments.length; index += 1) {
      const segment = limitedSegments[index]
      let best: ProbeResult = { text: "", confidence: 0 }
      const probes: ProbeResult[] = []

      for (const time of probeTimes(segment, video.duration)) {
        await seekVideo(video, time)
        const candidate = await recognizeCrop(
          worker,
          video,
          canvas,
          detectedBand,
        )
        if (candidate.text) probes.push(candidate)
        if (
          candidate.text &&
          (!best.text ||
            characterErrorRate(segment.text, candidate.text) <
              characterErrorRate(segment.text, best.text) ||
            candidate.confidence > best.confidence + 15)
        ) {
          best = candidate
        }
      }

      const mergedText = mergeSequentialOcrTexts(probes.map((probe) => probe.text))
      if (mergedText) {
        const merged: ProbeResult = {
          text: mergedText,
          confidence: probes.length
            ? probes.reduce((sum, probe) => sum + probe.confidence, 0) / probes.length
            : 0,
        }
        if (
          !best.text ||
          characterErrorRate(segment.text, merged.text) <
            characterErrorRate(segment.text, best.text)
        ) {
          best = merged
        }
      }

      if (best.text) {
        observations.push({
          start: segment.start,
          end: segment.end,
          text: best.text,
          confidence: best.confidence,
        })
      }
      options.onProgress?.(index + 1, limitedSegments.length, "recognizing text")
    }

    const aligned = alignOcrToAsr(asrSegments, observations)
    return {
      ...aligned,
      report: {
        ...aligned.report,
        detectedBand: detectedBand.id,
        observations: observations.length,
      },
      observations,
    }
  } finally {
    await worker?.terminate()
    video.removeAttribute("src")
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
