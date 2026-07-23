import { createDownloadsController } from "@/scripts/downloads.ts";
import { createApiInspectorController } from "@/scripts/apiInspector.ts";
import { installDevtoolsGuard } from "@/scripts/devtoolsGuard.ts";
import { createEditorHistory } from "@/scripts/editorHistory.ts";
import { createEditorSegmentsController } from "@/scripts/editorSegments.ts";
import { createExportModal } from "@/scripts/export/exportModal.ts";
import { createVideoExporter } from "@/scripts/export/videoExport.ts";
import { baseFileName, prettifyBytes } from "@/scripts/file.ts";
import { I18N, langName, tt } from "@/scripts/i18n.ts";
import { createStageManager } from "@/scripts/stageManager.ts";
import { createConfigStageController } from "@/scripts/stages/configStage.ts";
import { createEditorStageController } from "@/scripts/stages/editorStage.ts";
import { createUploadStageController } from "@/scripts/stages/uploadStage.ts";
import { createSubtitleStyleController } from "@/scripts/subtitleStyle.ts";
import { createTimelineController } from "@/scripts/timeline.ts";
import { createTranslationService } from "@/scripts/translation.ts";
import { ui } from "@/scripts/ui.ts";
import {
  createCompareController,
  createProjectController,
  createQualityController,
} from "@/scripts/workspaceControllers.ts";

type Segment = { start: number; end: number; text: string; speaker?: string };
type SegmentsByLang = Record<string, Segment[]>;
type VisibleTrack = {
  lang: string;
  label: string;
  role: "default" | "transcription" | "subtitles";
  segments: Segment[];
  hidden?: boolean;
  locked?: boolean;
};
type TrackState = { hidden?: boolean; locked?: boolean };

const {
  downloads,
  renderDownloads,
  updateDownloadStatus,
  fetchWithProgress,
} = createDownloadsController({
  ui,
  tt,
  prettifyBytes,
});

// ── State ──
let selectedVideoFile: File | null = null
let videoObjectUrl = ""
let detectedLang = ""
let baseSegments: Segment[] = []
let segmentsByLang: SegmentsByLang = {}
let orderedLangs: string[] = []
let activeLang = ""
let dualTrackMode = false
let dualTrackLangs: string[] = []
let trackStates: Record<string, TrackState> = {}
let exporting = false

const { setStage } = createStageManager({ ui });
let translationService: ReturnType<typeof createTranslationService>;
let historyController: ReturnType<typeof createEditorHistory<SegmentsByLang>>;
let editorStageController: ReturnType<typeof createEditorStageController>;
let subtitleStyleController: ReturnType<typeof createSubtitleStyleController>;
let uploadStageController: ReturnType<typeof createUploadStageController>;
let projectController: ReturnType<typeof createProjectController>;
let qualityController: ReturnType<typeof createQualityController>;
let compareController: ReturnType<typeof createCompareController>;

const translateSegments = (
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
  options?: { signal?: AbortSignal },
) => translationService.translateSegments(segments, sourceLang, targetLang, options);

const isTranslationReady = () => translationService.isTranslationReady()

function currentSegments(): Segment[] {
  return segmentsByLang[activeLang] || [];
}

function trackLabel(lang: string) {
  if (dualTrackMode && lang === detectedLang)
    return tt("tracks.transcription", { lang: langName(lang) });
  if (dualTrackMode && dualTrackLangs.includes(lang))
    return tt("tracks.subtitles", { lang: langName(lang) });
  return langName(lang);
}

function trackRole(lang: string): VisibleTrack["role"] {
  if (dualTrackMode && lang === detectedLang) return "transcription";
  if (dualTrackMode && dualTrackLangs.includes(lang)) return "subtitles";
  return "default";
}

function visibleTrackLangs() {
  const langs =
    dualTrackMode && dualTrackLangs.includes(activeLang)
      ? dualTrackLangs
      : [activeLang];
  return langs.filter((lang, index) => lang && langs.indexOf(lang) === index);
}

function trackState(lang: string) {
  return trackStates[lang] || {};
}

