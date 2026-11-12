import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { startServer } from "../src/server/server"

// createAccess() falls back to process.env.CANVAS_PASSWORD, so a developer who
// exports it for real LAN use would otherwise get 401s from every
// unauthenticated request in this file.
delete process.env.CANVAS_PASSWORD

// A stand-in OpenCode server that records what the proxy sends it.
const seen: Array<{ path: string; auth: string | null; origin: string | null }> = []
let heldEvent: ReadableStreamDefaultController<Uint8Array> | undefined
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    seen.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), origin: req.headers.get("origin") })
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.test" })
    const path = decodeURIComponent(url.pathname).replace(/\/+/g, "/").replace(/\/+$/, "")
    if (path === "/api/model" || path === "/api/model/default") {
      const model = {
        id: "m", providerID: "p", name: "Model", enabled: true,
        headers: { authorization: "provider-secret" },
        settings: { apiKey: "provider-secret" },
        variants: [null, {}, 123, { id: "high", headers: { authorization: "provider-secret" }, settings: { effort: "high" } }],
      }
      return Response.json({ data: path.endsWith("/default") ? model : [model] })
    }
    if (path === "/api/event") {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"type":"server.connected","data":{}}\n\n`))
          if (url.searchParams.has("hold")) heldEvent = c
          else c.close()
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ data: [], echo: url.pathname })
  },
})

const { server } = await startServer({
  port: 0,
  hostname: "127.0.0.1",
  demo: false,
  dev: false,
  server: `http://127.0.0.1:${fake.port}`,
  password: "secret",
  autostart: false,
  quiet: true,
})
const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
  fake.stop(true)
})

describe("proxy", () => {
  test("adds basic auth and never forwards browser origin", async () => {
    const res = await fetch(`${base}/api/session?limit=1`)
    expect(res.status).toBe(200)
    const last = seen.at(-1)!
    expect(last.path).toBe("/api/session?limit=1")
    expect(last.auth).toBe("Basic " + btoa("opencode:secret"))
    expect(last.origin).toBeNull()
  })

  test("streams the event feed", async () => {
    const text = await (await fetch(`${base}/api/event`)).text()
    expect(text).toContain("server.connected")
  })

  test("config reports the upstream without the password", async () => {
    const cfg = await (await fetch(`${base}/canvas/config`)).json()
    expect(cfg).toMatchObject({ mode: "live", connected: true, version: "2.0.test" })
    expect(JSON.stringify(cfg)).not.toContain("secret")
  })

  test("model metadata does not expose provider or variant credentials", async () => {
    for (const path of ["/api/model", "/api/model/default"]) {
      const res = await fetch(base + path)
      const text = await res.text()
      expect(text).not.toContain("provider-secret")
      expect(text).not.toContain("settings")
      expect(text).toContain('"id":"high"')
      const data = JSON.parse(text).data
      expect((Array.isArray(data) ? data[0] : data).variants).toEqual([{ id: "high" }])
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    const head = await fetch(base + "/api/model/default", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("rejects cross-site requests", async () => {
    const before = seen.length
    const a = await fetch(`${base}/api/session`, { method: "POST", headers: { origin: "https://evil.example" } })
    const b = await fetch(`${base}/api/session`, { headers: { "sec-fetch-site": "cross-site" } })
    expect(a.status).toBe(403)
    expect(b.status).toBe(403)
    expect(seen.length).toBe(before)
  })

  test("model route aliases cannot bypass credential filtering", async () => {
    for (const path of ["/api/model/", "/api/%6dodel", "/api//model", "/api/model/default/", "/api//model/default/", "/api/%6dodel/%64efault"]) {
      const res = await fetch(base + path)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain("provider-secret")
      const data = JSON.parse(text).data
      const model = Array.isArray(data) ? data[0] : data
      expect(Object.keys(model).sort()).toEqual(["enabled", "id", "name", "providerID", "variants"].sort())
    }
  })

  test("rejects encoded path traversal out of /api/ or into filtered routes", async () => {
    const before = seen.length
    for (const path of ["/api/session/..%2fmodel", "/api/..%2fopenapi.json", "/api/%2e%2e%2fsecret", "/api/session/..%5cmodel", "/api/%ff"]) {
      const res = await fetch(base + path)
      expect(res.status).toBe(400)
    }
    expect(seen.length).toBe(before)
  })

  test("rejects non-loopback Host headers (DNS rebinding)", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { host: "attacker.example" } })
    expect(res.status).toBe(403)
  })

  test("same-origin browser requests pass", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { origin: base, "sec-fetch-site": "same-origin" } })
    expect(res.status).toBe(200)
  })

  test("serves the app", async () => {
    const html = await (await fetch(base)).text()
    expect(html).toContain("<title>OpenCode Canvas</title>")
  })
})

