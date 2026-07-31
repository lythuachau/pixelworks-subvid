/**
 * Vite plugin: serve /api/media/* during local dev (no Cloudflare Worker).
 *
 * - If COBALT_API_URL is set → same Cobalt handlers as production Worker
 * - Else → yt-dlp local fallback (must be on PATH)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

function loadDotEnvFile() {
  const filePath = resolve(process.cwd(), ".env");
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(filePath)) return out;

  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function mediaEnvFromProcess() {
  const fileEnv = loadDotEnvFile();
  return {
    COBALT_API_URL:
      process.env.COBALT_API_URL || fileEnv.COBALT_API_URL || undefined,
    COBALT_API_KEY:
      process.env.COBALT_API_KEY || fileEnv.COBALT_API_KEY || undefined,
    MEDIA_PROXY_SECRET:
      process.env.MEDIA_PROXY_SECRET ||
      fileEnv.MEDIA_PROXY_SECRET ||
      undefined,
    MEDIA_MAX_BYTES:
      process.env.MEDIA_MAX_BYTES || fileEnv.MEDIA_MAX_BYTES || undefined,
    GROQ_API_KEY:
      process.env.GROQ_API_KEY || fileEnv.GROQ_API_KEY || undefined,
    GROQ_API_URL:
      process.env.GROQ_API_URL || fileEnv.GROQ_API_URL || undefined,
    GROQ_TRANSCRIBE_MODELS:
      process.env.GROQ_TRANSCRIBE_MODELS || fileEnv.GROQ_TRANSCRIBE_MODELS || undefined,
  };
}

async function readBody(req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks);
}

function toWebRequest(req, body) {
  const host = req.headers.host || "localhost:4321";
  const url = new URL(req.url || "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  /** @type {RequestInit} */
  const init = {
    method: req.method || "GET",
    headers,
  };

  const method = (req.method || "GET").toUpperCase();
  if (body && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }

  return new Request(url, init);
}

async function sendWebResponse(webResponse, res) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  if (!webResponse.body || (res.req?.method || "").toUpperCase() === "HEAD") {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(webResponse.body);
  await new Promise((resolvePromise, reject) => {
    nodeStream.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolvePromise);
    nodeStream.pipe(res);
  });
}

/**
 * @returns {import('vite').Plugin}
 */
