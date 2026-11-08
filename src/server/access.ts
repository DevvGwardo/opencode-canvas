// Canvas authentication is separate from the OpenCode service credentials.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"

const COOKIE = "occ_session"
const SESSION_MS = 12 * 3600_000

export interface AccessOptions {
  hostname: string
  accessPassword?: string
  allowedHosts?: string[]
  /** Exact browser-facing origin when a trusted reverse proxy terminates TLS. */
  publicOrigin?: string
}

export function hostName(value: string): string | undefined {
  try {
    const url = new URL(`http://${value.includes(":") && !value.includes("[") && value.split(":").length > 2 ? `[${value}]` : value}`)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  } catch {
    return undefined
  }
}

export function isLoopback(host: string) {
  const name = hostName(host)
  return name === "127.0.0.1" || name === "localhost" || name === "::1"
}

/**
 * Origins compare by their parsed serialization, so scheme and host case never
 * matter (a browser may send `http://MY-MAC.local:4317` for a lowercase URL).
 */
function sameOrigin(value: string, ...allowed: Array<string | undefined>) {
  let origin: string
  try {
    origin = new URL(value).origin
  } catch {
    return false
  }
  return allowed.some((candidate) => {
    if (!candidate) return false
    try {
      return new URL(candidate).origin === origin
    } catch {
      return false
    }
  })
}

export function networkAddresses() {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => !entry.internal && !entry.address.includes("%")).map((entry) => entry.address),
  )
}

export type AddressKind = "lan" | "vpn" | "virtual"

export interface LocalAddress {
  address: string
  adapter: string
  kind: AddressKind
}

/** Adapters a browser on another PC can never reach: VM switches and tunnels. */
const VPN_ADAPTER = /tailscale|zerotier|hamachi|wireguard|openvpn|nordvpn|windscribe|radmin|vpn/i
const VIRTUAL_ADAPTER = /vEthernet|hyper-?v|wsl|virtualbox|vmware|docker|virtual|loopback|bluetooth|pseudo|tap|npcap/i

const ADDRESS_RANK: Record<AddressKind, number> = { lan: 0, vpn: 1, virtual: 2 }

/**
 * The host's own addresses, best first. `networkAddresses()` deliberately keeps
 * every address (the Host allowlist wants them all), but printing virtual
 * switches and VPN tunnels as "network" URLs sends people to dead ends, so this
 * orders real LAN interfaces first and labels the rest.
 */
export function classifyAddresses(
  interfaces: Record<string, ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined> = networkInterfaces(),
): LocalAddress[] {
  const listed: LocalAddress[] = []
  for (const [adapter, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.address.includes("%") || entry.address.startsWith("169.254.")) continue
      const kind: AddressKind = VPN_ADAPTER.test(adapter) ? "vpn" : VIRTUAL_ADAPTER.test(adapter) ? "virtual" : "lan"
      listed.push({ address: entry.address, adapter, kind })
    }
  }
  return listed.sort((a, b) => ADDRESS_RANK[a.kind] - ADDRESS_RANK[b.kind])
}

function digest(value: string) {
  return createHash("sha256").update(value).digest()
}

