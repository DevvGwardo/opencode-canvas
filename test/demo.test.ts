import { describe, expect, test } from "bun:test"
import { DemoBackend } from "../src/app/demo"

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
})
