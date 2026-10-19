import { describe, expect, test } from "bun:test"
import { ApiError, type Backend } from "../src/app/backend"
import { ALLOW_ALL, Store } from "../src/app/store"
import type { FormInfo, OcEvent, PermissionRequest, Session } from "../src/app/types"

const form: FormInfo = { id: "f", sessionID: "child", title: "Choose", fields: [{ key: "choice", type: "string" }] }
const permission: PermissionRequest = { id: "p", sessionID: "child", action: "shell", resources: [] }
const session = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 }, location: { directory: "/test" },
})

function setup(overrides: Partial<Backend> = {}) {
  const backend = {
    kind: "demo", permissions: async () => [], forms: async () => [], pendingForms: async () => [],
    active: async () => new Set<string>(),
    replyForm: async () => {}, cancelForm: async () => {}, replyPermission: async () => {},
    ...overrides,
  } as Backend
  const store = new Store(backend)
  store.addSessions([session("root"), session("parent", "root"), session("child", "parent")])
  const emit = (type: string, data: any) => (store as any).onEvent({ id: "event", type, data } as OcEvent)
  return { store, backend, emit }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("pending question synchronization", () => {
  test("failed list requests keep asks and notify every ancestor", async () => {
    const { store } = setup({
      permissions: async () => { throw new Error("Offline") },
      forms: async () => { throw new Error("Offline") },
    })
    store.forms.set("child", [form])
    store.permissions.set("child", [permission])
    await store.syncAsks("child")
    expect(store.forms.get("child")).toEqual([form])
    expect(store.permissions.get("child")).toEqual([permission])
    expect(store.status("root")).toBe("needs-you")
    expect([...(store as any).dirtyCards]).toEqual(expect.arrayContaining(["root", "parent", "child"]))
  })

  test("coalesces concurrent prompt readers", async () => {
    const response = deferred<FormInfo[]>()
    let calls = 0
    const { store } = setup({ forms: () => { calls++; return response.promise } })
    const a = store.syncAsks("child")
    const b = store.syncAsks("child")
    expect(calls).toBe(1)
    response.resolve([form])
    await Promise.all([a, b])
    expect(store.forms.get("child")).toEqual([form])
  })

  test("an old snapshot cannot erase a newly arrived question", async () => {
    const response = deferred<FormInfo[]>()
    let calls = 0
    const { store, emit } = setup({ forms: () => ++calls === 1 ? response.promise : Promise.resolve([form]) })
    const sync = store.syncAsks("child")
    emit("form.created", form)
    expect(store.forms.get("child")).toEqual([form])
    response.resolve([])
    await sync
    expect(calls).toBe(2)
    expect(store.forms.get("child")).toEqual([form])
  })

  test("an old snapshot cannot resurrect a question after answering", async () => {
    const response = deferred<FormInfo[]>()
    let calls = 0
    const { store } = setup({ forms: () => ++calls === 1 ? response.promise : Promise.resolve([]) })
    store.forms.set("child", [form])
    const sync = store.syncAsks("child")
    await store.replyForm(form, { choice: "A" })
    response.resolve([form])
    await sync
    expect(store.forms.has("child")).toBe(false)
    expect(calls).toBe(2)
  })

  test("a successful answer disappears even without a reply event", async () => {
    const { store } = setup()
    store.forms.set("child", [form])
    await store.replyForm(form, { choice: "A" })
    expect(store.forms.has("child")).toBe(false)
    expect(store.status("root")).not.toBe("needs-you")
    store.forms.set("child", [form])
    await store.cancelForm(form)
    expect(store.forms.has("child")).toBe(false)
  })

  test("a failed answer stays pending", async () => {
    const { store } = setup({ replyForm: async () => { throw new Error("Offline") } })
    store.forms.set("child", [form])
    await expect(store.replyForm(form, {})).rejects.toThrow("Offline")
    expect(store.forms.get("child")).toEqual([form])
  })

  test("duplicate answers from parent and subagent views share a single request", async () => {
    const response = deferred<void>()
    let calls = 0
    const { store } = setup({ replyForm: () => { calls++; return response.promise } })
    store.forms.set("child", [form])
    const a = store.replyForm(form, { choice: "A" })
    const b = store.replyForm(form, { choice: "A" })
    expect(calls).toBe(1)
    response.resolve()
    await Promise.all([a, b])
    expect(store.forms.has("child")).toBe(false)
  })

  test("reply events remove questions before the confirmation fetch finishes", async () => {
    const response = deferred<FormInfo[]>()
    const { store, emit } = setup({ forms: () => response.promise })
    store.forms.set("child", [form])
    emit("question.replied", { sessionID: "child", requestID: "f" })
    expect(store.forms.has("child")).toBe(false)
    response.resolve([])
    await store.syncAsks("child")
  })

  test("polls questions even when the running set has not changed", async () => {
    let calls = 0
    const { store } = setup({
      active: async () => new Set(["child"]),
      forms: async () => { calls++; return [form] },
    })
    store.running.add("child")
    await (store as any).syncActive()
    expect(calls).toBe(1)
    expect(store.status("root")).toBe("needs-you")
  })

  test("background prompt polling is bounded to four sessions at a time", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `session-${i}`)
    const gates = new Map(ids.map((id) => [id, deferred<FormInfo[]>()]))
    let calls = 0
    let inflight = 0
    let peak = 0
    const { store } = setup({
      active: async () => new Set(ids),
      forms: (id) => {
        calls++
        peak = Math.max(peak, ++inflight)
        return gates.get(id)!.promise.then((forms) => { inflight--; return forms })
      },
    })
    const poll = (store as any).syncActive()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(4)
    for (const id of ids.slice(0, 4)) gates.get(id)!.resolve([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(8)
    for (const id of ids.slice(4)) gates.get(id)!.resolve([])
    await poll
    expect(calls).toBe(9)
    expect(peak).toBe(4)
  })

  test("deleting a session clears its asks and ignores in-flight snapshots", async () => {
    const response = deferred<FormInfo[]>()
    const { store, emit } = setup({ forms: () => response.promise })
    store.forms.set("child", [form])
    store.permissions.set("child", [permission])
    store.running.add("child")
    const sync = store.syncAsks("child")
    emit("session.deleted", { sessionID: "child" })
    response.resolve([form])
    await sync
    expect(store.forms.has("child")).toBe(false)
    expect(store.permissions.has("child")).toBe(false)
    expect(store.running.has("child")).toBe(false)
    expect(store.status("root")).toBe("done")
  })

  test("a vanished session's asks are dropped instead of held forever", async () => {
    const { store } = setup({
      permissions: () => Promise.reject(new ApiError(404, "Session not found")),
      forms: () => Promise.reject(new ApiError(404, "Session not found")),
    })
    store.permissions.set("child", [permission])
    store.forms.set("child", [form])
    await store.syncAsks("child")
    expect(store.permissions.has("child")).toBe(false)
    expect(store.forms.has("child")).toBe(false)
    expect(store.pendingPermissionCount()).toBe(0)
    expect(store.status("root")).not.toBe("needs-you")
  })

  test("a missing endpoint or a server error alone never erases an ask", async () => {
    const { store } = setup({
      permissions: () => Promise.reject(new ApiError(500, "Internal")),
      forms: () => Promise.reject(new ApiError(404, "Unknown route")),
    })
    store.permissions.set("child", [permission])
    store.forms.set("child", [form])
    await store.syncAsks("child")
    expect(store.permissions.get("child")).toEqual([permission])
    expect(store.forms.get("child")).toEqual([form])
  })

  test("duplicate permission replies count only the actual write", async () => {
    const response = deferred<void>()
    let calls = 0
    const { store } = setup({ replyPermission: () => { calls++; return response.promise } })
    store.permissions.set("child", [permission])
    const a = store.approveAllPending()
    const b = store.approveAllPending()
    response.resolve()
    expect(await a).toBe(1)
    expect(await b).toBe(0)
    expect(calls).toBe(1)
  })

  test("reload preserves viewed state and running state when active is unavailable", async () => {
    const { store, backend } = setup()
    store.sessions.get("child")!.time.viewed = 100
    store.running.add("child")
    Object.assign(backend, {
      listProjects: async () => [],
      listSessions: async () => [session("root"), session("parent", "root"), session("child", "parent")],
      active: async () => { throw new Error("Offline") },
    })
    await store.reload()
    expect(store.sessions.get("child")!.time.viewed).toBe(100)
    expect(store.running.has("child")).toBe(true)
  })

  test("nested descendants propagate working and question status without cycles", () => {
    const { store } = setup()
    store.running.add("child")
    expect(store.status("root")).toBe("working")
    store.sessions.get("root")!.permissions = [ALLOW_ALL]
    expect(store.sessionAutoApproves("child")).toBe(true)
    store.forms.set("child", [form])
    expect(store.pendingInputSessions("root")).toEqual(["child"])
    store.sessions.get("root")!.parentID = "child"
    ;(store as any).rebuildChildren()
    expect(store.status("root")).toBe("needs-you")
    expect(store.pendingInputSessions("root")).toEqual(["child"])
  })

  test("a preview failure remains retryable instead of caching an empty result", async () => {
    const { store, backend } = setup({
      messages: async () => { throw new Error("Offline") },
    })
    await (store as any).loadPreview("child")
    expect(store.previews.has("child")).toBe(false)
    expect((store as any).previewStale.has("child")).toBe(true)
    expect((store as any).previewRetry.get("child")).toBeGreaterThan(Date.now())
    backend.messages = async () => ({ data: [{ type: "user", id: "m", text: "Recovered", time: { created: 0 } }] })
    await (store as any).loadPreview("child")
    expect(store.previews.get("child")?.pendingUser).toBe("Recovered")
    expect((store as any).previewRetry.has("child")).toBe(false)
  })

  test("discovers questions in idle sessions without an event or active drain", async () => {
    const other = { ...form, id: "other" }
    const { store } = setup({ pendingForms: async () => [form, other] })
    expect(store.running.size).toBe(0)
    await (store as any).discoverPendingForms()
    expect(store.forms.get("child")).toEqual([form, other])
    expect(store.status("root")).toBe("needs-you")
  })

  test("discovery does not resurrect a question answered during its fetch", async () => {
    const response = deferred<FormInfo[]>()
    const { store } = setup({ pendingForms: () => response.promise })
    store.forms.set("child", [form])
    const discovery = (store as any).discoverPendingForms()
    await store.replyForm(form, { choice: "A" })
    response.resolve([form])
    await discovery
    expect(store.forms.has("child")).toBe(false)
  })

  test("an authoritative session snapshot invalidates older discovery results", async () => {
    const response = deferred<FormInfo[]>()
    const { store } = setup({ pendingForms: () => response.promise })
    store.forms.set("child", [form])
    const discovery = (store as any).discoverPendingForms()
    await store.syncAsks("child")
    response.resolve([form])
    await discovery
    expect(store.forms.has("child")).toBe(false)
  })

  test("discovers older pending sessions outside the recent-session snapshot", async () => {
    const older = { ...form, sessionID: "older" }
    const { store } = setup({
      pendingForms: async () => [older],
      getSession: async () => session("older"),
    })
    await (store as any).discoverPendingForms()
    expect(store.sessions.has("older")).toBe(true)
    expect(store.forms.get("older")).toEqual([older])
  })
})
