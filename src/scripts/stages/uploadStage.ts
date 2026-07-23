import { prettifyBytes } from "@/scripts/file.ts";
import {
  formatServiceName,
  importMediaFromUrl,
  UrlImportError,
  type UrlImportProgress,
} from "@/scripts/media/urlImport.ts";
import type { Stage } from "@/scripts/stageManager.ts";
import type { ui as appUi } from "@/scripts/ui.ts";

type UploadStageOptions = {
  ui: typeof appUi;
  tt: (path: string, vars?: Record<string, unknown>) => string;
  setStage: (stage: Stage) => void;
  setStatus: (message: string, kind?: string) => void;
  setProgress: (percent: number) => void;
  isExporting: () => boolean;
  getVideoObjectUrl: () => string;
  setVideoObjectUrl: (url: string) => void;
  setSelectedVideoFile: (file: File | null) => void;
  resetEditorState: () => void;
  setLangAddStatus: (message: string, kind?: string) => void;
  populateAddLang: () => void;
  renderSegments: () => void;
  enableExports: (on: boolean) => void;
  resetHistory: () => void;
  resetTranscriptionCache: () => void;
  onNewProject?: (file: File) => void;
};

function isVideoFile(file: File) {
  return (
    file.type.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv)$/i.test(file.name)
  );
}

function isAudioFile(file: File) {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|flac|wma|opus)$/i.test(file.name)
  );
}

function isMediaFile(file: File) {
  return isVideoFile(file) || isAudioFile(file);
}