export function localMediaApiPlugin() {
  return {
    name: "local-media-api",
    configureServer(server) {
      // Apply COOP/COEP on every dev response so FFmpeg WASM can use
      // SharedArrayBuffer. Vite `server.headers` alone is not always applied
      // to Astro document responses.
      server.middlewares.use((req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
        next();
      });

      const bootEnv = mediaEnvFromProcess();
      if (bootEnv.COBALT_API_URL) {
        console.info(
          `[local-media-api] Link import via Cobalt → ${bootEnv.COBALT_API_URL}`,
        );
      } else {
        console.info(
          "[local-media-api] Link import via local yt-dlp (set COBALT_API_URL in .env to use Cobalt instead)",
        );
      }

      console.info(
        "[local-media-api] Translate at /api/translate/* (Gemini + custom OpenAI/Anthropic)",
      );
      console.info("[local-media-api] Groq Whisper at /api/speech/transcribe");

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || "").split("?")[0];
        const isMedia =
          path === "/api/media/resolve" || path === "/api/media/proxy";
        const isTranslate =
          path === "/api/translate" ||
          path === "/api/translate/status" ||
          path === "/api/translate/models" ||
          path === "/api/translate/gemini/models" ||
          path === "/api/translate/cue-plan";
        const isSpeech = path === "/api/speech/transcribe";
        const isCuePlan = path === "/api/cue-plan";
        if (!isMedia && !isTranslate && !isSpeech && !isCuePlan) {
          next();
          return;
        }

        try {
          /** @type {Response | null} */
          let response = null;

          if (isCuePlan) {
            const body = await readBody(req);
            const request = toWebRequest(req, body);
            const cuePlan = await server.ssrLoadModule(
              "/scripts/localCuePlan.mjs",
            );
            response = await cuePlan.handleLocalCuePlan(request);
          } else if (isSpeech) {
            const env = mediaEnvFromProcess();
            const body = await readBody(req);
            const request = toWebRequest(req, body);
            const speech = await server.ssrLoadModule("/src/server/speechApi.ts");
            response = await speech.handleSpeechApi(request, {
              ...env,
              // This Vite service listens on loopback only. Public requests
              // reach it through Caddy's site-wide forward_auth gate.
              TRUSTED_LOCAL_REQUEST: true,
            });
          } else if (isTranslate) {
            const body = await readBody(req);
            const request = toWebRequest(req, body);
            const google = await server.ssrLoadModule(
              "/scripts/localGoogleTranslate.mjs",
            );
            const custom = await server.ssrLoadModule(
              "/scripts/localCustomTranslate.mjs",
            );

            if (path === "/api/translate/status") {
              const geminiStatus = await google
                .handleGoogleTranslateStatus()
                .then((r) => r.json());
              const customStatus = await custom
                .handleCustomTranslateStatus()
                .then((r) => r.json());
              response = new Response(
                JSON.stringify({
                  ok: !!(geminiStatus.ok || customStatus.ok),
                  gemini: geminiStatus,
                  custom: customStatus,
                  // Default engine preference when UI sends provider=auto
                  preferred: customStatus.ok
                    ? "custom"
                    : geminiStatus.ok
                      ? "gemini"
                      : "local",
                }),
                {
                  status: 200,
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                  },
                },
              );
            } else if (path === "/api/translate/gemini/models") {
              const translateApi = await server.ssrLoadModule(
                "/src/server/translateApi.ts",
              );
              response = await translateApi.handleTranslateApi(
                request,
                mediaEnvFromProcess(),
              );
            } else if (path === "/api/translate/models") {
              response = await custom.handleCustomTranslateModels(request);
            } else if (path === "/api/translate/cue-plan") {
              const translateApi = await server.ssrLoadModule(
                "/src/server/translateApi.ts",
              );
              response = await translateApi.handleTranslateApi(
                request,
                mediaEnvFromProcess(),
              );
            } else {
              // Route by provider in body (auto|gemini|custom)
              let provider = "auto";
              /** @type {any} */
              let parsedBody = {};
              try {
                parsedBody = body
                  ? JSON.parse(
                      Buffer.isBuffer(body)
                        ? body.toString("utf8")
                        : String(body),
                    )
                  : {};
                provider = String(parsedBody.provider || "auto").toLowerCase();
              } catch {
                provider = "auto";
              }

              const bodyHasCustom =
                !!(parsedBody.baseUrl || parsedBody.endpoint) &&
                !!(parsedBody.apiKey || parsedBody.key) &&
                !!parsedBody.model;
              const customReady =
                custom.isCustomTranslateConfigured() || bodyHasCustom;
              const geminiReady = google.isGoogleTranslateConfigured();

              if (provider === "custom") {
                response = await custom.handleCustomTranslate(request);
              } else if (provider === "gemini") {
                if (parsedBody.geminiApiKey) {
                  const translateApi = await server.ssrLoadModule(
                    "/src/server/translateApi.ts",
                  );
                  response = await translateApi.handleTranslateApi(
                    request,
                    mediaEnvFromProcess(),
                  );
                } else {
                  response = await google.handleGoogleTranslate(request);
                }
              } else if (customReady) {
                // auto: prefer custom gateway when configured (env or request)
                response = await custom.handleCustomTranslate(request);
              } else if (geminiReady) {
                response = await google.handleGoogleTranslate(request);
              } else {
                response = new Response(
                  JSON.stringify({
                    ok: false,
                    error: "not_configured",
                    message:
                      "No translation API configured. Set CUSTOM_TRANSLATE_* or GEMINI_API_KEY.",
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json; charset=utf-8",
                    },
                  },
                );
              }
            }
          } else {
            const env = mediaEnvFromProcess();
            const body = await readBody(req);
            const request = toWebRequest(req, body);

            if (env.COBALT_API_URL) {
              const mod = await server.ssrLoadModule("/src/server/mediaApi.ts");
              response = await mod.handleMediaApi(request, env);
            } else {
              // Local fallback — no Worker / Cobalt required
              const ytdlp = await server.ssrLoadModule(
                "/scripts/localYtDlp.mjs",
              );
              if (path === "/api/media/resolve") {
                response = await ytdlp.handleLocalYtDlpResolve(request, env);
              } else {
                response = await ytdlp.handleLocalYtDlpProxy(request, env);
              }
            }
          }

          if (!response) {
            next();
            return;
          }
          await sendWebResponse(response, res);
        } catch (error) {
          console.error("[local-media-api]", error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                error: "failed",
                message: "Local media API error.",
              }),
            );
          } else {
            res.destroy(error);
          }
        }
      });
    },
  };
}
