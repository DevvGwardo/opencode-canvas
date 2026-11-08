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

function makeHarness(opts?: { running?: boolean; needsInput?: "permission" | "question"; messages?: Message[] }) {
  const prompts: string[] = []
  const events: Array<(ev: OcEvent) => void> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const store: any = {
    running: new Set<string>(opts?.running ? ["ses_1"] : []),
    needsInput: (_id: string) => opts?.needsInput,
    on: (l: { event?: (ev: OcEvent) => void }) => {
      if (l.event) events.push(l.event)
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
  const io = {
    storage: null,
    timers: {
      setTimeout: (fn: () => void, _ms: number) => {
        const h = nextTimer++
        timers.set(h, fn)
        return h
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number)
      },
    },
  }
  const runTimers = async () => {
    while (timers.size) {
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) fn()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { store, backend, prompts, emit, runTimers, timers, io }
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

  test("stop() and restart() behave", () => {
    const h = makeHarness()
    const loops = new LoopManager(h.store, h.backend, h.io)
    loops.start("ses_1", { prompt: "a", maxIterations: 3 })
    expect(loops.loopCount()).toBe(1)
    loops.stop("ses_1")
    expect(loops.isLooping("ses_1")).toBe(false)
    loops.restart("ses_1", { prompt: "b", maxIterations: 1 })
    expect(loops.get("ses_1")?.prompt).toBe("b")
    expect(loops.get("ses_1")?.iterations).toBe(0)
    loops.destroy()
  })
})
