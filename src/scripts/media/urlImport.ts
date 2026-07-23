import {
  extractSupportedMediaUrl,
  serviceLabel,
  type MediaService,
} from "@/lib/mediaHosts.ts";

export type UrlImportProgress = {
  phase: "resolving" | "downloading";
  percent: number | null;
};

export type UrlImportResult = {
  file: File;
  service: MediaService;
  filename: string;
};

export type UrlImportErrorCode =
  | "invalid"
  | "unsupported"
  | "failed"
  | "tooLarge"
  | "notConfigured"
  | "pickerUnsupported"
  | "serverUnavailable"
  | "busy";

export class UrlImportError extends Error {
  code: UrlImportErrorCode;

  constructor(code: UrlImportErrorCode, message?: string) {
    super(message || code);
    this.name = "UrlImportError";
    this.code = code;
  }
}

type ResolveSuccess = {
  ok: true;
  service: MediaService;
  filename: string;
  downloadPath: string;
  contentType?: string;
};

type ResolveFailure = {
  ok: false;
  error?: string;
  message?: string;
};

function mapServerError(error?: string): UrlImportErrorCode {
  switch (error) {
    case "invalid":
      return "invalid";
    case "unsupported":
      return "unsupported";
    case "not_configured":
      return "notConfigured";
    case "picker_unsupported":
      return "pickerUnsupported";
    case "too_large":
      return "tooLarge";
    case "rate_limited":
      return "failed";
    default:
      return "failed";
  }
}

async function resolveMediaUrl(url: string): Promise<ResolveSuccess> {
  let response: Response;
  try {
    response = await fetch("/api/media/resolve", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new UrlImportError("serverUnavailable");
  }

  if (response.status === 404 || response.status === 405) {
    throw new UrlImportError("serverUnavailable");
  }

  let data: ResolveSuccess | ResolveFailure;
  try {
    data = (await response.json()) as ResolveSuccess | ResolveFailure;
  } catch {
    throw new UrlImportError(
      response.ok ? "failed" : "serverUnavailable",
    );
  }

  if (!data.ok) {
    throw new UrlImportError(mapServerError(data.error), data.message);
  }

  if (!data.downloadPath) {
    throw new UrlImportError("failed");
  }

  return data;
}

async function downloadToFile(
  downloadPath: string,
  filename: string,
  contentType: string | undefined,
  onProgress?: (progress: UrlImportProgress) => void,
): Promise<File> {
  let response: Response;
  try {
    response = await fetch(downloadPath, {
      method: "GET",
      headers: { Accept: "*/*" },
    });
  } catch {
    throw new UrlImportError("serverUnavailable");
  }

  if (!response.ok) {
    let code: UrlImportErrorCode = "failed";
    try {
      const err = (await response.json()) as ResolveFailure;
      code = mapServerError(err.error);
    } catch {
      if (response.status === 413) code = "tooLarge";
      if (response.status === 503) code = "notConfigured";
      if (response.status === 404) code = "serverUnavailable";
    }
    throw new UrlImportError(code);
  }

  const totalHeader =
    response.headers.get("Content-Length") ||
    response.headers.get("Estimated-Content-Length");
  const total = totalHeader ? Number(totalHeader) : NaN;
  const hasTotal = Number.isFinite(total) && total > 0;

  if (!response.body) {
    const blob = await response.blob();
    return new File([blob], filename, {
      type: contentType || blob.type || "video/mp4",
      lastModified: Date.now(),
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({
      phase: "downloading",
      percent: hasTotal
        ? Math.min(99, Math.round((received / total) * 100))
        : null,
    });
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const type =
    contentType ||
    response.headers.get("Content-Type") ||
    "video/mp4";

  return new File([bytes], filename, {
    type: type.split(";")[0].trim() || "video/mp4",
    lastModified: Date.now(),
  });
}

/**
 * Resolve a Douyin / TikTok / YouTube paste (or bare URL) into a local File.
 */
export async function importMediaFromUrl(
  pasteText: string,
  onProgress?: (progress: UrlImportProgress) => void,
): Promise<UrlImportResult> {
  const extracted = extractSupportedMediaUrl(pasteText);
  if (!extracted) {
    const raw = pasteText.trim();
    if (raw) {
      try {
        // If we can parse *a* URL but it's not allowlisted → unsupported
        const maybe = raw.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0];
        if (maybe) {
          const host = new URL(maybe).hostname;
          if (host) throw new UrlImportError("unsupported");
        }
      } catch (error) {
        if (error instanceof UrlImportError) throw error;
      }
    }
    throw new UrlImportError("invalid");
  }

  onProgress?.({ phase: "resolving", percent: null });
  const resolved = await resolveMediaUrl(extracted.url);

  onProgress?.({ phase: "downloading", percent: null });
  const file = await downloadToFile(
    resolved.downloadPath,
    resolved.filename,
    resolved.contentType,
    onProgress,
  );

  return {
    file,
    service: resolved.service || extracted.service,
    filename: resolved.filename || file.name,
  };
}

export function formatServiceName(service: MediaService): string {
  return serviceLabel(service);
}