function visibleTracks(): VisibleTrack[] {
  return visibleTrackLangs()
    .map((lang) => ({
      lang,
      label: trackLabel(lang),
      role: trackRole(lang),
      segments: segmentsByLang[lang] || [],
      hidden: !!trackState(lang).hidden,
      locked: !!trackState(lang).locked,
    }))
    .filter((track) => track.segments.length);
}

function currentVideoSegments(): any[] {
  const tracks = visibleTracks().filter((track) => !track.hidden);
  return tracks.length ? tracks : [];
}

function resetEditorState() {
  detectedLang = "";
  baseSegments = [];
  segmentsByLang = {};
  orderedLangs = [];
  activeLang = "";
  dualTrackMode = false;
  dualTrackLangs = [];
  trackStates = {};
}

function snapshotSegments() {
  return historyController.snapshotSegments();
}

function pushHistory(snapshotBefore: string) {
  historyController.pushHistory(snapshotBefore);
  qualityController?.refresh();
  projectController?.scheduleAutosave();
}

function resetHistory() {
  historyController.resetHistory();
}

function enableExports(on: boolean) {
  editorStageController.enableExports(on);
}

function syncActiveCaptionStyle() {
  subtitleStyleController?.setActiveTrack(trackRole(activeLang), activeLang);
}

let editorSegmentsController: any;
const { renderTimeline, highlightSegment, updateCaption } =
  createTimelineController({
    ui,
    tt,
    currentSegments,
    visibleTracks,
    activeLang: () => activeLang,
    setActiveLang: (lang) => {
      activeLang = lang;
      syncActiveCaptionStyle();
    },
    renderTabs: () => editorSegmentsController.renderTabs(),
    renderCaptions: (tracks, time) =>
      subtitleStyleController?.renderCaptions(tracks, time),
    toggleTrackHidden: (lang) => {
      const before = snapshotSegments();
      trackStates[lang] = {
        ...trackState(lang),
        hidden: !trackState(lang).hidden,
      };
      pushHistory(before);
      renderTimeline();
      updateCaption();
    },
    toggleTrackLocked: (lang) => {
      const before = snapshotSegments();
      trackStates[lang] = {
        ...trackState(lang),
        locked: !trackState(lang).locked,
      };
      pushHistory(before);
      renderTimeline();
      updateCaption();
    },
    snapshotSegments,
    pushHistory,
    renderSegments: () => editorSegmentsController.renderSegments(),
    enableExports,
  });
editorSegmentsController = createEditorSegmentsController({
  ui,
  tt,
  langName,
  getState: () => ({
    detectedLang,
    baseSegments,
    segmentsByLang,
    orderedLangs,
    activeLang,
    dualTrackMode,
    dualTrackLangs,
    trackStates,
  }),
  setActiveLang: (lang) => {
    activeLang = lang;
    syncActiveCaptionStyle();
  },
  setOrderedLangs: (langs) => {
    orderedLangs = langs;
  },
  setSegmentsForLang: (lang, segments) => {
    segmentsByLang[lang] = segments;
  },
  trackLabel,
  translateSegments,
  isTranslationReady,
  snapshotSegments,
  pushHistory,
  renderTimeline,
  highlightSegment,
  updateCaption,
  enableExports,
  onProjectChanged: () => {
    qualityController?.refresh();
    projectController?.scheduleAutosave();
  },
  qualityIssuesForCue: (lang, index) =>
    qualityController?.issuesForCue(lang, index) || [],
});
const {
  addLanguage,
  buildLangSelects,
  populateAddLang,
  renderSegments,
  renderTabs,
  setLangAddStatus,
  wireSegmentEditor,
} = editorSegmentsController;
subtitleStyleController = createSubtitleStyleController({ ui, I18N });
const {
  applyCaptionStyle,
  renderPresets,
  syncStyleControls,
  wireStyleControls,
} = subtitleStyleController;
const exportModal = createExportModal({ ui, tt, isExporting: () => exporting });
const { closeExportModal } = exportModal;

