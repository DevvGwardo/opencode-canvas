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

describe("store lifecycle and event edge cases", () => {
  test("stop() during start() reload prevents poll timers from arming", async () => {
    let resolveSessions!: (list: Session[]) => void
    const list = new Promise<Session[]>((r) => { resolveSessions = r })
    const { store } = setup({
      listSessions: () => list,
      subscribe: () => () => {},
    })
    const starting = store.start()
    store.stop()
    resolveSessions([session("a")])
    await starting
    expect((store as any).pollTimer).toBeUndefined()
    expect((store as any).recentTimer).toBeUndefined()
    expect(store.loaded).toBe(false)
  })

  test("overlapping reload keeps only the newest snapshot and preserves projects on outage", async () => {
    let firstResolve!: (list: Session[]) => void
    let projCalls = 0
    let sessCalls = 0
    const { store } = setup({
      listProjects: async () => ++projCalls === 1
        ? [{ id: "project", name: "Proj", canonical: "/test" }]
        : Promise.reject(new Error("offline")),
      listSessions: () => ++sessCalls === 1
        ? new Promise((r) => { firstResolve = r })
        : Promise.resolve([session("fresh")]),
    })

    store.projects.set("project", { id: "project", name: "Proj", canonical: "/test" })
    store.activity.set("stale", "Writing…")
    store.liveText.set("stale", "partial")
    ;(store as any).toolNames.set("c1", { sessionID: "stale", name: "read" })

    const r1 = store.reload()
    const r2 = store.reload()
    await r2
    firstResolve([session("old")])
    await r1

    expect(store.projects.get("project")?.name).toBe("Proj")
    expect([...store.sessions.keys()]).toEqual(["fresh"])
    expect(store.activity.has("stale")).toBe(false)
    expect(store.liveText.has("stale")).toBe(false)
    expect((store as any).toolNames.size).toBe(0)
  })

  test("compaction end on subagent notifies ancestors and clears activity", () => {
    const { store, emit } = setup()
    store.addSessions([session("root"), { ...session("child"), parentID: "root" }])
    emit("session.compaction.started", { sessionID: "child" })
    expect(store.activity.get("child")).toBe("Compacting context…")
    ;(store as any).dirtyCards.clear()
    emit("session.compaction.ended", { sessionID: "child" })
    expect(store.activity.has("child")).toBe(false)
    expect((store as any).dirtyCards).toEqual(new Set(["child", "root"]))
  })

  test("preview marked stale mid-fetch triggers a fresh load", async () => {
    let resolveFirst!: (page: Page<Message>) => void
    let calls = 0
    const { store } = setup({
      messages: () => ++calls === 1
        ? new Promise((r) => { resolveFirst = r })
        : Promise.resolve({ data: [{ type: "user", id: "m2", text: "second", time: { created: 1 } }] }),
    })
    store.wantPreview("s")
    // Mark stale while first fetch is still in flight.
    ;(store as any).previewStale.add("s")
    store.wantPreview("s")
    resolveFirst({ data: [{ type: "user", id: "m1", text: "first", time: { created: 0 } }] })
    await Bun.sleep(20)
    expect(calls).toBe(2)
    expect(store.previews.get("s")?.pendingUser).toBe("second")
  })

  test("execution lifecycle clears stale outcome, liveText, and toolNames; text.delta revives activity", () => {
    const { store, emit } = setup()
    store.addSessions([{ ...session("s"), outcome: "failed" }])
    emit("session.text.delta", { sessionID: "s", delta: "hi " })
    expect(store.running.has("s")).toBe(true)
    expect(store.activity.get("s")).toBe("Writing…")
    expect(store.liveText.get("s")).toBe("hi ")

    emit("session.execution.started", { sessionID: "s" })
    expect(store.sessions.get("s")?.outcome).toBeUndefined()
    emit("session.tool.input.started", { sessionID: "s", id: "call_1", name: "read" })
    expect((store as any).toolNames.size).toBe(1)
    emit("session.execution.succeeded", { sessionID: "s" })
    expect(store.liveText.has("s")).toBe(false)
    expect((store as any).toolNames.size).toBe(0)
    store.stop()
  })

  test("refreshRecent never resurrects a session deleted mid-fetch", async () => {
    let resolveRecent!: (list: Session[]) => void
    const { store, emit } = setup({ listSessions: () => new Promise((r) => { resolveRecent = r }) })
    store.addSessions([session("s")])
    const refresh = (store as any).refreshRecent()
    emit("session.deleted", { sessionID: "s" })
    resolveRecent([session("s")])
    await refresh
    expect(store.sessions.has("s")).toBe(false)
  })
})
