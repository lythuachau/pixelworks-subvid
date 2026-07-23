import { baseFileName } from "@/scripts/file.ts"
import {
  deleteStoredProject,
  listStoredProjects,
  loadStoredProject,
  saveStoredProject,
  type ProjectState,
} from "@/scripts/projectStore.ts"
import {
  analyzeSubtitleTracks,
  type QualityIssue,
} from "@/scripts/qualityChecks.ts"

type CommonOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
}

function showModal(element: HTMLElement) {
  element.hidden = false
  document.body.classList.add("modal-open")
}

function hideModal(element: HTMLElement) {
  element.hidden = true
  if (!document.querySelector(".utility-modal:not([hidden]), .export-modal:not([hidden])")) {
    document.body.classList.remove("modal-open")
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function createProjectController(
  options: CommonOptions & {
    getState: () => ProjectState
    restoreState: (state: ProjectState, file: File | null) => Promise<void> | void
    selectedMedia: () => File | null
  },
) {
  const { ui, tt } = options
  let projectId = ""
  let projectName = ""
  let createdAt = 0
  let autosaveTimer = 0
  let saving: Promise<void> | null = null

  function beginProject(file: File) {
    projectId = crypto.randomUUID()
    projectName = baseFileName(file)
    createdAt = Date.now()
    ui.projectName.value = projectName
  }

  async function saveNow(explicit = true) {
    if (!projectId) {
      const file = options.selectedMedia()
      projectId = crypto.randomUUID()
      projectName = file ? baseFileName(file) : tt("project.untitled")
      createdAt = Date.now()
    }
    projectName =
      ui.projectName.value.trim() || projectName || tt("project.untitled")
    ui.projectName.value = projectName
    ui.projectStatus.textContent = explicit ? "…" : tt("project.autosaved")
    const run = async () => {
      await saveStoredProject({
        id: projectId,
        name: projectName,
        state: options.getState(),
        media: options.selectedMedia(),
        createdAt,
      })
      ui.projectStatus.textContent = explicit
        ? tt("project.saved")
        : `${tt("project.autosaved")} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    }
    try {
      saving = (saving || Promise.resolve()).then(run)
      await saving
    } catch (error) {
      console.error("[project] save", error)
      ui.projectStatus.textContent = tt("project.saveFailed")
      ui.projectStatus.dataset.kind = "error"
    } finally {
      saving = null
    }
  }

  function scheduleAutosave() {
    if (!projectId) return
    window.clearTimeout(autosaveTimer)
    autosaveTimer = window.setTimeout(() => saveNow(false), 900)
  }

  async function renderProjectList() {
    const projects = await listStoredProjects()
    if (!projects.length) {
      ui.projectList.innerHTML = `<p class="utility-empty">${escapeHtml(tt("project.empty"))}</p>`
      return
    }
    ui.projectList.innerHTML = projects
      .map(
        (project) => `
          <article class="project-item" data-project-id="${escapeHtml(project.id)}">
            <div><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(new Date(project.updatedAt).toLocaleString())}${project.mediaName ? ` · ${escapeHtml(project.mediaName)}` : ""}</small></div>
            <div class="project-item-actions">
              <button type="button" class="btn-ghost project-open-item">${escapeHtml(tt("project.open"))}</button>
              <button type="button" class="btn-ghost project-delete-item">${escapeHtml(tt("project.delete"))}</button>
            </div>
          </article>`,
      )
      .join("")
  }

  async function openModal() {
    const media = options.selectedMedia()
    ui.projectName.value =
      projectName || (media ? baseFileName(media) : tt("project.untitled"))
    ui.projectStatus.textContent = ""
    showModal(ui.projectModal)
    try {
      await renderProjectList()
    } catch (error) {
      console.error("[project] list", error)
      ui.projectStatus.textContent = tt("project.loadFailed")
    }
  }

  function closeModal() {
    hideModal(ui.projectModal)
  }

  async function openProject(id: string) {
    ui.projectStatus.textContent = "…"
    try {
      const { project, file } = await loadStoredProject(id)
      projectId = project.id
      projectName = project.name
      createdAt = project.createdAt
      ui.projectName.value = projectName
      await options.restoreState(project.state, file)
      closeModal()
    } catch (error) {
      console.error("[project] open", error)
      ui.projectStatus.textContent = tt("project.loadFailed")
    }
  }

  function wire() {
    ui.projectOpenBtn.addEventListener("click", openModal)
    ui.uploadProjectOpenBtn.addEventListener("click", openModal)
    ui.projectSaveBtn.addEventListener("click", () => saveNow(true))
    ui.projectSaveCurrent.addEventListener("click", async () => {
      await saveNow(true)
      await renderProjectList()
    })
    ui.projectClose.addEventListener("click", closeModal)
    ui.projectBackdrop.addEventListener("click", closeModal)
    ui.projectList.addEventListener("click", async (event: Event) => {
      const target = event.target as HTMLElement
      const item = target.closest<HTMLElement>("[data-project-id]")
      if (!item) return
      const id = item.dataset.projectId || ""
      if (target.closest(".project-open-item")) await openProject(id)
      if (target.closest(".project-delete-item")) {
        await deleteStoredProject(id)
        if (id === projectId) projectId = ""
        await renderProjectList()
      }
    })
  }

  return { beginProject, closeModal, openModal, saveNow, scheduleAutosave, wire }
}

export function createQualityController(
  options: CommonOptions & {
    getTracks: () => Record<string, any[]>
    focusCue: (lang: string, index: number) => void
  },
) {
  const { ui, tt } = options
  let issues: QualityIssue[] = []

  function refresh() {
    issues = analyzeSubtitleTracks(options.getTracks())
    ui.qualityIssueCount.textContent = String(issues.length)
    ui.qualityIssueCount.hidden = issues.length === 0
    return issues
  }

  function issuesForCue(lang: string, index: number) {
    return issues.filter((issue) => issue.lang === lang && issue.index === index)
  }

  function render() {
    refresh()
    const errors = issues.filter((issue) => issue.severity === "error").length
    const warnings = issues.length - errors
    ui.qualitySummary.textContent = issues.length
      ? tt("quality.summary", { errors, warnings })
      : tt("quality.clean")
    ui.qualityList.innerHTML = issues
      .map((issue) => {
        const vars = {
          value: issue.value == null ? "" : issue.value.toFixed(1),
          limit: issue.limit == null ? "" : issue.limit,
        }
        return `<button type="button" class="quality-item is-${issue.severity}" data-lang="${escapeHtml(issue.lang)}" data-index="${issue.index}"><strong>${escapeHtml(issue.lang.toUpperCase())} · #${issue.index + 1}</strong><span>${escapeHtml(tt(`quality.${issue.code}`, vars))}</span></button>`
      })
      .join("")
  }

  function open() {
    render()
    showModal(ui.qualityModal)
  }

  function close() {
    hideModal(ui.qualityModal)
  }

  function wire() {
    ui.qualityCheckBtn.addEventListener("click", open)
    ui.qualityClose.addEventListener("click", close)
    ui.qualityBackdrop.addEventListener("click", close)
    ui.qualityList.addEventListener("click", (event: Event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-lang][data-index]")
      if (!item) return
      close()
      options.focusCue(item.dataset.lang || "", Number(item.dataset.index))
    })
  }

  return { close, issuesForCue, refresh, getIssues: () => issues, wire }
}