editorStageController = createEditorStageController({
  ui,
  currentSegments,
  allSegmentsByLang: () => segmentsByLang,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  isExporting: () => exporting,
  setStage,
  undo: () => historyController.undo(),
  redo: () => historyController.redo(),
});

historyController = createEditorHistory<SegmentsByLang>({
  getState: () => ({
    segmentsByLang,
    orderedLangs,
    activeLang,
    dualTrackMode,
    dualTrackLangs,
    trackStates,
  }),
  restoreState: (state) => {
    segmentsByLang = state.segmentsByLang || {};
    orderedLangs = state.orderedLangs || Object.keys(segmentsByLang);
    activeLang = state.activeLang || orderedLangs[0] || "";
    if (!segmentsByLang[activeLang])
      activeLang = orderedLangs[0] || Object.keys(segmentsByLang)[0] || "";
    dualTrackMode = !!state.dualTrackMode;
    dualTrackLangs = state.dualTrackLangs || [];
    trackStates = state.trackStates || {};
  },
  refreshButtons: (canUndo, canRedo) => {
    if (ui.undoBtn) ui.undoBtn.disabled = !canUndo;
    if (ui.redoBtn) ui.redoBtn.disabled = !canRedo;
  },
  onRestore: () => {
    syncActiveCaptionStyle();
    renderTabs();
    renderSegments();
    enableExports(true);
    updateCaption();
    qualityController?.refresh();
    projectController?.scheduleAutosave();
  },
});

const configStageController = createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  translateSegments,
  cancelTranslation: () => translationService?.cancelActiveTranslations(),
  selectedVideoFile: () => selectedVideoFile,
  isExporting: () => exporting,
  setGeneratedState: (state) => {
    detectedLang = state.detectedLang;
    baseSegments = state.baseSegments;
    segmentsByLang = state.segmentsByLang;
    orderedLangs = state.orderedLangs;
    activeLang = state.activeLang;
    // Debug hook for automated timing/text alignment checks (dev only).
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as any).__subvidDebug = {
        detectedLang,
        baseSegments,
        segmentsByLang,
        orderedLangs,
        activeLang,
        dualTrackMode: state.dualTrackMode,
        dualTrackLangs: state.dualTrackLangs,
        ocrQuality: state.ocrQuality,
      };
    }
    dualTrackMode = state.dualTrackMode;
    dualTrackLangs = state.dualTrackLangs;
    trackStates = {};
    syncActiveCaptionStyle();
    window.setTimeout(() => {
      qualityController?.refresh();
      projectController?.scheduleAutosave();
    }, 0);
  },
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
});

translationService = createTranslationService({
  downloads,
  renderDownloads,
  updateDownloadStatus,
  tt,
  langName,
  setStatus: configStageController.setStatus,
});

uploadStageController = createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus: configStageController.setStatus,
  setProgress: configStageController.setProgress,
  isExporting: () => exporting,
  getVideoObjectUrl: () => videoObjectUrl,
  setVideoObjectUrl: (url) => {
    videoObjectUrl = url;
  },
  setSelectedVideoFile: (file) => {
    selectedVideoFile = file;
  },
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
  resetTranscriptionCache: () =>
    configStageController.resetTranscriptionCache(),
  onNewProject: (file) => projectController?.beginProject(file),
});

qualityController = createQualityController({
  ui,
  tt,
  getTracks: () => segmentsByLang,
  focusCue: (lang, index) => editorSegmentsController.focusCue(lang, index),
});

compareController = createCompareController({
  ui,
  tt,
  getState: () => ({ detectedLang, activeLang, orderedLangs, segmentsByLang }),
  issueIndices: () => editorSegmentsController.issueCueIndices(),
  retranslateIndices: (indices) =>
    editorSegmentsController.retranslateIndices(indices),
  updateTargetText: (lang, index, text) => {
    const segment = segmentsByLang[lang]?.[index];
    if (!segment || segment.text === text) return;
    const before = snapshotSegments();
    segment.text = text;
    pushHistory(before);
    renderSegments();
    updateCaption();
  },
  cancelTranslation: () => translationService.cancelActiveTranslations(),
});

