import assert from "node:assert/strict"
import test from "node:test"
import {
  assertPublicHttpsEndpoint,
  BlockedEndpointError,
  cobaltHostname,
  isAllowedMediaHost,
  isInternalHost,
} from "../src/server/netGuard.ts"
import { applyRateLimit } from "../src/server/rateLimit.ts"

test("isInternalHost blocks every spelling of a private address", () => {
  const internal = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "ip6-localhost",
    "printer.local",
    "db.internal",
    "svc.home.arpa",
    "example.onion",
    "metadata.google.internal",
    "127.0.0.1",
    "127.1", // short form
    "2130706433", // bare decimal
    "0x7f000001", // hex
    "0177.0.0.1", // octal
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.0.0.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmarking
    "239.255.255.250", // multicast
    "::",
    "::1",
    "[::1]",
    "[::ffff:127.0.0.1]", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "fd00::1",
    "fe80::1",
    "", // empty host is never fetchable
  ]
  for (const host of internal) {
    assert.equal(isInternalHost(host), true, `${host} must be blocked`)
  }

  const external = [
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16/12
    "192.169.0.1", // just outside 192.168/16
    "100.128.0.1", // just outside CGNAT
    "example.com",
    "sub.localhost.example.com",
  ]
  for (const host of external) {
    assert.equal(isInternalHost(host), false, `${host} must be allowed`)
  }
})

test("assertPublicHttpsEndpoint normalizes and refuses unsafe endpoints", () => {
  assert.equal(assertPublicHttpsEndpoint(""), "")
  assert.equal(assertPublicHttpsEndpoint("  "), "")
  assert.equal(
    assertPublicHttpsEndpoint("https://api.openai.com/v1/"),
    "https://api.openai.com",
  )
  assert.equal(
    assertPublicHttpsEndpoint("https://api.example.com/proxy"),
    "https://api.example.com/proxy",
  )

  for (const bad of [
    "http://api.openai.com", // plaintext
    "not a url",
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://[::1]/v1",
    "https://169.254.169.254/v1",
    "https://internal.local/v1",
  ]) {
    assert.throws(
      () => assertPublicHttpsEndpoint(bad),
      BlockedEndpointError,
      `${bad} must be refused`,
    )
  }
})

test("media proxy only streams from allowlisted CDNs", () => {
  const cobalt = cobaltHostname("https://cobalt.example.com/api")
  assert.equal(cobalt, "cobalt.example.com")
  assert.equal(cobaltHostname("nonsense"), "")

  for (const host of [
    "rr1---sn-abc.googlevideo.com",
    "googlevideo.com",
    "v16-webapp.tiktokcdn.com",
    "www.douyin.com",
    "cobalt.example.com", // configured Cobalt origin
  ]) {
    assert.equal(isAllowedMediaHost(host, cobalt), true, `${host} must be allowed`)
  }

  for (const host of [
    "attacker.example.net",
    "googlevideo.com.attacker.net", // suffix must be a label boundary
    "notgooglevideo.com",
    "127.0.0.1",
    "169.254.169.254",
    "", // no host
  ]) {
    assert.equal(isAllowedMediaHost(host, cobalt), false, `${host} must be blocked`)
  }

  // Without a configured Cobalt host, that origin is not special-cased.
  assert.equal(isAllowedMediaHost("cobalt.example.com", ""), false)
})

test("applyRateLimit blocks at the limit, expires, and resets", () => {
  const options = { limit: 3, windowMs: 60_000 }

  let entry = applyRateLimit(undefined, "hit", options, 1_000).entry
  assert.equal(entry?.count, 1)
  const second = applyRateLimit(entry, "hit", options, 2_000)
  assert.equal(second.blocked, false)
  const third = applyRateLimit(second.entry, "hit", options, 3_000)
  assert.equal(third.blocked, true)
  assert.equal(third.retryAfter, 60)

  // A peek during the lockout stays blocked and does not extend it.
  const peek = applyRateLimit(third.entry, "peek", options, 30_000)
  assert.equal(peek.blocked, true)
  assert.ok(peek.retryAfter > 0 && peek.retryAfter <= 60)

  // Once the lockout passes the counter starts over.
  const later = applyRateLimit(third.entry, "peek", options, 200_000)
  assert.equal(later.blocked, false)
  assert.equal(later.entry, undefined)

  // A successful login resets immediately.
  assert.equal(applyRateLimit(third.entry, "reset", options, 5_000).entry, undefined)

  // Failures spread beyond the window never accumulate into a lockout.
  let sparse = applyRateLimit(undefined, "hit", options, 0).entry
  for (const now of [70_000, 140_000, 210_000]) {
    const step = applyRateLimit(sparse, "hit", options, now)
    assert.equal(step.blocked, false)
    sparse = step.entry
  }
})