export function createCompareController(
  options: CommonOptions & {
    getState: () => {
      detectedLang: string
      activeLang: string
      orderedLangs: string[]
      segmentsByLang: Record<string, any[]>
    }
    issueIndices: () => number[]
    retranslateIndices: (indices: number[]) => Promise<number>
    updateTargetText: (lang: string, index: number, text: string) => void
    cancelTranslation: () => void
  },
) {
  const { ui, tt } = options
  let targetLang = ""

  function selectedIndices() {
    return [...ui.compareList.querySelectorAll<HTMLInputElement>(".compare-select:checked")]
      .map((input) => Number(input.dataset.index))
      .filter(Number.isFinite)
  }

  function render() {
    const state = options.getState()
    targetLang =
      state.activeLang !== state.detectedLang
        ? state.activeLang
        : state.orderedLangs.find((lang) => lang !== state.detectedLang) || ""
    if (!targetLang) {
      ui.compareSubtitle.textContent = tt("compare.unavailable")
      ui.compareList.innerHTML = ""
      ui.compareRetranslate.disabled = true
      return false
    }
    const source = state.segmentsByLang[state.detectedLang] || []
    const target = state.segmentsByLang[targetLang] || []
    ui.compareSubtitle.textContent = `${state.detectedLang.toUpperCase()} → ${targetLang.toUpperCase()}`
    ui.compareList.innerHTML = source
      .map(
        (cue, index) => `<div class="compare-row"><input class="compare-select" type="checkbox" data-index="${index}" aria-label="${escapeHtml(tt("cueSelect"))}" /><span class="compare-index">${index + 1}</span><div class="compare-source">${escapeHtml(cue.text)}</div><textarea class="compare-target" data-index="${index}" rows="2">${escapeHtml(target[index]?.text || "")}</textarea></div>`,
      )
      .join("")
    ui.compareRetranslate.disabled = false
    return true
  }

  function open() {
    render()
    ui.compareStatus.textContent = ""
    showModal(ui.compareModal)
  }

  function close() {
    hideModal(ui.compareModal)
  }

  async function retranslate() {
    const indices = selectedIndices()
    if (!indices.length) return
    ui.compareRetranslate.disabled = true
    ui.compareCancel.hidden = false
    ui.compareStatus.textContent = tt("compare.translating", { n: indices.length })
    try {
      const count = await options.retranslateIndices(indices)
      ui.compareStatus.textContent = tt("compare.done", { n: count })
      render()
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") console.error("[compare] translate", error)
      ui.compareStatus.textContent = tt("compare.failed")
    } finally {
      ui.compareCancel.hidden = true
      ui.compareRetranslate.disabled = false
    }
  }

  function wire() {
    ui.compareOpenBtn.addEventListener("click", open)
    ui.compareClose.addEventListener("click", close)
    ui.compareBackdrop.addEventListener("click", close)
    ui.compareSelectIssues.addEventListener("click", () => {
      const issueSet = new Set(options.issueIndices())
      for (const input of ui.compareList.querySelectorAll<HTMLInputElement>(".compare-select")) {
        input.checked = issueSet.has(Number(input.dataset.index))
      }
    })
    ui.compareRetranslate.addEventListener("click", retranslate)
    ui.compareCancel.addEventListener("click", options.cancelTranslation)
    ui.compareList.addEventListener("change", (event: Event) => {
      const target = event.target as HTMLTextAreaElement
      if (!target.classList.contains("compare-target")) return
      options.updateTargetText(targetLang, Number(target.dataset.index), target.value)
    })
  }

  return { close, open, render, wire }
}
