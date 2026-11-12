// Session loops: keep prompting an idle session until it finishes, fails,
// hits a stop phrase, or you stop it. Think "Ralph loop" / auto-continue.
//
// The manager is client-side only: it watches the event stream (via Store)
// and re-prompts through the Backend when a looped session goes idle. Loops
// pause while a session needs input (permission/question) or is still
// running, and resume on the next settled event.

import { lastAssistantText } from "./format"
import type { Backend } from "./backend"
import type { Message, OcEvent } from "./types"
import type { Store } from "./store"

export const DEFAULT_LOOP_PROMPT =
  "Continue with the task. If the task is complete, reply with DONE and stop; otherwise keep working."
export const DEFAULT_MAX_ITERATIONS = 10
export const MAX_MAX_ITERATIONS = 200
export const DEFAULT_DELAY_MS = 3000
const STORAGE_KEY = "occ.loops.v1"

export interface LoopOptions {
  prompt: string
  maxIterations?: number
  delayMs?: number
  stopPhrase?: string
  stopOnError?: boolean
}

export type LoopStatus = "active" | "finished" | "stopped" | "error"

export interface LoopInfo {
  sessionID: string
  prompt: string
  iterations: number
  maxIterations: number
  delayMs: number
  stopPhrase?: string
  stopOnError: boolean
  status: LoopStatus
  reason?: string
  updatedAt: number
}

interface LoopStoreShape {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

function defaultStore(): LoopStoreShape | undefined {
  try {
    if (typeof localStorage !== "undefined") return localStorage
  } catch { /* private mode */ }
  return undefined
}

const defaultTimers: LoopTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function normalizeLoopOptions(opts: LoopOptions): Required<Pick<LoopOptions, "prompt" | "maxIterations" | "delayMs" | "stopOnError">> & Pick<LoopOptions, "stopPhrase"> {
  const prompt = opts.prompt.trim()
  if (!prompt) throw new Error("Loop prompt can't be empty")
  const rawMax = opts.maxIterations
  const maxIterations = Math.min(
    MAX_MAX_ITERATIONS,
    Math.max(1, Number.isFinite(rawMax) ? Math.floor(rawMax as number) : DEFAULT_MAX_ITERATIONS),
  )
  const rawDelay = opts.delayMs
  const delayMs = Math.min(600_000, Math.max(0, Number.isFinite(rawDelay) ? Math.floor(rawDelay as number) : DEFAULT_DELAY_MS))
  const stopPhrase = opts.stopPhrase?.trim() || undefined
  return { prompt, maxIterations, delayMs, stopPhrase, stopOnError: opts.stopOnError ?? true }
}

function splitLoopTokens(raw: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: '"' | "'" | undefined
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
        cur += raw[++i]
      } else if (ch === quote) {
        quote = undefined
        cur += ch
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ""
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

const unquote = (s: string) => {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1)
  return s
}

/** Split `/loop` remainder into options. Flags (case-insensitive values kept):
 *  --count N | -n N, --delay Ms | --delay-secs S, --stop TEXT | --until TEXT,
 *  --continue-on-error. Everything else is the prompt. */
export function parseLoopArgs(raw: string): LoopOptions {
  const tokens = splitLoopTokens(raw)
  const promptParts: string[] = []
  let maxIterations: number | undefined
  let delayMs: number | undefined
  let stopPhrase: string | undefined
  let stopOnError = true

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i]
    const eq = rawTok.indexOf("=")
    const flag = (eq >= 0 ? rawTok.slice(0, eq) : rawTok).toLowerCase()
    const takeVal = (): string | undefined => {
      if (eq >= 0) return unquote(rawTok.slice(eq + 1))
      if (i + 1 < tokens.length) return unquote(tokens[++i])
      return undefined
    }

