// HTTP server: serves the canvas UI and proxies /api/* to OpenCode with the
// service credentials attached, so the browser never sees the password.

import index from "../app/index.html"
import { homedir } from "node:os"
import { createAccess, type AccessOptions } from "./access"
import { BrowserHost, findBrowser } from "./browser"
import type { BrowserEvent } from "../shared/browser"
import { authHeader, resolveUpstream, type Upstream, type UpstreamOptions } from "./upstream"

export interface ServerOptions extends UpstreamOptions, AccessOptions {
  port: number
  hostname: string
  demo: boolean
  dev: boolean
  /** Don't log upstream connection changes (tests). */
  quiet?: boolean
  browserBin?: string
  browser?: boolean
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "content-length",
])

export async function startServer(opts: ServerOptions) {
  const access = createAccess(opts)
  const browser = new BrowserHost(opts.browser === false ? undefined : findBrowser(opts.browserBin))
  let browserStreams = 0
  let upstream: Upstream | undefined
  let upstreamError: string | undefined
  let resolving: Promise<Upstream | undefined> | undefined
  let lastLogged: string | undefined

  // One line per connection change, so the terminal shows when OpenCode drops
  // or moves without logging every request.
  function logState(line: string) {
    if (opts.quiet || line === lastLogged) return
    lastLogged = line
    console.log(`  ${new Date().toLocaleTimeString()}  ${line}`)
  }

  async function getUpstream(force = false): Promise<Upstream | undefined> {
    if (opts.demo) return undefined
    if (upstream && !force) return upstream
    resolving ??= resolveUpstream(opts)
      .then((u) => {
        upstream = u
        upstreamError = undefined
        return u
      })
      .catch((e: Error) => {
        upstreamError = e.message
        logState(`opencode  \x1b[31munavailable\x1b[0m  ${e.message}`)
        return undefined
      })
      .finally(() => {
        resolving = undefined
      })
    return resolving
  }

  function authenticatedStream(req: Request, body: ReadableStream<Uint8Array>) {
    if (!access.required) return body
    const reader = body.getReader()
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    return new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          if (closed || access.authenticated(req)) return
          closed = true
          clearInterval(timer)
          void reader.cancel().catch(() => {})
          controller.close()
        }, 15_000)
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (closed) return
          if (done || !access.authenticated(req)) {
            closed = true
            clearInterval(timer)
            void reader.cancel().catch(() => {})
            controller.close()
          } else controller.enqueue(value)
        } catch (e) {
          if (closed) return
          closed = true
          clearInterval(timer)
          controller.error(e)
        }
      },
      cancel() {
        closed = true
        clearInterval(timer)
        return reader.cancel()
      },
    })
  }

  async function proxy(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    const url = new URL(req.url)
    const blocked = access.guard(req)
    if (blocked) return blocked

    const isStream = url.pathname === "/api/event"
    if (isStream) server.timeout(req, 0)

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    const retryable = req.method === "GET" || req.method === "HEAD"
    for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt++) {
      const up = await getUpstream(attempt > 0)
      if (!up) {
        return Response.json(
          { _tag: "UpstreamUnavailable", message: upstreamError ?? "OpenCode server unavailable" },
          { status: 502 },
        )
      }
      const headers = new Headers()
      req.headers.forEach((v, k) => {
        if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v)
      })
      const auth = authHeader(up)
      if (auth) headers.set("authorization", auth)
      if (isStream) headers.set("accept-encoding", "identity")
      try {
        const res = await fetch(up.url + url.pathname + url.search, {
          method: req.method,
          headers,
          body,
          signal: req.signal,
          redirect: "manual",
        })
        if (lastLogged) logState(`opencode  connected  ${up.url}`)
        const out = new Headers(res.headers)
        out.delete("content-encoding")
        out.delete("content-length")
        out.delete("set-cookie")
        out.delete("www-authenticate")
        out.set("cache-control", "no-store")
        // Model settings and variant bodies can contain provider credentials.
        // Only expose the identity and effort IDs needed by the UI.
        if (res.ok && req.method !== "HEAD" && (url.pathname === "/api/model" || url.pathname === "/api/model/default")) {
          const payload = await res.json() as { data: any }
          const safeModel = (m: any) => m ? {
            id: m.id,
            providerID: m.providerID,
            name: m.name,
            enabled: m.enabled,
            status: m.status,
            variant: typeof m.variant === "string" ? m.variant : undefined,
            variants: Array.isArray(m.variants) ? m.variants.map((v: any) => ({ id: typeof v === "string" ? v : v.id })) : [],
          } : null
          return Response.json({
            data: Array.isArray(payload.data) ? payload.data.map(safeModel) : safeModel(payload.data),
          }, { headers: out })
        }
        if (isStream) {
          out.set("cache-control", "no-cache, no-transform")
          out.set("x-accel-buffering", "no")
        }
        return new Response(isStream && res.body ? authenticatedStream(req, res.body) : res.body, { status: res.status, headers: out })
      } catch (e) {
        if (req.signal.aborted) return new Response(null, { status: 499 })
        // The service may have restarted on a new port: rediscover once.
        upstreamError = (e as Error).message
        logState(`opencode  lost ${up.url}  ${upstreamError}`)
        upstream = undefined
      }
    }
    return Response.json({
      _tag: "UpstreamUnavailable",
      message: retryable ? upstreamError : "OpenCode connection was lost. Check the session before retrying, the request may have been accepted.",
    }, { status: 502 })
  }

  if (!opts.demo) await getUpstream()

  async function browserRequest(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    const blocked = access.guard(req)
    if (blocked) return blocked
    const path = new URL(req.url).pathname
    const headers = { "cache-control": "no-store" }
    if (path === "/canvas/browser" && req.method === "GET") {
      return Response.json({ available: browser.available, running: browser.running }, { headers })
    }
    if (path === "/canvas/browser/events" && req.method === "GET") {
      if (!browser.available) return Response.json({ message: "Install Chrome or Chromium on the host, or set CANVAS_BROWSER_BIN." }, { status: 503, headers })
      if (browserStreams >= 4) return Response.json({ message: "Too many browser viewers (maximum 4)." }, { status: 429, headers })
      server.timeout(req, 0)
      browserStreams++
      let unsubscribe: (() => void) | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        browserStreams--
        unsubscribe?.()
        clearInterval(heartbeat)
        req.signal.removeEventListener("abort", abort)
      }
      let abort = () => close()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          const send = (event: BrowserEvent) => {
            if (!closed && !access.authenticated(req)) return abort()
            if (closed || event.type === "frame" && (controller.desiredSize ?? 0) <= 0) return
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { close() }
          }
          abort = () => { close(); try { controller.close() } catch { /* Already cancelled. */ } }
          req.signal.addEventListener("abort", abort, { once: true })
          heartbeat = setInterval(() => {
            if (!access.authenticated(req)) {
              send({ type: "error", message: "Canvas login expired. Sign in again." })
              abort()
            } else {
              try { controller.enqueue(encoder.encode(": heartbeat\n\n")) } catch { close() }
            }
          }, 15_000)
          void browser.subscribe(send).then((off) => {
            if (closed) off()
            else unsubscribe = off
          }).catch((e) => {
            send({ type: "error", message: (e as Error).message })
            abort()
          })
        },
        cancel: close,
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
      })
    }
    if (path === "/canvas/browser/action" && req.method === "POST") {
      if (!req.headers.get("content-type")?.startsWith("application/json")) return Response.json({ message: "Expected JSON" }, { status: 415, headers })
      try {
        const text = await req.text()
        if (text.length > 32_000) return Response.json({ message: "Browser action is too large" }, { status: 413, headers })
        const input = JSON.parse(text)
        await browser.action(input)
        return new Response(null, { status: 204, headers })
      } catch (e) {
        return Response.json({ message: (e as Error).message }, { status: 400, headers })
      }
    }
    return new Response("Not found", { status: 404 })
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    idleTimeout: 255,
    maxRequestBodySize: 24 * 1024 * 1024,
    development: opts.dev ? { hmr: true, console: false } : false,
    routes: {
      "/": index,
      "/canvas/auth": (req, server) => access.auth(req, server.requestIP(req)?.address ?? "unknown"),
      "/canvas/config": async (req) => {
        const blocked = access.guard(req)
        if (blocked) return blocked
        const up = await getUpstream()
        let version: string | undefined
        if (up) {
          try {
            const res = await fetch(up.url + "/api/info", {
              headers: { authorization: authHeader(up) ?? "" },
              signal: AbortSignal.timeout(5_000),
            })
            if (res.ok) version = (await res.json())?.version
            else upstreamError = `OpenCode responded ${res.status} to /api/info`
          } catch (e) {
            upstreamError = (e as Error).message
            upstream = undefined
          }
        }
        return Response.json({
          mode: opts.demo ? "demo" : "live",
          connected: !!version,
          version,
          upstream: up?.url,
          home: homedir(),
          error: version ? undefined : upstreamError,
        }, { headers: { "cache-control": "no-store" } })
      },
    },
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/canvas/browser" || url.pathname.startsWith("/canvas/browser/")) return browserRequest(req, server)
      if (url.pathname.startsWith("/api/")) return proxy(req, server)
      return new Response("Not found", { status: 404 })
    },
  })

  return {
    server, upstream: () => upstream, upstreamError: () => upstreamError,
    stop: async () => { server.stop(true); await browser.stop() },
  }
}