export function createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus,
  setProgress,
  isExporting,
  getVideoObjectUrl,
  setVideoObjectUrl,
  setSelectedVideoFile,
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
  resetTranscriptionCache,
  onNewProject,
}: UploadStageOptions) {
  let dragDepth = 0;
  let unsupportedTimer: number | undefined;
  let urlImportBusy = false;
  const dropzoneCopy = {
    defaultLabel:
      ui.dropzone.dataset.defaultLabel || ui.dropzoneLabel.textContent || "",
    defaultHint:
      ui.dropzone.dataset.defaultHint || ui.dropzoneHint.textContent || "",
    unsupportedLabel:
      ui.dropzone.dataset.unsupportedLabel ||
      ui.dropzoneLabel.textContent ||
      "",
    unsupportedHint:
      ui.dropzone.dataset.unsupportedHint || ui.dropzoneHint.textContent || "",
  };

  function setUrlStatus(message: string, kind: "" | "ok" | "error" = "") {
    if (!ui.urlStatus) return;
    ui.urlStatus.textContent = message;
    ui.urlStatus.classList.toggle("is-ok", kind === "ok");
    ui.urlStatus.classList.toggle("is-error", kind === "error");
  }

  function setUrlProgress(progress: UrlImportProgress | null) {
    if (!ui.urlProgress || !ui.urlProgressFill || !ui.urlProgressPct) return;

    if (!progress) {
      ui.urlProgress.hidden = true;
      ui.urlProgress.classList.remove("is-indeterminate");
      ui.urlProgressFill.style.width = "0%";
      ui.urlProgressPct.textContent = "0%";
      return;
    }

    ui.urlProgress.hidden = false;
    if (progress.percent == null) {
      ui.urlProgress.classList.add("is-indeterminate");
      ui.urlProgressFill.style.width = "35%";
      ui.urlProgressPct.textContent = "…";
      return;
    }

    ui.urlProgress.classList.remove("is-indeterminate");
    const pct = Math.max(0, Math.min(100, progress.percent));
    ui.urlProgressFill.style.width = `${pct}%`;
    ui.urlProgressPct.textContent = `${pct}%`;
  }

  function setUrlImportLoading(loading: boolean) {
    urlImportBusy = loading;
    if (ui.urlSubmit) ui.urlSubmit.disabled = loading;
    if (ui.urlInput) ui.urlInput.disabled = loading;
  }

  function urlImportErrorMessage(error: unknown): string {
    if (error instanceof UrlImportError) {
      switch (error.code) {
        case "invalid":
          return tt("urlImport.invalid");
        case "unsupported":
          return tt("urlImport.unsupported");
        case "tooLarge":
          return tt("urlImport.tooLarge");
        case "notConfigured":
          return tt("urlImport.notConfigured");
        case "pickerUnsupported":
          return tt("urlImport.pickerUnsupported");
        case "serverUnavailable":
          return tt("urlImport.serverUnavailable");
        case "busy":
          return tt("urlImport.busy");
        default:
          return tt("urlImport.failed");
      }
    }
    return tt("urlImport.failed");
  }

  async function handleUrlImportSubmit(event: Event) {
    event.preventDefault();
    if (urlImportBusy) {
      setUrlStatus(tt("urlImport.busy"), "error");
      return;
    }
    if (isExporting()) return;

    const pasteText = ui.urlInput?.value?.trim() || "";
    if (!pasteText) {
      setUrlStatus(tt("urlImport.invalid"), "error");
      ui.urlInput?.focus();
      return;
    }

    setUrlImportLoading(true);
    setUrlStatus(tt("urlImport.resolving"));
    setUrlProgress({ phase: "resolving", percent: null });

    try {
      const result = await importMediaFromUrl(pasteText, (progress) => {
        setUrlProgress(progress);
        if (progress.phase === "resolving") {
          setUrlStatus(tt("urlImport.resolving"));
        } else if (progress.percent == null) {
          setUrlStatus(tt("urlImport.downloadingIndeterminate"));
        } else {
          setUrlStatus(
            tt("urlImport.downloading", { pct: String(progress.percent) }),
          );
        }
      });

      setUrlProgress({ phase: "downloading", percent: 100 });
      setUrlStatus(
        tt("urlImport.videoLoadedFrom", {
          service: formatServiceName(result.service),
        }),
        "ok",
      );
      handleSelectedFile(result.file);
      if (ui.urlInput) ui.urlInput.value = "";
      setUrlProgress(null);
    } catch (error) {
      setUrlProgress(null);
      setUrlStatus(urlImportErrorMessage(error), "error");
    } finally {
      setUrlImportLoading(false);
    }
  }

  function getDraggedFileSupport(dataTransfer: DataTransfer | null) {
    const [file] = Array.from(dataTransfer?.files || []);
    if (file) return isMediaFile(file);

    const [item] = Array.from(dataTransfer?.items || []).filter(
      (dataTransferItem) => dataTransferItem.kind === "file",
    );
    if (!item) return null;
    if (item.type)
      return item.type.startsWith("video/") || item.type.startsWith("audio/");

    const itemFile = item.getAsFile();
    return itemFile ? isMediaFile(itemFile) : null;
  }

  function clearUnsupportedTimer() {
    if (!unsupportedTimer) return;
    window.clearTimeout(unsupportedTimer);
    unsupportedTimer = undefined;
  }

  function setDropzoneCopy(isUnsupported: boolean) {
    ui.dropzoneLabel.textContent = isUnsupported
      ? dropzoneCopy.unsupportedLabel
      : dropzoneCopy.defaultLabel;
    ui.dropzoneHint.textContent = isUnsupported
      ? dropzoneCopy.unsupportedHint
      : dropzoneCopy.defaultHint;
  }

  function resetDropzoneState() {
    clearUnsupportedTimer();
    ui.dropzone.classList.remove("over", "is-unsupported");
    ui.app.classList.remove("is-dragging", "is-dragging-unsupported");
    ui.dropzone.removeAttribute("aria-invalid");
    setDropzoneCopy(false);
  }

  function showSupportedDrag() {
    clearUnsupportedTimer();
    ui.dropzone.classList.add("over");
    ui.dropzone.classList.remove("is-unsupported");
    ui.app.classList.add("is-dragging");
    ui.app.classList.remove("is-dragging-unsupported");
    ui.dropzone.removeAttribute("aria-invalid");
    setDropzoneCopy(false);
  }

  function showUnsupportedFile({ dragging = false, persist = false } = {}) {
    clearUnsupportedTimer();
    ui.dropzone.classList.toggle("over", dragging);
    ui.dropzone.classList.add("is-unsupported");
    ui.app.classList.toggle("is-dragging", dragging);
    ui.app.classList.toggle("is-dragging-unsupported", dragging);
    ui.dropzone.setAttribute("aria-invalid", "true");
    setDropzoneCopy(true);

    if (persist) {
      unsupportedTimer = window.setTimeout(resetDropzoneState, 2400);
    }
  }

  function attachMediaFile(file: File) {
    const isAudio = isAudioFile(file);
    const previousUrl = getVideoObjectUrl();
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    const videoObjectUrl = URL.createObjectURL(file);
    setSelectedVideoFile(file);
    setVideoObjectUrl(videoObjectUrl);
    ui.video.src = videoObjectUrl;
    ui.video.load();
    ui.configVideo.src = videoObjectUrl;
    ui.configVideo.load();

    // Hide video elements and export options for audio-only files
    // Keep preview containers visible so subtitles can be displayed
    if (isAudio) {
      ui.configPreview.style.display = "none";
      ui.video.style.display = "none"; // Hide video element but keep container
      ui.downloadVideoBtn.style.display = "none";
      ui.exportFormat.closest("label")?.setAttribute("style", "display: none");
      ui.exportQuality.closest("label")?.setAttribute("style", "display: none");
    } else {
      ui.configPreview.style.display = "";
      ui.video.style.display = "";
      ui.downloadVideoBtn.style.display = "";
      ui.exportFormat.closest("label")?.removeAttribute("style");
      ui.exportQuality.closest("label")?.removeAttribute("style");
    }

    const metaText = `${file.name} · ${prettifyBytes(file.size)}`;
    ui.meta.textContent = metaText;
    ui.configMeta.textContent = metaText;
  }

  function handleSelectedFile(file?: File) {
    if (!file) return;
    if (!isMediaFile(file)) {
      showUnsupportedFile({ persist: true });
      ui.input.value = "";
      return;
    }

    resetDropzoneState();
    resetTranscriptionCache();
    attachMediaFile(file);

    resetEditorState();
    ui.langTabs.innerHTML = "";
    setLangAddStatus("");
    populateAddLang();
    renderSegments();
    ui.addSegBtn.disabled = true;
    enableExports(false);
    resetHistory();
    ui.generationTime.hidden = true;
    ui.generationTime.textContent = "";

    ui.outputLang.value = "same";
    ui.inputLang.value = "";
    setStatus(tt("videoLoaded"), "ok");
    setProgress(0);
    ui.configProgress.hidden = true;
    ui.configError.hidden = true;
    ui.configError.textContent = "";
    setStage("config");
    onNewProject?.(file);
  }

  function restoreSelectedFile(file: File | null) {
    resetTranscriptionCache();
    if (file) {
      attachMediaFile(file);
      setStatus(tt("videoLoaded"), "ok");
      return;
    }

    const previousUrl = getVideoObjectUrl();
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setVideoObjectUrl("");
    setSelectedVideoFile(null);
    ui.video.removeAttribute("src");
    ui.video.load();
    ui.configVideo.removeAttribute("src");
    ui.configVideo.load();
    ui.downloadVideoBtn.style.display = "none";
    ui.meta.textContent = "";
    ui.configMeta.textContent = "";
  }

  function resetFlow() {
    if (isExporting()) return;

    const videoObjectUrl = getVideoObjectUrl();
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
      setVideoObjectUrl("");
    }

    setSelectedVideoFile(null);
    resetTranscriptionCache();
    resetEditorState();
    ui.langTabs.innerHTML = "";
    ui.generationTime.hidden = true;
    ui.generationTime.textContent = "";
    setLangAddStatus("");
    populateAddLang();
    ui.caption.textContent = "";
    ui.video.removeAttribute("src");
    ui.video.load();
    ui.configVideo.removeAttribute("src");
    ui.configVideo.load();
    enableExports(false);
    resetHistory();
    setStage("upload");
  }

  function attachGlobalDrop() {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes("Files");

    document.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      const isSupported = getDraggedFileSupport(event.dataTransfer);
      if (isSupported === false) showUnsupportedFile({ dragging: true });
      else showSupportedDrag();
    });
    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const isSupported = getDraggedFileSupport(event.dataTransfer);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isSupported === false ? "none" : "copy";
      }
      if (isSupported === false) showUnsupportedFile({ dragging: true });
      else showSupportedDrag();
    });
    document.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) resetDropzoneState();
    });
    document.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      resetDropzoneState();
      handleSelectedFile(event.dataTransfer?.files?.[0]);
    });
  }

  function wireUploadStage() {
    attachGlobalDrop();
    ui.dropzone.addEventListener("click", () => ui.input.click());
    ui.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        ui.input.click();
      }
    });
    ui.input.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement | null;
      handleSelectedFile(target?.files?.[0]);
    });
    ui.configBackBtn.addEventListener("click", resetFlow);

    // URL form lives next to the dropzone; stop clicks from bubbling oddly
    // and wire submit + progressive enable of the Analyze button.
    ui.urlImport?.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    ui.urlImportForm?.addEventListener("submit", handleUrlImportSubmit);
    ui.urlInput?.addEventListener("input", () => {
      if (ui.urlStatus?.classList.contains("is-error")) {
        setUrlStatus("");
      }
    });
  }

  return {
    handleSelectedFile,
    restoreSelectedFile,
    resetFlow,
    attachGlobalDrop,
    wireUploadStage,
  };
}