    if (flag === "--count" || flag === "-n" || flag === "--iterations") {
      const v = takeVal()?.trim() ?? ""
      if (v) {
        const n = Math.floor(Number(v))
        if (Number.isFinite(n)) maxIterations = n
      }
    } else if (flag === "--delay") {
      const v = takeVal()?.trim() ?? ""
      if (v) {
        const n = Number(v)
        if (Number.isFinite(n)) delayMs = n
      }
    } else if (flag === "--delay-secs" || flag === "--delay-seconds" || flag === "--delay-s") {
      const v = takeVal()?.trim() ?? ""
      if (v) {
        const n = Number(v)
        if (Number.isFinite(n)) delayMs = n * 1000
      }
    } else if (flag === "--stop" || flag === "--until" || flag === "--stop-phrase") {
      const v = takeVal()
      if (v !== undefined) stopPhrase = v.trim() || undefined
    } else if (flag === "--continue-on-error" || flag === "--no-stop-on-error") {
      stopOnError = false
    } else if (flag === "--stop-on-error") {
      stopOnError = true
    } else {
      promptParts.push(rawTok)
    }
  }
  return {
    prompt: unquote(promptParts.join(" ").trim()) || DEFAULT_LOOP_PROMPT,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(stopPhrase ? { stopPhrase } : {}),
    stopOnError,
  }
}

/** Newest-first messages -> latest assistant text ("" when none). */
export function latestAssistantText(desc: Message[]): string {
  for (const m of desc) {
    if (m.type === "assistant") {
      const text = lastAssistantText(m.content)
      if (text.trim()) return text
    }
  }
  return ""
}

export function matchesStopPhrase(desc: Message[], phrase: string | undefined): boolean {
  const p = phrase?.trim().toLowerCase()
  if (!p) return false
  return latestAssistantText(desc).toLowerCase().includes(p)
}

type MinimalStore = Pick<Store, "running" | "needsInput"> & {
  loaded?: boolean
  sessions?: Map<string, unknown>
  on(l: { event?: (ev: OcEvent) => void; structure?: () => void }): () => void
}
type MinimalBackend = Pick<Backend, "prompt" | "messages">

export class LoopManager {
  private loops = new Map<string, LoopInfo>()
  private timers = new Map<string, unknown>()
  private inflight = new Map<string, LoopInfo>()
  private listeners = new Set<() => void>()
  private storeIO: LoopStoreShape | undefined
  private timersIO: LoopTimers
  private detach?: () => void
  private restoreTimer?: unknown
  private pendingRestoreKick = false
  private destroyed = false

  constructor(
    private store: MinimalStore,
    private backend: MinimalBackend,
    io?: { storage?: LoopStoreShape | null; timers?: LoopTimers },
  ) {
    this.storeIO = io?.storage !== undefined ? (io.storage ?? undefined) : defaultStore()
    this.timersIO = io?.timers ?? defaultTimers
    this.restore()
    this.detach = this.store.on({
      event: (ev) => void this.handleEvent(ev),
      structure: () => this.onStructure(),
    })
  }

  destroy() {
    this.destroyed = true
    this.detach?.()
    if (this.restoreTimer !== undefined) {
      this.timersIO.clearTimeout(this.restoreTimer)
      this.restoreTimer = undefined
    }
    this.pendingRestoreKick = false
    for (const t of this.timers.values()) this.timersIO.clearTimeout(t)
    this.timers.clear()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    this.persist()
    for (const fn of this.listeners) {
      try { fn() } catch { /* UI listener */ }
    }
  }

  list(): LoopInfo[] {
    return [...this.loops.values()].map((l) => ({ ...l })).sort((a, b) => a.updatedAt - b.updatedAt)
  }

  get(sessionID: string): LoopInfo | undefined {
    const l = this.loops.get(sessionID)
    return l ? { ...l } : undefined
  }

  isLooping(sessionID: string): boolean {
    return this.loops.get(sessionID)?.status === "active"
  }

  loopCount(): number {
    let n = 0
    for (const l of this.loops.values()) if (l.status === "active") n++
    return n
  }

