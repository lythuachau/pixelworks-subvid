/** Shared host allowlists for Douyin / TikTok / YouTube link import. */

export type MediaService = "douyin" | "tiktok" | "youtube";

const DOUYIN_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "v.douyin.com",
  "www.v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
]);

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "www.vm.tiktok.com",
  "www.vt.tiktok.com",
]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "music.youtube.com",
  "www.music.youtube.com",
]);

/** Loose URL matcher used when users paste share text with surrounding copy. */
const URL_IN_TEXT_RE =
  /https?:\/\/[^\s<>"')\]]+/gi;

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function detectMediaService(hostname: string): MediaService | null {
  const host = normalizeHostname(hostname);
  if (DOUYIN_HOSTS.has(host) || host.endsWith(".douyin.com")) return "douyin";
  if (TIKTOK_HOSTS.has(host) || host.endsWith(".tiktok.com")) return "tiktok";
  if (
    YOUTUBE_HOSTS.has(host) ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  ) {
    return "youtube";
  }
  return null;
}

/**
 * Extract the first supported media URL from free-form paste text
 * (Douyin share cards often include Chinese copy around the link).
 */
export function extractSupportedMediaUrl(text: string): {
  url: string;
  service: MediaService;
} | null {
  const raw = text.trim();
  if (!raw) return null;

  const candidates: string[] = [];
  try {
    const direct = new URL(raw);
    candidates.push(direct.href);
  } catch {
    // not a bare URL — fall through to regex extraction
  }

  for (const match of raw.matchAll(URL_IN_TEXT_RE)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/g, "");
    candidates.push(cleaned);
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const service = detectMediaService(parsed.hostname);
      if (service) {
        parsed.hash = "";
        return { url: parsed.toString(), service };
      }
    } catch {
      // ignore invalid candidates
    }
  }

  return null;
}

export function serviceLabel(service: MediaService): string {
  switch (service) {
    case "douyin":
      return "Douyin";
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
  }
}
