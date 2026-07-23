type DownloadsControllerOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
  prettifyBytes: (bytes: number) => string
}

const RING_C = 2 * Math.PI * 15.5

export function createDownloadsController({
  ui,
  tt,
  prettifyBytes,
}: DownloadsControllerOptions) {
  const downloads: any = {
    ffmpeg: {
      label: tt("downloads.ffmpeg"),
      state: "pending",
      progress: 0,
      loaded: 0,
      total: 0,
      speed: 0,
    },
    translation: {
      label: tt("downloads.translation"),
      state: "pending",
      progress: 0,
      loaded: 0,
      total: 0,
      speed: 0,
      pendingNote: tt("downloads.pendingNote"),
      readyNote: "",
    },
  }

  const STATE_LABEL = {
    error: tt("downloads.downloadFailed"),
  }

  function trackSpeed(item: any, loaded: number) {
    const now = performance.now()
    if (item._lastTime == null) {
      item._lastTime = now
      item._lastLoaded = loaded
      return
    }
    const dt = (now - item._lastTime) / 1000
    if (dt >= 0.35) {
      const inst = Math.max(0, (loaded - item._lastLoaded) / dt)
      item.speed = item.speed ? item.speed * 0.55 + inst * 0.45 : inst
      item._lastTime = now
      item._lastLoaded = loaded
    }
  }

  function updateDownloadStatus(key: string, state: string) {
    const item = downloads[key]
    if (!item) return
    item.state = state
    if (state === "ready") {
      item.progress = 100
      item.speed = 0
    }
    if (state === "error") {
      item.speed = 0
    }
    renderDownloads()
  }

  async function fetchWithProgress(
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal = 0,
  ) {
    const item = downloads[key]
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      const blob = await (await fetch(url)).blob()
      return URL.createObjectURL(new Blob([blob], { type: mimeType }))
    }
    const headerTotal = Number(response.headers.get("content-length")) || 0
    const partTotal = headerTotal || fallbackTotal
    item.total = (item._totalBase || 0) + partTotal
    const reader = response.body.getReader()
    const chunks = []
    let partLoaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      partLoaded += value.length
      item.loaded = (item._loadedBase || 0) + partLoaded
      item.progress = item.total
        ? Math.min(99, (item.loaded / item.total) * 100)
        : item.progress
      trackSpeed(item, item.loaded)
      renderDownloads()
    }
    item._loadedBase = (item._loadedBase || 0) + partLoaded
    item._totalBase = (item._totalBase || 0) + partTotal
    return URL.createObjectURL(new Blob(chunks, { type: mimeType }))
  }

  function downloadIcon(state: string) {
    if (state === "ready")
      return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    if (state === "error")
      return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`
    if (state === "downloading") return `<span class="spinner"></span>`
    return `<span class="dot"></span>`
  }

  function renderDownloads() {
    ui.downloadsList.innerHTML = ""
    Object.values(downloads).forEach((item: any) => {
      const pct = item.state === "ready" ? 100 : Math.round(item.progress)
      const sizeInfo =
        item.state === "ready" && item.total
          ? prettifyBytes(item.total)
          : item.total
            ? `${prettifyBytes(item.loaded)} / ${prettifyBytes(item.total)}`
            : ""
      const speedInfo =
        item.state === "downloading" && item.speed > 0
          ? `${prettifyBytes(item.speed)}/s`
          : ""
      const meta = [speedInfo, sizeInfo].filter(Boolean).join(" · ")
      const showTrack = item.state === "downloading"
      const footText =
        item.state === "pending"
          ? item.pendingNote || ""
          : item.state === "ready" && item.readyNote
            ? item.readyNote
            : item.state === "error"
              ? STATE_LABEL.error
              : meta
      const li = document.createElement("li")
      li.className = `item item-${item.state}`
      li.innerHTML = `
      <span class="item-icon">${downloadIcon(item.state)}</span>
      <div class="item-body">
        <div class="item-head">
          <strong>${item.label}</strong>
          ${
            item.state === "downloading"
              ? `<span class="item-pct">${pct}%</span>`
              : ""
          }
        </div>
        ${
          showTrack
            ? `<div class="dl-track${!item.total ? " is-indeterminate" : ""}">
                <div class="dl-fill" style="width:${pct}%"></div>
              </div>`
            : ""
        }
        ${footText ? `<span class="item-foot">${footText}</span>` : ""}
      </div>`
      ui.downloadsList.appendChild(li)
    })

    const tracked = Object.values(downloads).filter(
      (i: any) => i.state !== "pending",
    )
    const overall = tracked.length
      ? tracked.reduce(
          (acc: number, i: any) =>
            acc + (i.state === "ready" ? 100 : i.progress),
          0,
        ) / tracked.length
      : 0
    const allReady =
      tracked.length > 0 && tracked.every((i: any) => i.state === "ready")
    const hasError = Object.values(downloads).some(
      (i: any) => i.state === "error",
    )
    const liveCount = Object.values(downloads).filter(
      (i: any) => i.state === "downloading",
    ).length

    ui.downloadsRing.style.strokeDasharray = String(RING_C)
    ui.downloadsRing.style.strokeDashoffset = String(
      RING_C * (1 - overall / 100),
    )
    ui.downloadsPct.textContent = `${Math.round(overall)}%`

    ui.downloadsOverall.style.width = `${overall}%`
    ui.downloadsPanel.classList.toggle("is-ready", allReady)
    ui.downloadsPanel.classList.toggle("is-error", hasError)
    ui.downloadsToggle.classList.toggle("is-ready", allReady)
    ui.downloadsToggle.classList.toggle("is-error", hasError)
    ui.downloadsToggle.classList.toggle("is-busy", liveCount > 0 && !allReady)

    ui.downloadsSummary.textContent = allReady
      ? tt("downloads.allReady")
      : hasError
        ? tt("downloads.withErrors")
        : liveCount
          ? tt("downloads.inProgress", { n: liveCount })
          : ""

    const labelText = allReady
      ? tt("downloads.allReady")
      : hasError
        ? tt("downloads.downloadFailed")
        : liveCount
          ? tt("downloads.downloadInProgress")
          : tt("downloads.preparingModels")
    ui.downloadsLabel.textContent = labelText
    ui.downloadsLabel.dataset.state = allReady
      ? "ready"
      : hasError
        ? "error"
        : "busy"
  }

  return {
    downloads,
    renderDownloads,
    updateDownloadStatus,
    fetchWithProgress,
  }
}