  start(sessionID: string, opts: LoopOptions): LoopInfo {
    const norm = normalizeLoopOptions(opts)
    this.clearTimer(sessionID)
    const prev = this.loops.get(sessionID)
    const info: LoopInfo = {
      sessionID,
      prompt: norm.prompt,
      iterations: prev?.status === "active" ? prev.iterations : 0,
      maxIterations: norm.maxIterations,
      delayMs: norm.delayMs,
      stopPhrase: norm.stopPhrase,
      stopOnError: norm.stopOnError,
      status: "active",
      reason: undefined,
      updatedAt: Date.now(),
    }
    if (this.destroyed) return { ...info }
    this.loops.set(sessionID, info)
    this.emit()
    // If the session is already idle, kick off the next iteration without
    // waiting for another settled event (e.g. loop created after finish).
    void this.maybeKick(sessionID)
    return { ...info }
  }

  /** Restart the iteration counter as well (fresh loop). */
  restart(sessionID: string, opts: LoopOptions): LoopInfo {
    this.clearTimer(sessionID)
    this.loops.delete(sessionID)
    return this.start(sessionID, opts)
  }

  stop(sessionID: string, reason = "Stopped"): LoopInfo | undefined {
    const cur = this.loops.get(sessionID)
    this.clearTimer(sessionID)
    if (!cur) return undefined
    if (cur.status !== "active") return { ...cur }
    const next: LoopInfo = { ...cur, status: "stopped", reason, updatedAt: Date.now() }
    this.loops.set(sessionID, next)
    this.emit()
    return { ...next }
  }

  clear(sessionID: string) {
    this.clearTimer(sessionID)
    if (this.loops.delete(sessionID)) this.emit()
  }