describe("authenticated server", () => {
  test("protects the API and config independently of upstream credentials", async () => {
    const accessPassword = crypto.randomUUID()
    const { server: protectedServer } = await startServer({
      port: 0, hostname: "127.0.0.1", demo: false, dev: false,
      server: `http://127.0.0.1:${fake.port}`, password: "secret",
      accessPassword, autostart: false, quiet: true,
    })
    const url = `http://127.0.0.1:${protectedServer.port}`
    try {
      expect((await fetch(url + "/api/session")).status).toBe(401)
      expect((await fetch(url + "/canvas/config")).status).toBe(401)
      expect((await fetch(url + "/canvas/browser")).status).toBe(401)
      expect((await fetch(url + "/canvas/browser/events")).status).toBe(401)
      expect((await fetch(url + "/canvas/browser/action", { method: "POST" })).status).toBe(401)
      const login = await fetch(url + "/canvas/auth", {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ password: accessPassword }),
      })
      expect(login.status).toBe(200)
      const cookie = login.headers.get("set-cookie")!.split(";")[0]
      const res = await fetch(url + "/api/session", { headers: { cookie, origin: url } })
      expect(res.status).toBe(200)
      expect(seen.at(-1)?.auth).toBe("Basic " + btoa("opencode:secret"))
      const events = await fetch(url + "/api/%65vent/?hold=1", { headers: { cookie } })
      const reader = events.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      await fetch(url + "/canvas/auth", { method: "DELETE", headers: { cookie } })
      heldEvent!.enqueue(new TextEncoder().encode('data: {"type":"private.event"}\n\n'))
      expect((await reader.read()).done).toBe(true)
    } finally {
      protectedServer.stop(true)
    }
  })
})

test("decompresses a gzipped upstream response without leaking its encoding headers", async () => {
  const payload = { data: [{ id: "s1", name: "x".repeat(500) }] }
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)))
  const gzipper = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/api/info") return Response.json({ version: "2.0.test" })
      return new Response(gz, {
        headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gz.length) },
      })
    },
  })
  const { server: canvas } = await startServer({
    port: 0, hostname: "127.0.0.1", demo: false, dev: false,
    server: `http://127.0.0.1:${gzipper.port}`, password: "secret", autostart: false, quiet: true,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${canvas.port}/api/session`, { headers: { "accept-encoding": "gzip" } })
    expect(res.status).toBe(200)
    // The proxy strips the (now-decompressed) encoding/length headers so the
    // browser never sees a stale content-length or double-decodes the body.
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(await res.json()).toEqual(payload)
  } finally {
    canvas.stop(true)
    gzipper.stop(true)
  }
})

test("a transport failure never automatically resends a write", async () => {
  let attempts = 0
  const upstream = createServer((socket) => {
    socket.once("data", () => { attempts++; socket.destroy() })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("Missing test upstream port")
  const { server: canvas } = await startServer({
    port: 0, hostname: "127.0.0.1", demo: false, dev: false,
    server: `http://127.0.0.1:${address.port}`, autostart: false, quiet: true,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${canvas.port}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("may have been accepted")
    expect(attempts).toBe(1)
  } finally {
    canvas.stop(true)
    upstream.close()
  }
})

