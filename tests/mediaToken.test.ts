import assert from "node:assert/strict"
import test from "node:test"
import {
  MissingProxySecretError,
  defaultProxySecret,
  signProxyPayload,
  verifyProxyToken,
} from "../src/server/mediaToken.ts"

const secret = "test-media-token-secret-with-at-least-32-characters"

test("media proxy token accepts HTTP(S) and rejects file URLs by default", async () => {
  const httpsToken = await signProxyPayload(
    {
      u: "https://media.example.com/video.mp4",
      n: "video.mp4",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    secret,
  )
  assert.equal(
    (await verifyProxyToken(httpsToken, secret))?.u,
    "https://media.example.com/video.mp4",
  )

  const fileToken = await signProxyPayload(
    {
      u: "file:///C:/Windows/Temp/subvid-ytdlp-test.mp4",
      n: "subvid-ytdlp-test.mp4",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    secret,
  )
  assert.equal(await verifyProxyToken(fileToken, secret), null)
  assert.equal(
    (
      await verifyProxyToken(fileToken, secret, {
        allowFileProtocol: true,
      })
    )?.n,
    "subvid-ytdlp-test.mp4",
  )
})

test("media proxy token rejects a bad signature and an expired token", async () => {
  const token = await signProxyPayload(
    {
      u: "https://media.example.com/video.mp4",
      n: "video.mp4",
      exp: Math.floor(Date.now() / 1000) - 1,
    },
    secret,
  )
  assert.equal(await verifyProxyToken(token, secret), null)
  assert.equal(await verifyProxyToken(`${token}x`, secret), null)
})

test("media proxy secret must contain at least 32 characters", () => {
  assert.throws(
    () => defaultProxySecret({ MEDIA_PROXY_SECRET: "too-short" }),
    MissingProxySecretError,
  )
  assert.equal(
    defaultProxySecret({ MEDIA_PROXY_SECRET: secret }),
    secret,
  )
})