  clearFinished() {
    let changed = false
    for (const [id, l] of this.loops) {
      if (l.status !== "active") {
        this.clearTimer(id)
        this.loops.delete(id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private clearTimer(sessionID: string) {
    const t = this.timers.get(sessionID)
    if (t !== undefined) {
      this.timersIO.clearTimeout(t)
      this.timers.delete(sessionID)
    }
  }

  private finish(sessionID: string, status: LoopStatus, reason: string) {
    if (this.destroyed) return
    const cur = this.loops.get(sessionID)
    this.clearTimer(sessionID)
    if (!cur || cur.status !== "active") return
    this.loops.set(sessionID, { ...cur, status, reason, updatedAt: Date.now() })
    this.emit()
  }

  private onStructure() {
    if (this.destroyed || !this.pendingRestoreKick) return
    if (this.store.loaded === false) return
    this.pendingRestoreKick = false
    this.kickRestored()
  }

  private kickRestored() {
    if (this.destroyed) return
    for (const id of [...this.loops.keys()]) {
      const loop = this.loops.get(id)
      if (!loop || loop.status !== "active") continue
      if (this.store.loaded === true && this.store.sessions && !this.store.sessions.has(id)) continue
      if (loop.iterations > 0 && loop.stopPhrase) void this.checkStopAndKick(id, loop)
      else void this.maybeKick(id)
    }
  }

  private async checkStopAndKick(id: string, loop: LoopInfo): Promise<void> {
    if (this.destroyed || this.loops.get(id) !== loop || loop.status !== "active") return
    if (this.inflight.has(id) || this.store.running.has(id) || this.store.needsInput(id)) return
    if (loop.iterations >= loop.maxIterations) {
      this.finish(id, "finished", `Done after ${loop.iterations} iteration${loop.iterations === 1 ? "" : "s"}`)
      return
    }
    if (loop.stopPhrase) {
      try {
        const page = await this.backend.messages(id, 10)
        if (this.destroyed || this.loops.get(id) !== loop || loop.status !== "active") return
        if (this.inflight.has(id) || this.store.running.has(id) || this.store.needsInput(id)) return
        if (matchesStopPhrase(page.data, loop.stopPhrase)) {
          this.finish(id, "finished", `Stop phrase "${loop.stopPhrase}" found`)
          return
        }
      } catch {
        if (this.destroyed || this.loops.get(id) !== loop || loop.status !== "active") return
      }
    }
    void this.maybeKick(id)
  }

  private async handleEvent(ev: OcEvent) {
    if (this.destroyed) return
    const id: string | undefined = ev.data?.sessionID
    if (!id) return
    if (ev.type === "session.deleted") {
      this.clear(id)
      return
    }
    if (
      ev.type === "session.execution.succeeded" ||
      ev.type === "session.execution.failed" ||
      ev.type === "session.execution.interrupted"
    ) {
      const outcome = ev.type.endsWith("succeeded") ? "succeeded" : ev.type.endsWith("failed") ? "failed" : "interrupted"
      await this.onSettled(id, outcome)
    }
  }

  private async onSettled(id: string, outcome: "succeeded" | "failed" | "interrupted"): Promise<void> {
    if (this.destroyed) return
    const loop = this.loops.get(id)
    if (!loop || loop.status !== "active") return
    // Never talk over the agent: waiting turns, permission prompts and
    // questions all pause the loop until the next settled event.
    if (this.store.running.has(id)) return
    if (this.store.needsInput(id)) return
    if (outcome === "interrupted") {
      // A manual Stop interrupts the run; that stops the loop too so Canvas
      // doesn't immediately restart what you just killed. Restart to continue.
      this.finish(id, "stopped", "Stopped with the session")
      return
    }
    if (outcome === "failed" && loop.stopOnError) {
      this.finish(id, "error", "Stopped: last run failed")
      return
    }
    if (loop.iterations >= loop.maxIterations) {
      this.finish(id, "finished", `Done after ${loop.iterations} iteration${loop.iterations === 1 ? "" : "s"}`)
      return
    }
    if (loop.stopPhrase) {
      try {
        const page = await this.backend.messages(id, 10)
        if (this.destroyed || this.loops.get(id) !== loop || loop.status !== "active") return
        if (this.store.running.has(id) || this.store.needsInput(id)) return
        if (matchesStopPhrase(page.data, loop.stopPhrase)) {
          this.finish(id, "finished", `Stop phrase "${loop.stopPhrase}" found`)
          return
        }
      } catch {
        if (this.destroyed || this.loops.get(id) !== loop || loop.status !== "active") return
        // A failed history read shouldn't kill the loop; try the prompt anyway.
      }
    }
    this.schedule(id)
  }

  private async maybeKick(id: string): Promise<void> {
    if (this.destroyed) return
    const loop = this.loops.get(id)
    if (!loop || loop.status !== "active") return
    if (this.inflight.has(id)) return
    if (this.store.running.has(id)) return
    if (this.store.needsInput(id)) return
    if (loop.iterations >= loop.maxIterations) {
      this.finish(id, "finished", `Done after ${loop.iterations} iteration${loop.iterations === 1 ? "" : "s"}`)
      return
    }
    this.schedule(id)
  }

  private schedule(id: string) {
    if (this.destroyed) return
    const loop = this.loops.get(id)
    if (!loop || loop.status !== "active") return
    if (this.inflight.has(id)) return
    this.clearTimer(id)
    const delay = Math.max(0, loop.delayMs)
    if (delay === 0) {
      void this.fire(id)
      return
    }
    this.timers.set(id, this.timersIO.setTimeout(() => void this.fire(id), delay))
  }

  private async fire(id: string): Promise<void> {
    this.timers.delete(id)
    if (this.destroyed) return
    const loop = this.loops.get(id)
    if (!loop || loop.status !== "active") return
    if (this.inflight.has(id)) return
    // Re-check right before sending: the session may have started again, or
    // be waiting on you. In both cases the next settled event resumes us.
    if (this.store.running.has(id)) return
    if (this.store.needsInput(id)) return
    if (loop.iterations >= loop.maxIterations) {
      this.finish(id, "finished", `Done after ${loop.iterations} iteration${loop.iterations === 1 ? "" : "s"}`)
      return
    }
    this.inflight.set(id, loop)
    let settledAs: LoopInfo | undefined
    try {
      await this.backend.prompt(id, { text: loop.prompt })
      const cur = this.loops.get(id)
      if (!this.destroyed && cur === loop && cur.status === "active") {
        settledAs = { ...cur, iterations: cur.iterations + 1, reason: undefined, updatedAt: Date.now() }
        this.loops.set(id, settledAs)
        this.emit()
      }
    } catch (e) {
      const cur = this.loops.get(id)
      if (!this.destroyed && cur === loop && cur.status === "active") {
        settledAs = { ...cur, reason: `Last send failed: ${(e as Error).message}`, updatedAt: Date.now() }
        this.loops.set(id, settledAs)
        this.emit()
      }
      // Retry on the next settled event or an explicit restart; don't spin.
    } finally {
      if (this.inflight.get(id) === loop) this.inflight.delete(id)
      const cur = this.loops.get(id)
      if (!this.destroyed && cur && cur !== loop && cur !== settledAs && cur.status === "active" && !this.timers.has(id)) {
        void this.maybeKick(id)
      }
    }
  }

  private restore() {
    if (!this.storeIO) return
    try {
      const raw = this.storeIO.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as LoopInfo[]
      if (!Array.isArray(arr)) return
      let hasActive = false
      for (const l of arr) {
        if (!l || typeof l.sessionID !== "string" || typeof l.prompt !== "string") continue
        let norm: ReturnType<typeof normalizeLoopOptions>
        try {
          norm = normalizeLoopOptions({
            prompt: l.prompt,
            maxIterations: l.maxIterations,
            delayMs: l.delayMs,
            stopPhrase: typeof l.stopPhrase === "string" ? l.stopPhrase : undefined,
            stopOnError: typeof l.stopOnError === "boolean" ? l.stopOnError : true,
          })
        } catch {
          continue
        }
        const iterations = Number.isFinite(l.iterations) ? Math.max(0, Math.floor(l.iterations)) : 0
        const updatedAt = Number.isFinite(l.updatedAt) ? l.updatedAt : Date.now()
        // A reload interrupts the timer chain; resume as active so the next
        // settled event (or the kick below) continues the loop. Iteration
        // counts survive so `/loop --count` stays bounded across reloads.
        if (l.status === "active") {
          hasActive = true
          this.loops.set(l.sessionID, {
            sessionID: l.sessionID,
            prompt: norm.prompt,
            iterations,
            maxIterations: norm.maxIterations,
            delayMs: norm.delayMs,
            stopPhrase: norm.stopPhrase,
            stopOnError: norm.stopOnError,
            status: "active",
            reason: undefined,
            updatedAt: Date.now(),
          })
        } else if (l.status === "finished" || l.status === "stopped" || l.status === "error") {
          this.loops.set(l.sessionID, {
            sessionID: l.sessionID,
            prompt: norm.prompt,
            iterations,
            maxIterations: norm.maxIterations,
            delayMs: norm.delayMs,
            stopPhrase: norm.stopPhrase,
            stopOnError: norm.stopOnError,
            status: l.status,
            reason: typeof l.reason === "string" ? l.reason : undefined,
            updatedAt,
          })
        }
      }
      if (hasActive) {
        // Kick idle sessions after restore once Store has finished initial sync.
        this.restoreTimer = this.timersIO.setTimeout(() => {
          this.restoreTimer = undefined
          if (this.destroyed) return
          if (this.store.loaded === false) {
            this.pendingRestoreKick = true
            return
          }
          this.kickRestored()
        }, 1500)
      }
    } catch { /* corrupt storage */ }
  }

  private persist() {
    if (!this.storeIO) return
    try {
      // Cap stored loops while always keeping active loops before evicting finished ones.
      const arr = [...this.loops.values()]
        .sort((a, b) => (a.status === "active" ? 1 : 0) - (b.status === "active" ? 1 : 0) || a.updatedAt - b.updatedAt)
        .slice(-50)
      this.storeIO.setItem(STORAGE_KEY, JSON.stringify(arr))
    } catch { /* private mode */ }
  }
}
