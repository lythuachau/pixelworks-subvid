/**
 * Shared network guard for every outbound fetch built from user input.
 *
 * Two jobs:
 *  - `isInternalHost` rejects loopback / private / link-local targets so an
 *    endpoint field can never be pointed at infrastructure.
 *  - `isAllowedMediaHost` is the allowlist the media proxy re-checks on every
 *    hop, so a signed token can only ever reach a known CDN.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
])

const BLOCKED_SUFFIXES = [
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".onion",
]

/**
 * Parse the IPv4 spellings that `fetch()` accepts but humans rarely write:
 * dotted quad, bare decimal (2130706433), hex (0x7f000001), octal
 * (0177.0.0.1) and the short forms (127.1). Returns the 32-bit value.
 */
function parseIpv4(host: string): number | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    if (!part) return null
    let value: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16)
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8)
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10)
    else return null
    if (!Number.isFinite(value) || value < 0) return null
    values.push(value)
  }

  // The last part absorbs the remaining bytes: 127.1 === 127.0.0.1
  const last = values[values.length - 1]
  const leading = values.slice(0, -1)
  const remainingBytes = 4 - leading.length
  if (last >= 2 ** (8 * remainingBytes)) return null
  if (leading.some((value) => value > 255)) return null

  let result = last
  for (let index = 0; index < leading.length; index += 1) {
    result += leading[index] * 2 ** (8 * (3 - index))
  }
  return result >>> 0
}

function isPrivateIpv4(value: number): boolean {
  const a = (value >>> 24) & 0xff
  const b = (value >>> 16) & 0xff
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  )
}

function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (address === "::" || address === "::1") return true
  // IPv4-mapped / IPv4-compatible forms smuggle a v4 target through v6 syntax.
  const mapped = address.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const value = parseIpv4(mapped[1])
    return value === null || isPrivateIpv4(value)
  }
  return (
    /^f[cd][0-9a-f]{2}:/.test(address) || // unique local fc00::/7
    /^fe[89ab][0-9a-f]:/.test(address) // link-local fe80::/10
  )
}

/** True when the hostname must never be fetched from server code. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!host) return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (host.includes(":") || host.startsWith("[")) return isPrivateIpv6(host)
  const ipv4 = parseIpv4(host)
  if (ipv4 !== null) return isPrivateIpv4(ipv4)
  return false
}

export class BlockedEndpointError extends Error {}

/**
 * Validate an operator-supplied API endpoint. Returns the normalized origin
 * (no trailing slash, no trailing `/v1`) or throws `BlockedEndpointError`.
 */
export function assertPublicHttpsEndpoint(value: unknown): string {
  const endpoint = String(value || "").trim().replace(/\/+$/, "")
  if (!endpoint) return ""

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new BlockedEndpointError("Endpoint không phải URL hợp lệ.")
  }
  if (parsed.protocol !== "https:") {
    throw new BlockedEndpointError("Endpoint phải dùng HTTPS.")
  }
  if (isInternalHost(parsed.hostname)) {
    throw new BlockedEndpointError("Endpoint nội bộ hoặc IP riêng không được phép.")
  }
  return endpoint.replace(/\/v1$/i, "")
}

/**
 * CDN hosts the media proxy is allowed to stream from. Cobalt tunnels come
 * back on the configured Cobalt origin; everything else is a first-party CDN
 * for one of the three supported services.
 */
const MEDIA_HOST_SUFFIXES = [
  // Douyin / TikTok / ByteDance
  "douyin.com",
  "douyinvod.com",
  "douyinpic.com",
  "douyinstatic.com",
  "iesdouyin.com",
  "snssdk.com",
  "byteicdn.com",
  "bytedance.com",
  "bytedanceapi.com",
  "ibytedtos.com",
  "ipstatp.com",
  "pstatp.com",
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokv.com",
  "tiktokv.us",
  "muscdn.com",
  "musical.ly",
  // YouTube
  "googlevideo.com",
  "youtube.com",
  "youtu.be",
  "ytimg.com",
  "ggpht.com",
]

function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * The proxy re-checks this on the initial URL *and* on every redirect hop, so
 * a CDN that 302s off-allowlist cannot turn the Worker into an open proxy.
 */
export function isAllowedMediaHost(
  hostname: string,
  cobaltHost: string | undefined,
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!host || isInternalHost(host)) return false
  if (cobaltHost && host === cobaltHost.trim().toLowerCase()) return true
  return MEDIA_HOST_SUFFIXES.some((suffix) => matchesSuffix(host, suffix))
}

export function cobaltHostname(cobaltApiUrl: string | undefined): string {
  try {
    return new URL(String(cobaltApiUrl || "")).hostname.toLowerCase()
  } catch {
    return ""
  }
}
