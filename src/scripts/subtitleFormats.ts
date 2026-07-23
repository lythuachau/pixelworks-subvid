import {
  buildSrt,
  formatSrtTime,
  type SubtitleSegment,
} from "./subtitles.ts"

export type SubtitleFormat = "srt" | "vtt" | "ass" | "txt"

function speakerPrefix(segment: SubtitleSegment) {
  return segment.speaker ? `[${segment.speaker}] ` : ""
}

function withSpeakerText(segment: SubtitleSegment) {
  return `${speakerPrefix(segment)}${segment.text}`.trim()
}

function formatVttTime(seconds: number) {
  return formatSrtTime(seconds).replace(",", ".")
}

function formatAssTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const cs = Math.floor((safe - Math.floor(safe)) * 100)
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`
}

function escapeAss(value: string) {
  return String(value || "")
    .replace(/\r?\n/g, "\\N")
    .replace(/\{/g, "\\{")
}

export function buildVtt(segments: SubtitleSegment[]) {
  const cues = segments.map(
    (segment, index) =>
      `${index + 1}\n${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n${withSpeakerText(segment)}`,
  )
  return `WEBVTT\n\n${cues.join("\n\n")}`
}

export function buildAss(segments: SubtitleSegment[], title = "subvid.app") {
  const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const events = segments.map((segment) =>
    `Dialogue: 0,${formatAssTime(segment.start)},${formatAssTime(segment.end)},Default,${segment.speaker || ""},0,0,0,,${escapeAss(segment.text)}`,
  )
  return `${header}\n${events.join("\n")}`
}

export function buildTxt(segments: SubtitleSegment[]) {
  return segments
    .map((segment) => {
      const clock = formatVttTime(segment.start).replace(/^00:/, "")
      return `[${clock}] ${withSpeakerText(segment)}`
    })
    .join("\n")
}

export function buildSubtitleFile(
  segments: SubtitleSegment[],
  format: SubtitleFormat,
  title = "subvid.app",
) {
  if (format === "vtt") return buildVtt(segments)
  if (format === "ass") return buildAss(segments, title)
  if (format === "txt") return buildTxt(segments)
  return buildSrt(
    segments.map((segment) => ({
      ...segment,
      text: withSpeakerText(segment),
    })),
  )
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    date:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  }
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true)
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true)
}

export function createStoredZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder()
  const entries = files.map((file) => {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.content)
    return { name, data, crc: crc32(data), ...dosDateTime() }
  })
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.name.length + entry.data.length)
    const localView = new DataView(local.buffer)
    write32(localView, 0, 0x04034b50)
    write16(localView, 4, 20)
    write16(localView, 10, entry.time)
    write16(localView, 12, entry.date)
    write32(localView, 14, entry.crc)
    write32(localView, 18, entry.data.length)
    write32(localView, 22, entry.data.length)
    write16(localView, 26, entry.name.length)
    local.set(entry.name, 30)
    local.set(entry.data, 30 + entry.name.length)
    localChunks.push(local)

    const central = new Uint8Array(46 + entry.name.length)
    const centralView = new DataView(central.buffer)
    write32(centralView, 0, 0x02014b50)
    write16(centralView, 4, 20)
    write16(centralView, 6, 20)
    write16(centralView, 12, entry.time)
    write16(centralView, 14, entry.date)
    write32(centralView, 16, entry.crc)
    write32(centralView, 20, entry.data.length)
    write32(centralView, 24, entry.data.length)
    write16(centralView, 28, entry.name.length)
    write32(centralView, 42, offset)
    central.set(entry.name, 46)
    centralChunks.push(central)
    offset += local.length
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, 0x06054b50)
  write16(endView, 8, entries.length)
  write16(endView, 10, entries.length)
  write32(endView, 12, centralSize)
  write32(endView, 16, offset)

  return new Blob([...localChunks, ...centralChunks, end], {
    type: "application/zip",
  })
}
