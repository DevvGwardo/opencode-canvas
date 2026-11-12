import { describe, expect, test } from "bun:test"
import {
  DEFAULT_LOOP_PROMPT,
  LoopManager,
  latestAssistantText,
  matchesStopPhrase,
  normalizeLoopOptions,
  parseLoopArgs,
} from "../src/app/loops"
import type { Message, OcEvent } from "../src/app/types"

function assistantText(text: string): Message {
  return {
    type: "assistant",
    id: "m1",
    time: { created: 1 },
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [{ type: "text", text }],
  }
}

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

function makeHarness(opts?: {
  running?: boolean
  needsInput?: "permission" | "question"
  messages?: Message[]
  loaded?: boolean
  sessions?: Map<string, unknown>
  storage?: ReturnType<typeof makeMemoryStorage> | null
}) {
  const prompts: string[] = []
  const events: Array<(ev: OcEvent) => void> = []
  const structures: Array<() => void> = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  const store: any = {
    running: new Set<string>(opts?.running ? ["ses_1"] : []),
    needsInput: (_id: string) => opts?.needsInput,
    ...(opts?.loaded !== undefined ? { loaded: opts.loaded } : {}),
    ...(opts?.sessions ? { sessions: opts.sessions } : {}),
    on: (l: { event?: (ev: OcEvent) => void; structure?: () => void }) => {
      if (l.event) events.push(l.event)
      if (l.structure) structures.push(l.structure)
      return () => {}
    },
  }
  const backend: any = {
    prompt: async (_id: string, input: { text: string }) => {
      prompts.push(input.text)
    },
    messages: async (_id: string, _limit: number) => ({ data: opts?.messages ?? [assistantText("working on it")] }),
  }
  const emit = (type: string, sessionID = "ses_1") =>
    events.forEach((fn) => fn({ id: "e", type, created: Date.now(), data: { sessionID } }))
  const emitStructure = () => structures.forEach((fn) => fn())
  const io = {
    storage: opts?.storage === undefined ? null : opts.storage,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const h = nextTimer++
        timers.set(h, { fn, ms })
        return h
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number)
      },
    },
  }
  const runTimers = async () => {
    while (timers.size) {
      const entries = [...timers.values()]
      timers.clear()
      for (const entry of entries) entry.fn()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { store, backend, prompts, emit, emitStructure, runTimers, timers, io }
}

describe("loop arg parsing", () => {
  test("defaults to the continue prompt", () => {
    expect(parseLoopArgs("").prompt).toBe(DEFAULT_LOOP_PROMPT)
    expect(parseLoopArgs("--count 3").maxIterations).toBe(3)
  })

  test("parses count, delay and stop phrase", () => {
    const o = parseLoopArgs('keep going --count 5 --delay-secs 10 --stop "ALL DONE"')
    expect(o.prompt).toBe("keep going")
    expect(o.maxIterations).toBe(5)
    expect(o.delayMs).toBe(10_000)
    expect(o.stopPhrase).toBe("ALL DONE")
  })

  test("supports = flags, escaped quotes, Windows backslashes, and ignores empty trailing values", () => {
    const eq = parseLoopArgs('--count=4 --delay=250 --stop="ALL \\"DONE\\"" Fix C:\\Users\\torre\\app.ts')
    expect(eq.maxIterations).toBe(4)
    expect(eq.delayMs).toBe(250)
    expect(eq.stopPhrase).toBe('ALL "DONE"')
    expect(eq.prompt).toBe("Fix C:\\Users\\torre\\app.ts")

    const secsEq = parseLoopArgs('--delay-secs=3 --stop-phrase=FINISHED go')
    expect(secsEq.delayMs).toBe(3000)
    expect(secsEq.stopPhrase).toBe("FINISHED")
    expect(secsEq.prompt).toBe("go")

    const missing = parseLoopArgs("keep going --count")
    expect(missing.maxIterations).toBeUndefined()
    expect(parseLoopArgs("keep going --delay").delayMs).toBeUndefined()
    expect(parseLoopArgs("keep going --delay-secs").delayMs).toBeUndefined()
  })

  test("continue-on-error flips stopOnError", () => {
    expect(parseLoopArgs("go --continue-on-error").stopOnError).toBe(false)
    expect(parseLoopArgs("go").stopOnError).toBe(true)
  })

  test("normalizes bounds", () => {
    expect(normalizeLoopOptions({ prompt: "x", maxIterations: 999 }).maxIterations).toBe(200)
    expect(normalizeLoopOptions({ prompt: "x", maxIterations: 0 }).maxIterations).toBe(1)
    expect(() => normalizeLoopOptions({ prompt: "  " })).toThrow("empty")
  })
})

describe("stop phrase matching", () => {
  test("finds the latest assistant text case-insensitively", () => {
    const msgs = [assistantText("DONE, all green")]
    expect(latestAssistantText(msgs)).toContain("DONE")
    expect(matchesStopPhrase(msgs, "done")).toBe(true)
    expect(matchesStopPhrase(msgs, "nope")).toBe(false)
    expect(matchesStopPhrase([], "done")).toBe(false)
    expect(matchesStopPhrase(msgs, undefined)).toBe(false)
  })
})

describe("LoopManager", () => {
  test("re-prompts on success until maxIterations", async () => {
    const h = makeHarness()
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "keep going", maxIterations: 2, delayMs: 100 })
    expect(loops.isLooping("ses_1")).toBe(true)
    await h.emit("session.execution.succeeded")
    await h.runTimers()
    expect(h.prompts).toEqual(["keep going"])
    expect(loops.get("ses_1")?.iterations).toBe(1)
    await h.emit("session.execution.succeeded")
    await h.runTimers()
    expect(h.prompts).toEqual(["keep going", "keep going"])
    // Third finish hits the cap.
    await h.emit("session.execution.succeeded")
    expect(loops.get("ses_1")?.status).toBe("finished")
    loops.destroy()
  })

  test("pauses while input is needed and stops manual interrupts", async () => {
    const h = makeHarness({ needsInput: "permission" })
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "go", maxIterations: 5, delayMs: 10 })
    await h.emit("session.execution.succeeded")
    await h.runTimers()
    expect(h.prompts).toEqual([])
    expect(loops.isLooping("ses_1")).toBe(true)
    loops.destroy()

    const h2 = makeHarness()
    const loops2 = new LoopManager(h2.store, h2.backend, h2.io)
    loops2.start("ses_1", { prompt: "go", delayMs: 10 })
    await h2.emit("session.execution.interrupted")
    expect(loops2.get("ses_1")?.status).toBe("stopped")
    expect(h2.prompts).toEqual([])
    loops2.destroy()
  })

  test("stops on failure by default, continues when asked", async () => {
    const h = makeHarness()
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "go", delayMs: 10 })
    await h.emit("session.execution.failed")
    expect(loops.get("ses_1")?.status).toBe("error")
    loops.destroy()

    const h2 = makeHarness()
    const loops2 = new LoopManager(h2.store, h2.backend, h2.io)
    loops2.start("ses_1", { prompt: "go", delayMs: 10, stopOnError: false })
    await h2.emit("session.execution.failed")
    await h2.runTimers()
    expect(h2.prompts).toEqual(["go"])
    loops2.destroy()
  })

  test("stops when the stop phrase appears", async () => {
    const h = makeHarness({ messages: [assistantText("All done, DONE")] })
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "go", delayMs: 10, stopPhrase: "done" })
    await h.emit("session.execution.succeeded")
    await h.runTimers()
    expect(h.prompts).toEqual([])
    expect(loops.get("ses_1")?.status).toBe("finished")
    loops.destroy()
  })

  test("stop() and restart() behave and stop() preserves non-active status", () => {
    const h = makeHarness()
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "a", maxIterations: 3, delayMs: 100 })
    expect(loops.loopCount()).toBe(1)
    h.store.running.add("ses_1")
    // Restart while a timer might have been armed clears the timer cleanly.
    loops.restart("ses_1", { prompt: "b", maxIterations: 1, delayMs: 100 })
    expect(h.timers.size).toBe(0)
    expect(loops.get("ses_1")?.prompt).toBe("b")
    expect(loops.get("ses_1")?.iterations).toBe(0)
    h.store.running.delete("ses_1")
    loops.stop("ses_1")
    expect(loops.isLooping("ses_1")).toBe(false)

    // Stopping an already-finished or errored loop keeps its finished/error status.
    loops.start("ses_1", { prompt: "c", delayMs: 100 })
    h.emit("session.execution.failed")
    expect(loops.get("ses_1")?.status).toBe("error")
    const after = loops.stop("ses_1")
    expect(after?.status).toBe("error")
    expect(loops.get("ses_1")?.status).toBe("error")
    loops.destroy()
  })

  test("returns copies from get/list and clears stale error reason on successful prompt", async () => {
    const h = makeHarness({ running: true })
    let fail = true
    h.backend.prompt = async (_id: string, input: { text: string }) => {
      if (fail) throw new Error("network glitch")
      h.prompts.push(input.text)
    }
    const loops = new LoopManager(h.store, h.backend, h.io)
    const info = loops.start("ses_1", { prompt: "go", delayMs: 0 })
    info.prompt = "mutated"
    expect(loops.get("ses_1")?.prompt).toBe("go")

    h.store.running.delete("ses_1")
    h.emit("session.execution.succeeded")
    await new Promise((r) => setTimeout(r, 0))
    expect(loops.get("ses_1")?.reason).toContain("network glitch")

    fail = false
    h.emit("session.execution.succeeded")
    await new Promise((r) => setTimeout(r, 0))
    expect(h.prompts).toEqual(["go"])
    expect(loops.get("ses_1")?.reason).toBeUndefined()
    expect(loops.get("ses_1")?.iterations).toBe(1)
    loops.destroy()
  })

  test("ignores stale stop-phrase lookups and prevents overlapping inflight prompts", async () => {
    const h = makeHarness({ running: true })
    let releaseMessages!: (v: { data: Message[] }) => void
    h.backend.messages = () => new Promise((res) => { releaseMessages = res })
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "old", delayMs: 10, stopPhrase: "DONE" })

    h.store.running.delete("ses_1")
    const pendingSettled = h.emit("session.execution.succeeded")
    // Restart while backend.messages is still in flight; keep session running so new loop stays armed.
    h.store.running.add("ses_1")
    loops.restart("ses_1", { prompt: "fresh", delayMs: 10 })
    releaseMessages({ data: [assistantText("DONE")] })
    await pendingSettled
    await new Promise((r) => setTimeout(r, 0))
    // Stale "DONE" lookup from old loop must not finish the new loop.
    expect(loops.get("ses_1")?.status).toBe("active")
    expect(loops.get("ses_1")?.prompt).toBe("fresh")

    // Inflight guard: with delayMs: 0, concurrent kick/settled does not double-send while prompt awaits.
    let releasePrompt!: () => void
    h.backend.prompt = (_id: string, input: { text: string }) => {
      h.prompts.push(input.text)
      return new Promise<void>((res) => { releasePrompt = res })
    }
    h.store.running.delete("ses_1")
    loops.restart("ses_1", { prompt: "first", delayMs: 0 })
    h.emit("session.execution.succeeded")
    expect(h.prompts).toEqual(["first"])
    // Restart while first prompt is still awaiting -> kicks new loop as soon as inflight settles.
    loops.restart("ses_1", { prompt: "second", delayMs: 0 })
    releasePrompt()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.prompts).toEqual(["first", "second"])
    loops.destroy()
  })

  test("restore uses timersIO, waits for store.loaded, skips missing sessions, and honors stopPhrase", async () => {
    const storage = makeMemoryStorage({
      "occ.loops.v1": JSON.stringify([
        {
          sessionID: "ses_1",
          prompt: "resume task",
          iterations: 2,
          maxIterations: 5,
          delayMs: 0,
          stopPhrase: "ALL DONE",
          stopOnError: true,
          status: "active",
          updatedAt: 1000,
        },
        {
          sessionID: "ses_missing",
          prompt: "ghost",
          iterations: 0,
          maxIterations: 5,
          delayMs: 0,
          stopOnError: true,
          status: "active",
          updatedAt: 1001,
        },
      ]),
    })
    const sessions = new Map<string, unknown>([["ses_1", { id: "ses_1" }]])
    const h = makeHarness({
      storage,
      loaded: false,
      sessions,
      messages: [assistantText("Finished! ALL DONE")],
    })
    const loops = new LoopManager(h.store, h.backend, h.io)
    // Restore timer is registered on injected timersIO (1500ms).
    expect(h.timers.size).toBe(1)
    expect([...h.timers.values()][0].ms).toBe(1500)

    // Firing while store.loaded === false defers kicking until structure notifies.
    await h.runTimers()
    expect(h.prompts).toEqual([])
    expect(loops.isLooping("ses_1")).toBe(true)

    h.store.loaded = true
    h.emitStructure()
    await new Promise((r) => setTimeout(r, 0))
    // ses_1 saw stopPhrase while offline (iterations > 0), so it finishes instead of re-prompting; ses_missing was skipped.
    expect(loops.get("ses_1")?.status).toBe("finished")
    expect(h.prompts).toEqual([])
    loops.destroy()

    // destroy() cancels pending restoreTimer cleanly.
    const h2 = makeHarness({ storage })
    const loops2 = new LoopManager(h2.store, h2.backend, h2.io)
    expect(h2.timers.size).toBe(1)
    loops2.destroy()
    expect(h2.timers.size).toBe(0)
  })

  test("persist keeps active loops when over 50 finished loops exist", () => {
    const storage = makeMemoryStorage()
    const h = makeHarness({ storage, running: true })
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_active", { prompt: "stay alive", delayMs: 100 })
    h.store.running.add("ses_other")
    for (let i = 0; i < 60; i++) {
      const id = `ses_done_${i}`
      h.store.running.delete(id)
      loops.start(id, { prompt: "x", delayMs: 100 })
      h.emit("session.execution.failed", id)
    }
    const stored = JSON.parse(storage.getItem("occ.loops.v1")!) as Array<{ sessionID: string; status: string }>
    expect(stored.length).toBe(50)
    expect(stored.some((l) => l.sessionID === "ses_active" && l.status === "active")).toBe(true)
    loops.destroy()
  })
})