test("/canvas/config omits empty authorization and rediscovers a moved upstream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-rediscover-"))
  const prevConfig = process.env.XDG_CONFIG_HOME
  const prevUpPass = process.env.OPENCODE_SERVER_PASSWORD
  process.env.XDG_CONFIG_HOME = dir
  delete process.env.OPENCODE_SERVER_PASSWORD
  const seenAuthHeaders: Array<string | null> = []
  const makeUpstream = () => Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      seenAuthHeaders.push(req.headers.get("authorization"))
      if (new URL(req.url).pathname === "/api/info") return Response.json({ version: "2.0.moved" })
      return Response.json({ data: [{ ok: true }] })
    },
  })
  let up1 = makeUpstream()
  let up2: Bun.Server<unknown> | undefined
  let up3: Bun.Server<unknown> | undefined
  const urlFile = join(dir, "upstream-url")
  await writeFile(urlFile, `http://127.0.0.1:${up1.port}`)
  const js = join(dir, "opencode.js")
  await writeFile(js, `const fs = require("node:fs"); console.log(fs.readFileSync(${JSON.stringify(urlFile)}, "utf8"));`)
  let bin: string
  if (process.platform === "win32") {
    bin = join(dir, "opencode.cmd")
    await writeFile(bin, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
  } else {
    bin = join(dir, "opencode")
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
    await chmod(bin, 0o755)
  }
  const { server: canvas, stop } = await startServer({
    port: 0, hostname: "127.0.0.1", demo: false, dev: false,
    opencodeBin: bin, autostart: false, browser: false, quiet: true,
  })
  const baseUrl = `http://127.0.0.1:${canvas.port}`
  try {
    const cfg1 = await (await fetch(`${baseUrl}/canvas/config`)).json()
    expect(cfg1.connected).toBe(true)
    expect(seenAuthHeaders.at(-1)).toBeNull()

    // Upstream restarts on a new port.
    up1.stop(true)
    up2 = makeUpstream()
    await writeFile(urlFile, `http://127.0.0.1:${up2.port}`)

    const cfg2 = await (await fetch(`${baseUrl}/canvas/config`)).json()
    expect(cfg2).toMatchObject({ connected: true, version: "2.0.moved" })
    expect(seenAuthHeaders.at(-1)).toBeNull()

    // Upstream restarts again; GET /api/* also rediscovers once.
    up2.stop(true)
    up3 = makeUpstream()
    await writeFile(urlFile, `http://127.0.0.1:${up3.port}`)

    const proxied = await fetch(`${baseUrl}/api/session`)
    expect(proxied.status).toBe(200)
    expect(await proxied.json()).toEqual({ data: [{ ok: true }] })
    expect(seenAuthHeaders.at(-1)).toBeNull()

    // Also verify browser endpoint validation when browser is disabled.
    expect(await (await fetch(`${baseUrl}/canvas/browser`)).json()).toEqual({ available: false, running: false })
    expect((await fetch(`${baseUrl}/canvas/browser/events`)).status).toBe(503)
    expect((await fetch(`${baseUrl}/canvas/browser/action`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415)
    expect((await fetch(`${baseUrl}/canvas/browser/action`, { method: "POST", headers: { "content-type": "Application/JSON; charset=utf-8" }, body: JSON.stringify({ type: "bad" }) })).status).toBe(400)
    expect((await fetch(`${baseUrl}/canvas/browser/action`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(32_001) })).status).toBe(413)
    expect((await fetch(`${baseUrl}/canvas/browser/unknown`)).status).toBe(404)
  } finally {
    await stop()
    up1.stop(true)
    up2?.stop(true)
    up3?.stop(true)
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevConfig
    if (prevUpPass === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = prevUpPass
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
