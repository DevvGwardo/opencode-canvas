import { afterAll, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { startServer } from "../src/server/server"

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
    if (url.pathname === "/api/model" || url.pathname === "/api/model/default") {
      const model = {
        id: "m", providerID: "p", name: "Model", enabled: true,
        headers: { authorization: "provider-secret" },
        settings: { apiKey: "provider-secret" },
        variants: [{ id: "high", headers: { authorization: "provider-secret" }, settings: { effort: "high" } }],
      }
      return Response.json({ data: url.pathname.endsWith("/default") ? model : [model] })
    }
    if (url.pathname === "/api/event") {
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
      const events = await fetch(url + "/api/event?hold=1", { headers: { cookie } })
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
