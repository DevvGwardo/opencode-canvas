// HTTP server: serves the canvas UI and proxies /api/* to OpenCode with the
// service credentials attached, so the browser never sees the password.

import index from "../app/index.html"
import { homedir } from "node:os"
import { authHeader, resolveUpstream, type Upstream, type UpstreamOptions } from "./upstream"

export interface ServerOptions extends UpstreamOptions {
  port: number
  hostname: string
  demo: boolean
  dev: boolean
  /** Don't log upstream connection changes (tests). */
  quiet?: boolean
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

function isLoopbackHost(host: string | null) {
  if (!host) return false
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
  return name === "localhost" || name === "127.0.0.1" || name === "::1"
}

export async function startServer(opts: ServerOptions) {
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

  const loopbackOnly = isLoopbackHost(opts.hostname)

  // Blocks other websites from driving OpenCode through this proxy (CSRF) and
  // DNS-rebinding attacks against the loopback listener.
  function guard(req: Request, url: URL): Response | undefined {
    if (loopbackOnly && !isLoopbackHost(req.headers.get("host"))) {
      return new Response("Forbidden host", { status: 403 })
    }
    const origin = req.headers.get("origin")
    if (origin && origin !== url.origin) return new Response("Forbidden origin", { status: 403 })
    const site = req.headers.get("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 })
    return undefined
  }

  async function proxy(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    const url = new URL(req.url)
    const blocked = guard(req, url)
    if (blocked) return blocked

    const isStream = url.pathname === "/api/event"
    if (isStream) server.timeout(req, 0)

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    for (let attempt = 0; attempt < 2; attempt++) {
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
      try {
        const res = await fetch(up.url + url.pathname + url.search, {
          method: req.method,
          headers,
          body,
          signal: req.signal,
          redirect: "manual",
          decompress: !isStream,
        })
        if (lastLogged) logState(`opencode  connected  ${up.url}`)
        const out = new Headers(res.headers)
        out.delete("content-encoding")
        out.delete("content-length")
        if (isStream) {
          out.set("cache-control", "no-cache, no-transform")
          out.set("x-accel-buffering", "no")
        }
        return new Response(res.body, { status: res.status, headers: out })
      } catch (e) {
        if (req.signal.aborted) return new Response(null, { status: 499 })
        // The service may have restarted on a new port: rediscover once.
        upstreamError = (e as Error).message
        logState(`opencode  lost ${up.url}  ${upstreamError}`)
        upstream = undefined
      }
    }
    return Response.json({ _tag: "UpstreamUnavailable", message: upstreamError }, { status: 502 })
  }

  if (!opts.demo) await getUpstream()

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    idleTimeout: 255,
    development: opts.dev ? { hmr: true, console: false } : false,
    routes: {
      "/": index,
      "/canvas/config": async (req) => {
        const blocked = guard(req, new URL(req.url))
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
        })
      },
    },
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/api/")) return proxy(req, server)
      return new Response("Not found", { status: 404 })
    },
  })

  return { server, upstream: () => upstream, upstreamError: () => upstreamError }
}
