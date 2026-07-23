/**
 * Short-lived HMAC tokens for media proxy URLs.
 * Prevents the Worker from becoming an open SSRF proxy.
 */

const encoder = new TextEncoder();

export type ProxyPayload = {
  /** Target URL returned by Cobalt (tunnel or redirect). */
  u: string;
  /** Suggested download filename. */
  n: string;
  /** Unix epoch seconds expiry. */
  exp: number;
};

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signProxyPayload(
  payload: ProxyPayload,
  secret: string,
): Promise<string> {
  const body = JSON.stringify(payload);
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${toBase64Url(encoder.encode(body))}.${toBase64Url(sig)}`;
}

export async function verifyProxyToken(
  token: string,
  secret: string,
): Promise<ProxyPayload | null> {
  const [bodyB64, sigB64] = token.split(".");
  if (!bodyB64 || !sigB64) return null;

  try {
    const bodyBytes = fromBase64Url(bodyB64);
    const sigBytes = fromBase64Url(sigB64);
    const key = await importHmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      bodyBytes,
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as ProxyPayload;
    if (
      typeof payload.u !== "string" ||
      typeof payload.n !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp * 1000 < Date.now()) return null;

    const target = new URL(payload.u);
    // http(s) for Cobalt tunnels; file: for local yt-dlp temp downloads only
    // (proxy handlers must still enforce path allowlists for file URLs).
    if (
      target.protocol !== "http:" &&
      target.protocol !== "https:" &&
      target.protocol !== "file:"
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function defaultProxySecret(env: {
  MEDIA_PROXY_SECRET?: string;
  COBALT_API_KEY?: string;
  COBALT_API_URL?: string;
}): string {
  return (
    env.MEDIA_PROXY_SECRET ||
    env.COBALT_API_KEY ||
    env.COBALT_API_URL ||
    "dev-insecure-media-proxy-secret"
  );
}
