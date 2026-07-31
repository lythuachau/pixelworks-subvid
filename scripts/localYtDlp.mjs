/**
 * Local-only media resolve via yt-dlp (no Cobalt required).
 * Used by the Vite dev middleware when COBALT_API_URL is unset.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  extractSupportedMediaUrl,
  serviceLabel,
} from "../src/lib/mediaHosts.ts";
import {
  DOUYIN_FETCH_HEADERS,
  preferNoWatermark,
  resolveDouyinMedia,
} from "../src/server/douyinResolve.ts";
import {
  defaultProxySecret,
  signProxyPayload,
  verifyProxyToken,
} from "../src/server/mediaToken.ts";

const TEMP_PREFIX = "subvid-ytdlp-";
const PROXY_TTL_SECONDS = 30 * 60;
const DEFAULT_MAX_BYTES = 160_000_000;
// Stable for the lifetime of this local server process. A restart intentionally
// invalidates outstanding local download URLs.
const LOCAL_MEDIA_PROXY_SECRET = randomBytes(32).toString("hex");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function runYtDlp(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("yt-dlp", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`yt-dlp timed out\n${stderr || stdout}`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr || stdout || `yt-dlp exit ${code}`));
    });
  });
}

function maxBytes(env) {
  const n = Number(env.MEDIA_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function guessContentType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "video/mp4";
}

function isAllowedTempFile(filePath) {
  const resolved = resolve(filePath);
  const tempRoot = resolve(tmpdir());
  const relativePath = relative(tempRoot, resolved);
  const name = basename(resolved);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..\\`) &&
    !relativePath.startsWith("../") &&
    !isAbsolute(relativePath) &&
    name.startsWith(TEMP_PREFIX)
  );
}

function localProxySecret(env) {
  return defaultProxySecret({
    MEDIA_PROXY_SECRET:
      env.MEDIA_PROXY_SECRET || LOCAL_MEDIA_PROXY_SECRET,
  });
}

function tempStamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeTempFile(bytes, filenameHint) {
  const ext = filenameHint.includes(".")
    ? filenameHint.slice(filenameHint.lastIndexOf("."))
    : ".mp4";
  const filePath = join(tmpdir(), `${TEMP_PREFIX}${tempStamp()}${ext}`);
  await fs.writeFile(filePath, bytes);
  return {
    filePath: resolve(filePath),
    filename: basename(filePath),
    size: bytes.byteLength,
  };
}

/**
 * Download media with yt-dlp into os.tmpdir() and return absolute path + name.
 */
async function downloadWithYtDlp(mediaUrl) {
  const stamp = tempStamp();
  const outTemplate = join(tmpdir(), `${TEMP_PREFIX}${stamp}.%(ext)s`);

  const { stdout } = await runYtDlp([
    "--no-playlist",
    "--no-warnings",
    "-f",
    "best[height<=720]/best[height<=1080]/best",
    "-o",
    outTemplate,
    "--print",
    "after_move:filepath",
    "--print",
    "filepath",
    mediaUrl,
  ]);

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Prefer the last non-empty printed path that exists.
  let filePath = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i];
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath || !existsSync(filePath)) {
    // Fallback: glob the template prefix in tmpdir
    const entries = await fs.readdir(tmpdir());
    const match = entries.find((name) => name.startsWith(`${TEMP_PREFIX}${stamp}`));
    if (match) filePath = join(tmpdir(), match);
  }

  if (!filePath || !existsSync(filePath)) {
    throw new Error("yt-dlp finished but no output file was found");
  }

  const stat = await fs.stat(filePath);
  return {
    filePath: resolve(filePath),
    filename: basename(filePath),
    size: stat.size,
  };
}

/**
 * Cookie-free Douyin path: share page → play URL → temp file.
 */
async function downloadDouyinNative(mediaUrl, limit) {
  const resolved = await resolveDouyinMedia(mediaUrl);
  let response = await fetch(preferNoWatermark(resolved.mediaUrl), {
    headers: DOUYIN_FETCH_HEADERS,
    redirect: "follow",
  });
  if (!response.ok && resolved.mediaUrl.includes("/play/")) {
    response = await fetch(
      resolved.mediaUrl.replace("/play/", "/playwm/"),
      { headers: DOUYIN_FETCH_HEADERS, redirect: "follow" },
    );
  }
  if (!response.ok) {
    throw new Error(`Douyin media HTTP ${response.status}`);
  }

  const len = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(len) && len > limit) {
    const err = new Error("too_large");
    throw err;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new Error("too_large");
  }

  const saved = await writeTempFile(bytes, resolved.filename);
  return { ...saved, via: "douyin-native", title: resolved.title };
}

