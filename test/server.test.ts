import { afterAll, describe, expect, test } from "bun:test"
import { startServer } from "../src/server/server"

// A stand-in OpenCode server that records what the proxy sends it.
const seen: Array<{ path: string; auth: string | null; origin: string | null }> = []
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    seen.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), origin: req.headers.get("origin") })
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.test" })
    if (url.pathname === "/api/event") {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"type":"server.connected","data":{}}\n\n`))
          c.close()
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
