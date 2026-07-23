/**
 * Cookie-free Douyin resolve via the public share page (_ROUTER_DATA).
 * Works for v.douyin.com short links and www.douyin.com/video/{id}.
 */

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

export type DouyinResolved = {
  videoId: string;
  mediaUrl: string;
  filename: string;
  title?: string;
};

function unescapeUrl(value: string): string {
  return value
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

/** Prefer no-watermark play URL when Douyin still serves it. */
export function preferNoWatermark(url: string): string {
  return url.replace("/playwm/", "/play/");
}

export function extractDouyinVideoId(inputUrl: string): string | null {
  try {
    const u = new URL(inputUrl);
    const fromPath = u.pathname.match(/\/video\/(\d+)/);
    if (fromPath?.[1]) return fromPath[1];
    const modal = u.searchParams.get("modal_id");
    if (modal && /^\d+$/.test(modal)) return modal;
  } catch {
    // ignore
  }
  return null;
}

async function expandShortLink(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return response.url || url;
}

function pickPlayUrl(item: Record<string, unknown>): string | null {
  const video = item.video as Record<string, unknown> | undefined;
  if (!video) return null;

  const candidates: unknown[] = [
    video.play_addr,
    video.play_addr_h264,
    video.download_addr,
    video.playAddr,
  ];

  // bit_rate[] often has higher quality variants
  const bitRates = video.bit_rate;
  if (Array.isArray(bitRates)) {
    for (const br of bitRates) {
      if (br && typeof br === "object") {
        candidates.push((br as Record<string, unknown>).play_addr);
      }
    }
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const list = (candidate as { url_list?: unknown }).url_list;
    if (!Array.isArray(list)) continue;
    const first = list.find((u) => typeof u === "string" && u.startsWith("http"));
    if (typeof first === "string") return preferNoWatermark(unescapeUrl(first));
  }
  return null;
}

function findItemList(node: unknown): Record<string, unknown>[] | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findItemList(item);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.item_list) && obj.item_list.length > 0) {
    return obj.item_list as Record<string, unknown>[];
  }
  for (const value of Object.values(obj)) {
    const found = findItemList(value);
    if (found) return found;
  }
  return null;
}

function parseRouterData(html: string): Record<string, unknown> | null {
  const match = html.match(
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/,
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a Douyin share/video URL to a direct media URL.
 */
export async function resolveDouyinMedia(
  inputUrl: string,
): Promise<DouyinResolved> {
  let pageUrl = inputUrl;
  let videoId = extractDouyinVideoId(inputUrl);

  // Short links (v.douyin.com/xxx) need redirect expansion
  if (!videoId || /v\.douyin\.com/i.test(inputUrl)) {
    pageUrl = await expandShortLink(inputUrl);
    videoId = extractDouyinVideoId(pageUrl) || videoId;
  }

  if (!videoId) {
    // Last resort: fetch original and parse final URL
    pageUrl = await expandShortLink(inputUrl);
    videoId = extractDouyinVideoId(pageUrl);
  }

  if (!videoId) {
    throw new Error("Could not extract Douyin video id from link");
  }

  const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
  const page = await fetch(shareUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Referer: "https://www.douyin.com/",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!page.ok) {
    throw new Error(`Douyin share page HTTP ${page.status}`);
  }

  const html = await page.text();
  const router = parseRouterData(html);
  if (!router) {
    throw new Error("Douyin share page missing _ROUTER_DATA");
  }

  const items = findItemList(router);
  const item = items?.[0];
  if (!item) {
    throw new Error("Douyin video metadata not found (private or deleted?)");
  }

  const mediaUrl = pickPlayUrl(item);
  if (!mediaUrl) {
    throw new Error("Douyin play address not found");
  }

  const desc =
    typeof item.desc === "string" && item.desc.trim()
      ? item.desc.trim().slice(0, 80)
      : "";
  const safe = desc
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return {
    videoId,
    mediaUrl,
    filename: safe ? `douyin-${videoId}-${safe}.mp4` : `douyin-${videoId}.mp4`,
    title: desc || undefined,
  };
}

export const DOUYIN_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": MOBILE_UA,
  Referer: "https://www.douyin.com/",
  Accept: "*/*",
};

/** Download resolved Douyin media to a Uint8Array (local use / size checks). */
export async function fetchDouyinBytes(
  mediaUrl: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(preferNoWatermark(mediaUrl), {
    headers: DOUYIN_FETCH_HEADERS,
    redirect: "follow",
  });

  if (!response.ok) {
    // Fallback to watermarked URL if no-watermark is blocked
    if (mediaUrl.includes("/play/")) {
      const wm = mediaUrl.replace("/play/", "/playwm/");
      return fetchDouyinBytes(wm, maxBytes);
    }
    throw new Error(`Douyin media HTTP ${response.status}`);
  }

  const len = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(len) && len > maxBytes) {
    throw new Error("too_large");
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error("too_large");
  }

  return {
    bytes: buffer,
    contentType: response.headers.get("Content-Type") || "video/mp4",
  };
}