projectController = createProjectController({
  ui,
  tt,
  selectedMedia: () => selectedVideoFile,
  getState: () => ({
    version: 1,
    editor: {
      detectedLang,
      baseSegments,
      segmentsByLang,
      orderedLangs,
      activeLang,
      dualTrackMode,
      dualTrackLangs,
      trackStates,
    },
    settings: {
      inputLang: ui.inputLang.value,
      outputLang: ui.outputLang.value,
      subtitleFormat: ui.subtitleFormat.value,
    },
    styles: subtitleStyleController.getProjectState(),
  }),
  restoreState: async (storedState, file) => {
    const state = storedState as any;
    const editor = state.editor || state;
    uploadStageController.restoreSelectedFile(file);
    detectedLang = editor.detectedLang || "";
    baseSegments = editor.baseSegments || [];
    segmentsByLang = editor.segmentsByLang || {};
    orderedLangs = editor.orderedLangs || Object.keys(segmentsByLang);
    activeLang = editor.activeLang || orderedLangs[0] || "";
    dualTrackMode = !!editor.dualTrackMode;
    dualTrackLangs = editor.dualTrackLangs || [];
    trackStates = editor.trackStates || {};

    const settings = state.settings || {};
    if (settings.inputLang != null) ui.inputLang.value = settings.inputLang;
    if (settings.outputLang != null) ui.outputLang.value = settings.outputLang;
    if (settings.subtitleFormat) ui.subtitleFormat.value = settings.subtitleFormat;
    ui.inputLang.dispatchEvent(new Event("change"));
    if (state.styles) subtitleStyleController.restoreProjectState(state.styles);

    syncActiveCaptionStyle();
    renderTabs();
    renderSegments();
    resetHistory();
    enableExports(true);
    ui.addSegBtn.disabled = !activeLang;
    setStage("editor");
    updateCaption();
    qualityController.refresh();
  },
});

const { downloadVideo, cancelExport } = createVideoExporter({
  ui,
  tt,
  currentSegments: currentVideoSegments,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  baseFileName: () => baseFileName(selectedVideoFile),
  isExporting: () => exporting,
  setExporting: (value) => {
    exporting = value;
  },
  enableExports,
  setStatus: configStageController.setStatus,
  modal: exportModal,
  remuxAudioToAacLc: configStageController.remuxAudioToAacLc,
});

// ── Init ──
installDevtoolsGuard(ui.devtoolsGuardToast, tt("devtoolsBlocked"));
createApiInspectorController().wire();
buildLangSelects();
renderDownloads();
renderPresets();
syncStyleControls();
applyCaptionStyle();
wireStyleControls();
wireSegmentEditor();
// Marks media tooling ready; ASR/model warmup was removed and never runs here.
configStageController.preloadAssetsInBackground();
setStage("upload");
uploadStageController.wireUploadStage();
configStageController.wireConfigStage();
editorStageController.wireEditorStage();
projectController.wire();
qualityController.wire();
compareController.wire();
ui.app.addEventListener("change", () => projectController.scheduleAutosave());
ui.langAddSelect?.addEventListener("change", () => {
  const target = ui.langAddSelect.value;
  if (target) addLanguage(target);
});
ui.downloadVideoBtn.addEventListener("click", downloadVideo);
ui.exportCancel.addEventListener("click", cancelExport);
ui.exportClose.addEventListener("click", closeExportModal);
ui.exportBackdrop.addEventListener("click", closeExportModal);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!ui.exportModal.hidden) closeExportModal();
  if (!ui.projectModal.hidden) projectController.closeModal();
  if (!ui.qualityModal.hidden) qualityController.close();
  if (!ui.compareModal.hidden) compareController.close();
});
ui.downloadsToggle.addEventListener("click", () => {
  const opening = ui.downloadsPanel.hidden;
  ui.downloadsPanel.hidden = !opening;
  // The panel header already shows the status, so drop the dock label while open.
  ui.statusDock?.classList.toggle("panel-open", opening);
});
