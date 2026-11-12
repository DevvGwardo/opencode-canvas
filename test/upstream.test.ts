import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authHeader, resolveUpstream } from "../src/server/upstream"

// resolveUpstream reads these from the environment when options are absent.
const KEYS = ["OPENCODE_BIN", "OPENCODE_SERVER_URL", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "XDG_CONFIG_HOME"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

async function makeFakeOpencode(dir: string, scriptBody: string) {
  const binDir = join(dir, "bin")
  await mkdir(binDir, { recursive: true })
  const js = join(binDir, "fake-opencode.js")
  await writeFile(js, scriptBody)
  if (process.platform === "win32") {
    const cmd = join(binDir, "opencode.cmd")
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = join(binDir, "opencode")
  await writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
  await chmod(sh, 0o755)
  return sh
}

describe("upstream resolution", () => {
  test("explicit options win over the environment and normalize the URL", async () => {
    process.env.OPENCODE_SERVER_URL = "http://env-host:1234"
    process.env.OPENCODE_SERVER_USERNAME = "env-user"
    process.env.OPENCODE_SERVER_PASSWORD = "obviously-fake-env-pass"
    const up = await resolveUpstream({ server: "http://opt-host:9999/", username: "opt-user", password: "obviously-fake-opt-pass" })
    expect(up).toEqual({ url: "http://opt-host:9999", username: "opt-user", password: "obviously-fake-opt-pass", source: "explicit" })
  })

  test("falls back to the environment and defaults the username", async () => {
    process.env.OPENCODE_SERVER_URL = "http://env-host:1234/"
    process.env.OPENCODE_SERVER_PASSWORD = "obviously-fake-env-pass"
    const up = await resolveUpstream()
    expect(up).toEqual({ url: "http://env-host:1234", username: "opencode", password: "obviously-fake-env-pass", source: "explicit" })
  })

  test("an explicit server without credentials is allowed but yields no auth header", async () => {
    const up = await resolveUpstream({ server: "http://host:1234" })
    expect(up.password).toBeUndefined()
    expect(authHeader(up)).toBeUndefined()
  })

  test("rejects a server URL with embedded credentials or malformed URL", async () => {
    await expect(resolveUpstream({ server: "http://user:pass@host:1234" })).rejects.toThrow("without embedded credentials")
    await expect(resolveUpstream({ server: "not a url" })).rejects.toThrow("OpenCode server must be an HTTP(S) URL")
  })

  test("discovers the service URL with ANSI codes and reads service.json password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-upstream-"))
    try {
      const configDir = join(dir, "config")
      process.env.XDG_CONFIG_HOME = configDir
      await mkdir(join(configDir, "opencode"), { recursive: true })
      await writeFile(join(configDir, "opencode", "service.json"), JSON.stringify({ password: "service-secret-pass" }))
      const bin = await makeFakeOpencode(dir, `
        if (process.argv[2] === "service" && process.argv[3] === "status") {
          console.log("\\x1b[32mhttp://127.0.0.1:4096\\x1b[0m")
        }
      `)
      const up = await resolveUpstream({ opencodeBin: bin, autostart: false })
      expect(up).toEqual({ url: "http://127.0.0.1:4096", username: "opencode", password: "service-secret-pass", source: "service" })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  test("does not hang if service start spawns a background child that inherits stdio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-upstream-start-"))
    let childPid: number | undefined
    try {
      const configDir = join(dir, "config")
      await mkdir(configDir, { recursive: true })
      process.env.XDG_CONFIG_HOME = configDir
      const marker = join(dir, "started")
      const pidFile = join(dir, "child.pid")
      const bin = await makeFakeOpencode(dir, `
        const fs = require("node:fs")
        const cp = require("node:child_process")
        if (process.argv[2] === "service" && process.argv[3] === "status") {
          if (fs.existsSync(${JSON.stringify(marker)})) console.log("http://127.0.0.1:4098")
        } else if (process.argv[2] === "service" && process.argv[3] === "start") {
          const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "inherit", detached: true })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          fs.writeFileSync(${JSON.stringify(marker)}, "1")
          child.unref()
        }
      `)
      const start = Date.now()
      const up = await resolveUpstream({ opencodeBin: bin, autostart: true })
      expect(Date.now() - start).toBeLessThan(10_000)
      expect(up.url).toBe("http://127.0.0.1:4098")
      const pidText = await Bun.file(pidFile).text().catch(() => "")
      childPid = Number(pidText) || undefined
    } finally {
      if (childPid) try { process.kill(childPid) } catch {}
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }, 15_000)

  test("reports a clear error when opencode binary is missing or autostart is disabled", async () => {
    await expect(resolveUpstream({ opencodeBin: "definitely-missing-opencode-bin-xyz", autostart: false })).rejects.toThrow("OpenCode CLI")
    const dir = await mkdtemp(join(tmpdir(), "canvas-upstream-stopped-"))
    try {
      const bin = await makeFakeOpencode(dir, `console.log("stopped")`)
      await expect(resolveUpstream({ opencodeBin: bin, autostart: false })).rejects.toThrow("OpenCode background service is not running")
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

describe("authHeader", () => {
  test("encodes basic auth only when a password is present", () => {
    expect(authHeader({ url: "http://h", username: "opencode", source: "explicit" })).toBeUndefined()
    expect(authHeader({ url: "http://h", username: "opencode", password: "pw", source: "explicit" }))
      .toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
  })
})
