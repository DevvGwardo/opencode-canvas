// Opt-in: tests a private OpenCode process, never the user's running service.
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formAnswer } from "../src/app/forms"
import type { FormField, FormInfo } from "../src/app/types"

const executable = process.env.OPENCODE_TEST_BIN

test.skipIf(!executable)("question answers conform to an isolated OpenCode v2 server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-opencode-test-"))
  const password = crypto.randomUUID()
  let proc: Bun.Subprocess | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (const name of ["config", "data", "cache", "home", "project"]) await mkdir(join(directory, name))
    const config = join(directory, "config.json")
    await writeFile(config, "{}")
    proc = Bun.spawn([executable!, "serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "none"], {
      cwd: join(directory, "project"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(directory, "home"),
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
        OPENCODE_CONFIG: config,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const ready = new Promise<string>((resolve, reject) => {
      const read = async (stream: ReadableStream<Uint8Array>) => {
        let text = ""
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            text += decoder.decode(value, { stream: true })
            const match = text.match(/http:\/\/127\.0\.0\.1:\d+/)
            if (match) resolve(match[0])
            // Startup output is deliberately not logged, even on failure.
            if (text.length > 32_000) text = text.slice(-16_000)
          }
        } finally {
          reader.releaseLock()
        }
      }
      void read(proc!.stdout as ReadableStream<Uint8Array>).catch(reject)
      void read(proc!.stderr as ReadableStream<Uint8Array>).catch(reject)
      void proc!.exited.then((code) => reject(new Error(`Isolated OpenCode exited (${code})`)))
      timer = setTimeout(() => reject(new Error("Isolated OpenCode startup timed out")), 20_000)
    })
    const base = await ready
    clearTimeout(timer)
    const request = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Basic " + btoa("opencode:" + password), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const text = await res.text()
      return { status: res.status, data: text ? JSON.parse(text).data : undefined }
    }
    const session = await request("/api/session", { location: { directory: join(directory, "project") }, title: "Synthetic Canvas validation" })
    expect(session.status).toBe(200)
    const path = `/api/session/${session.data.id}/form`
    const answer = async (fields: FormField[], values: Record<string, unknown>) => {
      const created = await request(path, { title: "Synthetic question", fields })
      expect(created.status).toBe(200)
      const form = created.data as FormInfo
      const pending = await request("/api/form?" + new URLSearchParams({ "location[directory]": join(directory, "project") }))
      expect(pending.status).toBe(200)
      expect(pending.data.some((f: FormInfo) => f.id === form.id)).toBe(true)
      const reply = await request(`${path}/${form.id}/reply`, { answer: formAnswer(fields, values) })
      expect(reply.status).toBe(204)
      const detail = await request(`${path}/${form.id}`)
      expect(detail.data.state.status).toBe("answered")
      return detail.data.state.answer
    }
    expect(await answer([
      { key: "choice", type: "string", custom: true, options: [{ value: "a", label: "A" }] },
      { key: "number", type: "number", minimum: 0, maximum: 2 },
      { key: "flag", type: "boolean" },
      { key: "context", type: "string", hidden: true, default: "fixture" },
    ], { choice: "custom", number: 1.5, flag: false })).toMatchObject({ choice: "custom", number: 1.5, flag: false, context: "fixture" })
    expect(await answer([
      { key: "mode", type: "string", options: [{ value: "skip", label: "Skip" }, { value: "include", label: "Include" }] },
      { key: "details", type: "string", required: true, when: [{ key: "mode", op: "eq", value: "include" }], minLength: 3 },
    ], { mode: "skip" })).toEqual({ mode: "skip" })
    expect(await answer([
      { key: "items", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }], minItems: 1, maxItems: 2 },
    ], { items: ["a", "Austin, TX"] })).toEqual({ items: ["a", "Austin, TX"] })
  } finally {
    clearTimeout(timer)
    if (proc && proc.exitCode === null) {
      proc.kill()
      await Promise.race([proc.exited, Bun.sleep(3_000)])
      if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited }
    }
    // Only the temporary directory created by this test is removed.
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
