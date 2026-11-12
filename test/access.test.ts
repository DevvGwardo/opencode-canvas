import { describe, expect, test } from "bun:test"
import { hostname } from "node:os"
import { classifyAddresses, createAccess, hostName, isLoopback } from "../src/server/access"
import { upstreamUrl } from "../src/server/upstream"

const accessPassword = crypto.randomUUID()

const entry = (address: string, internal = false) => ({ address, family: "IPv4", internal })

const request = (path = "/canvas/config", headers?: HeadersInit, method = "GET", body?: string) =>
  new Request(`http://127.0.0.1:4317${path}`, { headers: { host: "127.0.0.1:4317", ...Object.fromEntries(new Headers(headers)) }, method, body })

// Bun derives req.url from the Host header, so a request to another name must
// carry that name in the URL too or the origin check sees a mismatch.
const requestTo = (host: string, path = "/", headers?: HeadersInit, method = "GET", body?: string) =>
  new Request(`http://${host}${path}`, { headers: { host, ...Object.fromEntries(new Headers(headers)) }, method, body })

describe("Canvas access", () => {
  test("normalizes IPv6 and rejects malformed host headers", () => {
    expect(hostName("[::1]:4317")).toBe("::1")
    expect(isLoopback("::1")).toBe(true)
    expect(isLoopback("127.0.0.1:4317")).toBe(true)
    expect(isLoopback("127.0.0.1.attacker.example")).toBe(false)
    expect(hostName("user@localhost")).toBeUndefined()
    expect(hostName("localhost/path")).toBeUndefined()
  })

  test("network access requires a separate, strong password", () => {
    const old = process.env.CANVAS_PASSWORD
    delete process.env.CANVAS_PASSWORD
    try {
      expect(() => createAccess({ hostname: "0.0.0.0" })).toThrow("requires CANVAS_PASSWORD")
      expect(() => createAccess({ hostname: "0.0.0.0", accessPassword: "short" })).toThrow("at least 12")
    } finally {
      if (old === undefined) delete process.env.CANVAS_PASSWORD
      else process.env.CANVAS_PASSWORD = old
    }
  })

  test("LAN hosts are explicitly allowed, not arbitrary DNS names", () => {
    const access = createAccess({ hostname: "0.0.0.0", accessPassword, allowedHosts: ["my-mac.local"] })
    expect(access.guard(request(), false)).toBeUndefined()
    expect(access.guard(request("/", { host: "my-mac.local:4317" }), false)).toBeUndefined()
    expect(access.guard(request("/", { host: "attacker.example:4317" }), false)?.status).toBe(403)
    expect(access.guard(request())).toHaveProperty("status", 401)
  })

  test("login creates a private same-site cookie and logout revokes it", async () => {
    const access = createAccess({ hostname: "127.0.0.1", accessPassword })
    const headers = { "content-type": "application/json", origin: "http://127.0.0.1:4317" }
    const wrong = await access.auth(request("/canvas/auth", headers, "POST", '{"password":"wrong"}'), "test")
    expect(wrong.status).toBe(401)
    const res = await access.auth(request("/canvas/auth", headers, "POST", JSON.stringify({ password: accessPassword })), "test")
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie")!
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    expect(setCookie).not.toContain(accessPassword)
    const cookie = setCookie.split(";")[0]
    expect(access.guard(request("/api/session", { cookie }))).toBeUndefined()
    expect(access.guard(request("/api/session", { cookie, origin: "https://evil.example" }))?.status).toBe(403)
    await access.auth(request("/canvas/auth", { cookie }, "DELETE"), "test")
    expect(access.guard(request("/api/session", { cookie }))?.status).toBe(401)
  })

  test("blocks cross-site login and limits bad passwords", async () => {
    const access = createAccess({ hostname: "127.0.0.1", accessPassword })
    expect((await access.auth(request("/canvas/auth", { origin: "https://evil.example" }, "POST", "{}"), "evil")).status).toBe(403)
    for (let i = 0; i < 10; i++) {
      await access.auth(request("/canvas/auth", { "content-type": "application/json" }, "POST", '{"password":"wrong"}'), "bad")
    }
    expect((await access.auth(request("/canvas/auth", { "content-type": "application/json" }, "POST", '{"password":"wrong"}'), "bad")).status).toBe(429)
    expect((await access.auth(request("/canvas/auth", { "content-type": "text/plain" }, "POST", "{}"), "other")).status).toBe(415)
  })

  test("an explicit HTTPS origin works behind a trusted loopback proxy", async () => {
    const access = createAccess({ hostname: "127.0.0.1", accessPassword, publicOrigin: "https://canvas.lan" })
    const headers = { "content-type": "application/json", origin: "https://canvas.lan", host: "canvas.lan" }
    const login = await access.auth(request("/canvas/auth", headers, "POST", JSON.stringify({ password: accessPassword })), "proxy")
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("; Secure")
    expect(access.guard(request("/", { ...headers, origin: "https://evil.example" }), false)?.status).toBe(403)
    expect(access.guard(request("/", { ...headers, host: "other.lan" }), false)?.status).toBe(403)
    expect(() => createAccess({ hostname: "127.0.0.1", accessPassword, publicOrigin: "https://canvas.lan/path" })).toThrow("Public origin")
  })

  test("origin matching follows the URL standard, not raw string case", () => {
    const access = createAccess({ hostname: "0.0.0.0", accessPassword, allowedHosts: ["my-mac.local"] })
    expect(access.guard(requestTo("my-mac.local:4317", "/", { origin: "http://MY-MAC.local:4317" }), false)).toBeUndefined()
    expect(access.guard(requestTo("my-mac.local:4317", "/", { origin: "http://evil.example" }), false)?.status).toBe(403)
    expect(access.guard(requestTo("my-mac.local:4317", "/", { origin: "not a url" }), false)?.status).toBe(403)
  })

  test("the host's own name reaches Canvas without --allow-host", () => {
    const access = createAccess({ hostname: "0.0.0.0", accessPassword })
    const name = hostname().toLowerCase()
    expect(access.guard(request("/", { host: `${name}:4317` }), false)).toBeUndefined()
    expect(access.guard(request("/", { host: `${name}.local:4317` }), false)).toBeUndefined()
    expect(access.guard(request("/", { host: "some-other-pc:4317" }), false)?.status).toBe(403)
  })

  test("separates real LAN addresses from virtual and VPN adapters", () => {
    const listed = classifyAddresses({
      "Wi-Fi": [entry("192.168.1.199")],
      Tailscale: [entry("100.107.134.78")],
      "vEthernet (WSL)": [entry("172.28.96.1")],
      "Loopback Pseudo-Interface 1": [entry("127.0.0.1", true)],
      Ethernet: [
        entry("169.254.161.68"),
        { address: "fe80::9c47:85a7:ac16:7bc0", family: "IPv6", internal: false },
        { address: "fe80::1%eth0", family: "IPv6", internal: false },
        { address: "2605:59c8:1890:8e10::1", family: "IPv6", internal: false },
      ],
    })
    expect(listed.map((a) => a.address)).toEqual(["192.168.1.199", "2605:59c8:1890:8e10::1", "100.107.134.78", "172.28.96.1"])
    expect(listed.map((a) => a.kind)).toEqual(["lan", "lan", "vpn", "virtual"])
    expect(listed[0].adapter).toBe("Wi-Fi")
  })

  test("rejects malformed publicOrigin with a clear error", () => {
    expect(() => createAccess({ hostname: "127.0.0.1", accessPassword, publicOrigin: "canvas.lan" })).toThrow("Public origin must be an HTTP(S) origin")
    expect(() => createAccess({ hostname: "127.0.0.1", accessPassword, publicOrigin: "ftp://canvas.lan" })).toThrow("Public origin must be an HTTP(S) origin")
  })

  test("validates JSON media type, body bounds, Origin: null, and HTTP methods", async () => {
    const access = createAccess({ hostname: "127.0.0.1", accessPassword })
    expect(access.guard(request("/", { origin: "null" }), false)?.status).toBe(403)
    expect(access.guard(request("/", { "sec-fetch-site": "same-site" }), false)?.status).toBe(403)

    const ok = await access.auth(
      request("/canvas/auth", { "content-type": "Application/JSON; charset=utf-8", origin: "http://127.0.0.1:4317" }, "POST", JSON.stringify({ password: accessPassword })),
      "json-case",
    )
    expect(ok.status).toBe(200)

    const wrongType = await access.auth(
      request("/canvas/auth", { "content-type": "application/json-patch+json" }, "POST", JSON.stringify({ password: accessPassword })),
      "json-patch",
    )
    expect(wrongType.status).toBe(415)

    const tooBig = await access.auth(
      request("/canvas/auth", { "content-type": "application/json" }, "POST", JSON.stringify({ password: "x".repeat(10_000) })),
      "big-body",
    )
    expect(tooBig.status).toBe(413)

    const badJson = await access.auth(
      request("/canvas/auth", { "content-type": "application/json" }, "POST", "{"),
      "bad-json",
    )
    expect(badJson.status).toBe(400)

    const badMethod = await access.auth(request("/canvas/auth", undefined, "PUT"), "method")
    expect(badMethod.status).toBe(405)
  })
})

describe("upstream URL", () => {
  test("normalizes URLs and keeps embedded credentials out of logs", () => {
    expect(upstreamUrl("http://localhost:4096/")).toBe("http://localhost:4096")
    expect(() => upstreamUrl("http://name:password@localhost:4096")).toThrow("without embedded credentials")
    expect(() => upstreamUrl("file:///tmp/server")).toThrow("HTTP(S)")
    expect(() => upstreamUrl("http://localhost:4096/?token=secret")).toThrow("without embedded credentials")
    expect(() => upstreamUrl("not a url")).toThrow("HTTP(S)")
  })
})