export function createAccess(opts: AccessOptions) {
  const loopbackOnly = isLoopback(opts.hostname)
  const password = opts.accessPassword ?? process.env.CANVAS_PASSWORD
  const publicOrigin = opts.publicOrigin ? new URL(opts.publicOrigin) : undefined
  if (publicOrigin && (!["http:", "https:"].includes(publicOrigin.protocol) || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash)) {
    throw new Error("Public origin must be an HTTP(S) origin without credentials, a path, a query, or a fragment.")
  }
  if ((!loopbackOnly || publicOrigin) && !password) {
    throw new Error("Network access requires CANVAS_PASSWORD (separate from your OpenCode server password).")
  }
  if ((!loopbackOnly || publicOrigin) && password!.length < 12) {
    throw new Error("CANVAS_PASSWORD must be at least 12 characters for network access.")
  }
  const hosts = new Set(["localhost", "127.0.0.1", "::1"])
  if (publicOrigin) hosts.add(hostName(publicOrigin.host)!)
  if (!loopbackOnly) {
    // Another PC on the LAN usually reaches this host by name, not by IP, so
    // the machine's own name is allowed without --allow-host.
    const self = hostname()
    for (const value of [opts.hostname, ...networkAddresses(), self, `${self}.local`, ...(opts.allowedHosts ?? [])]) {
      const name = hostName(value)
      if (!name) {
        if (value === self || value === `${self}.local`) continue
        throw new Error(`Invalid allowed host: ${value}`)
      }
      if (name !== "0.0.0.0" && name !== "::") hosts.add(name)
    }
  }
  const sessions = new Map<string, number>()
  const failures = new Map<string, { count: number; until: number }>()

  function prune() {
    const now = Date.now()
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token)
    for (const [ip, attempt] of failures) if (attempt.until <= now) failures.delete(ip)
  }

  function token(req: Request) {
    return req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1)
  }

  function authenticated(req: Request) {
    if (!password) return true
    const value = token(req)
    return !!value && (sessions.get(value) ?? 0) > Date.now()
  }

  function guard(req: Request, requireAuth = true): Response | undefined {
    const url = new URL(req.url)
    const host = hostName(req.headers.get("host") ?? "")
    if (!host || !hosts.has(host)) return new Response("Forbidden host", { status: 403 })
    const origin = req.headers.get("origin")
    if (origin && !sameOrigin(origin, url.origin, publicOrigin?.origin)) return new Response("Forbidden origin", { status: 403 })
    const site = req.headers.get("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 })
    if (requireAuth && !authenticated(req)) return Response.json({ message: "Sign in to Canvas" }, { status: 401 })
  }

  function cookie(req: Request, value: string, maxAge: number) {
    const secure = (publicOrigin?.protocol ?? new URL(req.url).protocol) === "https:" ? "; Secure" : ""
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
  }

  async function auth(req: Request, ip: string): Promise<Response> {
    const blocked = guard(req, false)
    if (blocked) return blocked
    prune()
    const headers = { "cache-control": "no-store" }
    if (req.method === "GET") {
      return Response.json({ required: !!password, authenticated: authenticated(req) }, { headers })
    }
    if (req.method === "DELETE") {
      const value = token(req)
      if (value) sessions.delete(value)
      return new Response(null, { status: 204, headers: { ...headers, "set-cookie": cookie(req, "", 0) } })
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST, DELETE" } })
    const failed = failures.get(ip)
    if (failed && failed.count >= 10) {
      return Response.json({ message: "Too many attempts. Try again in a minute." }, { status: 429, headers: { ...headers, "retry-after": "60" } })
    }
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
      return Response.json({ message: "Expected JSON" }, { status: 415, headers })
    }
    let input: unknown
    try {
      input = (await req.json())?.password
    } catch {
      return Response.json({ message: "Invalid JSON" }, { status: 400, headers })
    }
    if (typeof input !== "string" || input.length > 1024 || !password || !timingSafeEqual(digest(input), digest(password))) {
      failures.set(ip, { count: (failed?.count ?? 0) + 1, until: Date.now() + 60_000 })
      return Response.json({ message: "Incorrect Canvas password" }, { status: 401, headers })
    }
    failures.delete(ip)
    // Bound memory even if a client repeatedly signs in without signing out.
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!)
    const old = token(req)
    if (old) sessions.delete(old)
    const value = randomBytes(32).toString("hex")
    sessions.set(value, Date.now() + SESSION_MS)
    return Response.json({ authenticated: true }, {
      headers: { ...headers, "set-cookie": cookie(req, value, SESSION_MS / 1000) },
    })
  }

  return { guard, auth, authenticated, required: !!password, loopbackOnly }
}
