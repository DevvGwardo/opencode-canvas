import { describe, expect, test } from "bun:test"
import { DemoBackend } from "../src/app/demo"
import { Store } from "../src/app/store"

/** Stop every run (including the seeded ones) so the process can exit promptly. */
async function drain(backend: DemoBackend) {
  await Bun.sleep(3000)
  for (const id of await backend.active()) await backend.interrupt(id)
}

describe("demo backend", () => {
  test("interrupting a run leaves it interrupted, never succeeded", async () => {
    const backend = new DemoBackend()
    const events: string[] = []
    backend.subscribe((ev) => events.push(ev.type), () => {})

    const session = await backend.createSession("/tmp/opencode-canvas-demo-test")
    await backend.prompt(session.id, { text: "hello" })
    await Bun.sleep(50)
    expect([...(await backend.active())]).toContain(session.id)

    await backend.interrupt(session.id)
    // Let the loop's in-flight sleep finish so its tail block runs.
    await Bun.sleep(3000)

    expect((await backend.getSession(session.id)).outcome).toBe("interrupted")
    expect(events).toContain("session.execution.interrupted")
    expect(events).not.toContain("session.execution.succeeded")

    // Stop the seeded background runs so the process can exit promptly.
    for (const id of await backend.active()) await backend.interrupt(id)
  }, 20_000)

  test("createSession registers the project and announces the session", async () => {
    const backend = new DemoBackend()
    try {
      const events: string[] = []
      backend.subscribe((ev) => events.push(ev.type), () => {})
      const directory = "/tmp/opencode-canvas-demo-new-project"

      const session = await backend.createSession(directory)
      expect(session.location.directory).toBe(directory)
      expect(events).toContain("session.created")
      expect((await backend.listProjects()).some((p) => p.canonical === directory)).toBe(true)
      expect((await backend.listSessions()).some((s) => s.id === session.id)).toBe(true)
    } finally {
      await drain(backend)
    }
  }, 20_000)

  test("a message queued while running waits in the inbox for the next turn", async () => {
    const backend = new DemoBackend()
    try {
      const session = await backend.createSession("/tmp/opencode-canvas-demo-queue")
      await backend.prompt(session.id, { text: "start" })
      expect([...(await backend.active())]).toContain(session.id)

      await backend.prompt(session.id, { text: "later", delivery: "queue" })
      const inbox = await backend.inbox(session.id)
      expect(inbox.map((i) => i.payload.text)).toEqual(["later"])
      expect(inbox[0].delivery).toBe("queue")
    } finally {
      await drain(backend)
    }
  }, 20_000)

  test("compact transitions an idle session cleanly and honors interrupt", async () => {
    const backend = new DemoBackend()
    try {
      const events: Array<{ type: string; sid?: string }> = []
      backend.subscribe((ev) => events.push({ type: ev.type, sid: ev.data?.sessionID }), () => {})

      const s1 = await backend.createSession("/tmp/opencode-canvas-demo-compact")
      await backend.compact(s1.id)
      expect([...(await backend.active())]).toContain(s1.id)
      await Bun.sleep(2100)
      expect([...(await backend.active())]).not.toContain(s1.id)
      expect((await backend.getSession(s1.id)).outcome).toBe("succeeded")
      const s1Events = events.filter((e) => e.sid === s1.id).map((e) => e.type)
      expect(s1Events).toContain("session.execution.started")
      expect(s1Events).toContain("session.compaction.ended")
      expect(s1Events).toContain("session.execution.succeeded")

      const s2 = await backend.createSession("/tmp/opencode-canvas-demo-compact-interrupt")
      await backend.compact(s2.id)
      await backend.interrupt(s2.id)
      await Bun.sleep(2100)
      expect((await backend.getSession(s2.id)).outcome).toBe("interrupted")
      const s2Events = events.filter((e) => e.sid === s2.id).map((e) => e.type)
      expect(s2Events).toContain("session.compaction.failed")
      expect(s2Events).not.toContain("session.compaction.ended")
      expect(s2Events).not.toContain("session.execution.succeeded")
    } finally {
      await drain(backend)
    }
  }, 20_000)

  test("interrupted loop emits no post-interrupt work events and subscribe unsubscribes before tick 0", async () => {
    const backend = new DemoBackend()
    try {
      let earlyStateCalls = 0
      let earlyEventCalls = 0
      const unsub = backend.subscribe(() => { earlyEventCalls++ }, () => { earlyStateCalls++ })
      unsub()
      await Bun.sleep(20)
      expect(earlyStateCalls).toBe(0)
      expect(earlyEventCalls).toBe(0)

      const events: Array<{ type: string; sid?: string }> = []
      const store = new Store(backend)
      await store.start()
      store.on({ event: (ev) => events.push({ type: ev.type, sid: ev.data?.sessionID }) })
      const s = await backend.createSession("/tmp/opencode-canvas-demo-interrupt-events")
      await backend.prompt(s.id, { text: "work" })
      await Bun.sleep(50)
      await backend.interrupt(s.id)
      const afterInterrupt = events.filter((e) => e.sid === s.id).length
      await Bun.sleep(2200)
      store.stop()
      const tail = events.filter((e) => e.sid === s.id).slice(afterInterrupt).map((e) => e.type).filter((t) => t !== "session.renamed")
      expect(tail).toEqual([])
      expect(store.status(s.id)).toBe("stopped")
    } finally {
      await drain(backend)
    }
  }, 20_000)
})
