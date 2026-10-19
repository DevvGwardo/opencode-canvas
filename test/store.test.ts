import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import type { OcEvent, Page, Message, Session } from "../src/app/types"

const session = (id: string, directory = "/test"): Session => ({
  id,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory },
})

function setup(overrides: Partial<Backend> = {}) {
  const backend = {
    kind: "demo", permissions: async () => [], forms: async () => [], pendingForms: async () => [],
    active: async () => new Set<string>(), getSession: async (id: string) => session(id),
    listSessions: async () => [], listProjects: async () => [],
    ...overrides,
  } as Backend
  const store = new Store(backend)
  const emit = (type: string, data: any) => (store as any).onEvent({ id: "event", type, data } as OcEvent)
  return { store, backend, emit }
}

describe("permission events", () => {
  test("malformed payloads never enter the pending list", () => {
    const { store, emit } = setup()
    store.addSessions([session("s")])
    emit("permission.asked", { sessionID: "s" })
    emit("permission.asked", { sessionID: "s", id: "p", action: "shell" })
    expect(store.permissions.get("s")).toBeUndefined()
    emit("permission.asked", { sessionID: "s", id: "p", action: "shell", resources: ["ls"] })
    expect(store.permissions.get("s")).toHaveLength(1)
  })
})

describe("removing a session", () => {
  test("drops its ask version so versions don't accumulate", () => {
    const { store, emit } = setup()
    store.addSessions([session("s")])
    emit("permission.asked", { sessionID: "s", id: "p", action: "shell", resources: [] })
    expect((store as any).askVersions.has("s")).toBe(true)
    emit("session.deleted", { sessionID: "s" })
    expect((store as any).askVersions.has("s")).toBe(false)
    expect(store.sessions.has("s")).toBe(false)
  })
})

describe("flush teardown", () => {
  test("stop() cancels a scheduled flush so listeners never fire afterwards", async () => {
    const { store } = setup()
    let flushes = 0
    store.on({ structure: () => { flushes++ } })
    store.markStructure()
    store.stop()
    await Bun.sleep(350)
    expect(flushes).toBe(0)
  })

  test("stop() drops queued previews and silences an in-flight one", async () => {
    let resolve!: (page: Page<Message>) => void
    const page = new Promise<Page<Message>>((done) => { resolve = done })
    const { store } = setup({ messages: () => page })
    let flushes = 0
    store.on({ cards: () => { flushes++ } })
    store.wantPreview("s")
    store.stop()
    // A request arriving after teardown is ignored outright.
    store.wantPreview("later")
    expect((store as any).previewQueue).toHaveLength(0)
    expect((store as any).previewQueued.size).toBe(0)
    // The in-flight load still resolves, but must not notify listeners.
    resolve({ data: [] })
    await Bun.sleep(400)
    expect(flushes).toBe(0)
  })
})

describe("preview queue", () => {
  test("a preview queued for a deleted session is never fetched", async () => {
    const fetched: string[] = []
    const { store, emit } = setup({ messages: async (id: string) => { fetched.push(id); return { data: [] } } })
    // Fill the concurrency slots so "s" waits at the back of the queue.
    for (const id of ["a", "b", "c", "d"]) store.wantPreview(id)
    store.wantPreview("s")
    emit("session.deleted", { sessionID: "s" })
    await Bun.sleep(50)
    expect(fetched).toEqual(["a", "b", "c", "d"])
  })
})

describe("form discovery", () => {
  test("only rescans directories whose sessions changed", async () => {
    let calls = 0
    const { store } = setup({ pendingForms: async () => { calls++; return [] } })
    store.addSessions([session("a", "/one"), session("b", "/two")])
    await (store as any).discoverPendingForms(true)
    expect(calls).toBe(2)
    // Nothing changed: no requests at all on the next pass.
    await (store as any).discoverPendingForms()
    expect(calls).toBe(2)
    // A changed session in /one triggers exactly one rescan.
    store.sessions.get("a")!.time.updated = 500
    await (store as any).discoverPendingForms()
    expect(calls).toBe(3)
  })
})
