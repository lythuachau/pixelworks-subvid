/**
 * Keep the legacy filename parameter ASCII-only for Node/Undici and older
 * clients. RFC 5987's filename* carries the original Unicode name using only
 * percent-encoded ASCII bytes.
 */
export function contentDisposition(filename: string): string {
  const safeName = filename.replace(/[\r\n]/g, "_").trim() || "video.mp4"
  const asciiName =
    safeName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 180) || "video.mp4"
  const encodedName = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
}