async function signedFileResponse(downloaded, service, env, via) {
  if (downloaded.size > maxBytes(env)) {
    await fs.unlink(downloaded.filePath).catch(() => {});
    return json(
      {
        ok: false,
        error: "too_large",
        message: "This video is too large to import.",
      },
      413,
    );
  }

  // file:///C:/... on Windows — proxy only serves temp files we created.
  let normalized = downloaded.filePath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  const fileUrl = `file://${normalized}`;
  const secret = localProxySecret(env);
  const token = await signProxyPayload(
    {
      u: fileUrl,
      n: downloaded.filename,
      exp: Math.floor(Date.now() / 1000) + PROXY_TTL_SECONDS,
    },
    secret,
  );

  return json({
    ok: true,
    service,
    filename: downloaded.filename,
    downloadPath: `/api/media/proxy?t=${encodeURIComponent(token)}`,
    contentType: guessContentType(downloaded.filename),
    via,
    serviceLabel: serviceLabel(service),
  });
}

export async function handleLocalYtDlpResolve(request, env = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid", message: "Invalid JSON body." }, 400);
  }

  const extracted = extractSupportedMediaUrl(String(body?.url || ""));
  if (!extracted) {
    return json(
      {
        ok: false,
        error: "invalid",
        message: "Paste a valid Douyin, TikTok, or YouTube link.",
      },
      400,
    );
  }

  const limit = maxBytes(env);

  // Douyin: native share-page resolve (no cookies / no yt-dlp)
  if (extracted.service === "douyin") {
    try {
      const downloaded = await downloadDouyinNative(extracted.url, limit);
      console.info(
        `[local-ytdlp] Douyin native ok → ${downloaded.filename} (${downloaded.size} bytes)`,
      );
      return signedFileResponse(downloaded, "douyin", env, "douyin-native");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[local-ytdlp] Douyin native failed, trying yt-dlp:", message);
      if (message === "too_large") {
        return json(
          {
            ok: false,
            error: "too_large",
            message: "This video is too large to import.",
          },
          413,
        );
      }
      // fall through to yt-dlp
    }
  }

  try {
    const downloaded = await downloadWithYtDlp(extracted.url);
    return signedFileResponse(downloaded, extracted.service, env, "yt-dlp");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[local-ytdlp] resolve failed:", message);
    if (/not recognized|ENOENT|spawn yt-dlp/i.test(message)) {
      return json(
        {
          ok: false,
          error: "not_configured",
          message:
            "Could not import this link. For Douyin, native resolve failed; install yt-dlp or set COBALT_API_URL.",
        },
        503,
      );
    }
    if (/Fresh cookies/i.test(message)) {
      return json(
        {
          ok: false,
          error: "failed",
          message:
            "This platform blocked the download (cookies required). Try another link or upload the file.",
        },
        502,
      );
    }
    return json(
      {
        ok: false,
        error: "failed",
        message:
          "Could not import this link. Try another URL or upload a file.",
      },
      502,
    );
  }
}

export async function handleLocalYtDlpProxy(request, env = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("t") || "";
  const secret = localProxySecret(env);
  const payload = await verifyProxyToken(token, secret, {
    allowFileProtocol: true,
  });
  if (!payload) {
    return json(
      {
        ok: false,
        error: "invalid_token",
        message: "Download link expired or invalid.",
      },
      403,
    );
  }

  // Local file produced by yt-dlp
  if (payload.u.startsWith("file://")) {
    let filePath = payload.u.slice("file://".length);
    // Windows: file:///C:/path → /C:/path — strip leading slash before drive
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
    filePath = resolve(filePath.replace(/\//g, "\\"));

    if (!isAllowedTempFile(filePath) || !existsSync(filePath)) {
      return json(
        { ok: false, error: "failed", message: "Local media file missing." },
        404,
      );
    }

    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes(env)) {
      return json(
        { ok: false, error: "too_large", message: "This video is too large." },
        413,
      );
    }

    const filename = payload.n || basename(filePath);
    const headers = new Headers({
      "Content-Type": guessContentType(filename),
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    });

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);
    // Best-effort cleanup after a while (client should finish download first)
    setTimeout(() => {
      fs.unlink(filePath).catch(() => {});
    }, 10 * 60 * 1000);

    return new Response(webStream, { status: 200, headers });
  }

  // Fallback: HTTP(S) URL (same as Cobalt tunnel) — stream via fetch
  try {
    const upstream = await fetch(payload.u, {
      headers: { Accept: "*/*", "User-Agent": "subvid-local-ytdlp/1.0" },
      redirect: "follow",
    });
    if (!upstream.ok || !upstream.body) {
      return json(
        {
          ok: false,
          error: "failed",
          message: `Upstream returned ${upstream.status}.`,
        },
        502,
      );
    }
    const headers = new Headers({
      "Content-Type":
        upstream.headers.get("Content-Type") ||
        guessContentType(payload.n || "video.mp4"),
      "Cache-Control": "no-store",
    });
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return json(
      { ok: false, error: "failed", message: "Upstream media fetch failed." },
      502,
    );
  }
}

export function hasYtDlpFallback() {
  return true;
}
