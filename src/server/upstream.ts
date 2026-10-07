// Finds the OpenCode v2 server and the credentials to talk to it.
//
// Order of precedence:
//   1. --server / OPENCODE_SERVER_URL (+ OPENCODE_SERVER_PASSWORD / _USERNAME)
//   2. the OpenCode background service (`opencode service status`), started on
//      demand, with the password from <config>/opencode/service.json

import { homedir } from "node:os"
import { join } from "node:path"

export interface Upstream {
  url: string
  username: string
  password?: string
  source: "explicit" | "service"
}

export interface UpstreamOptions {
  server?: string
  password?: string
  username?: string
  autostart?: boolean
  opencodeBin?: string
}

function configDir() {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
}

async function readServicePassword(): Promise<string | undefined> {
  const file = Bun.file(join(configDir(), "opencode", "service.json"))
  if (!(await file.exists())) return undefined
  try {
    const json = await file.json()
    return typeof json?.password === "string" ? json.password : undefined
  } catch {
    return undefined
  }
}

async function run(bin: string, args: string[], timeoutMs = 20_000) {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(timer)
  return { code: proc.exitCode ?? 1, out: out.trim(), err: err.trim() }
}

const URL_RE = /https?:\/\/[^\s]+/

async function serviceUrl(bin: string, autostart: boolean): Promise<string | undefined> {
  let status = await run(bin, ["service", "status"])
  let match = status.out.match(URL_RE)
  if (match) return match[0]
  if (!autostart) return undefined
  await run(bin, ["service", "start"], 60_000)
  for (let i = 0; i < 20; i++) {
    status = await run(bin, ["service", "status"])
    match = status.out.match(URL_RE)
    if (match) return match[0]
    await Bun.sleep(500)
  }
  return undefined
}

export async function resolveUpstream(opts: UpstreamOptions = {}): Promise<Upstream> {
  const explicit = opts.server ?? process.env.OPENCODE_SERVER_URL
  const username = opts.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  if (explicit) {
    return {
      url: explicit.replace(/\/+$/, ""),
      username,
      password: opts.password ?? process.env.OPENCODE_SERVER_PASSWORD,
      source: "explicit",
    }
  }
  const bin = opts.opencodeBin ?? process.env.OPENCODE_BIN ?? "opencode"
  const url = await serviceUrl(bin, opts.autostart ?? true)
  if (!url) throw new Error("OpenCode background service is not running and could not be started (`opencode service start`).")
  return {
    url: url.replace(/\/+$/, ""),
    username,
    password: opts.password ?? process.env.OPENCODE_SERVER_PASSWORD ?? (await readServicePassword()),
    source: "service",
  }
}

export function authHeader(up: Upstream): string | undefined {
  if (!up.password) return undefined
  return "Basic " + Buffer.from(`${up.username}:${up.password}`).toString("base64")
}
