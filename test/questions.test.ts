import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { Store } from "../src/app/store"
import type { FormInfo, Session } from "../src/app/types"

function setup() {
  const cancelled: Array<[string, string]> = []
  const backend = {
    kind: "demo",
    cancelForm: async (sid: string, fid: string) => void cancelled.push([sid, fid]),
  } as unknown as Backend
  const store = new Store(backend)
  const mk = (id: string): Session => ({
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/x" },
  })
  store.sessions.set("a", mk("a"))
  const form = (id: string, sid: string): FormInfo => ({ id, sessionID: sid, title: "Pick one?", fields: [] })
  return { store, cancelled, form }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe("auto-dismiss questions", () => {
  test("questions wait by default", async () => {
    const { store, cancelled, form } = setup()
    Object.assign(store.backend, {
      permissions: async () => [],
      forms: async () => [form("f1", "a")],
    })
    await (store as any).syncAsks("a")
    expect(cancelled).toEqual([])
    expect(store.pendingQuestionCount()).toBe(1)
    expect(store.status("a")).toBe("needs-you")
  })

  test("toggle clears backlog and dismisses new asks", async () => {
    const { store, cancelled, form } = setup()
    Object.assign(store.backend, {
      permissions: async () => [],
      forms: async () => [form("f1", "a")],
    })
    await (store as any).syncAsks("a")
    expect(store.pendingQuestionCount()).toBe(1)
    store.setAutoDismissQuestions(true)
    await tick()
    expect(cancelled).toEqual([["a", "f1"]])
    expect(store.pendingQuestionCount()).toBe(0)

    Object.assign(store.backend, {
      permissions: async () => [],
      forms: async () => [form("f2", "a")],
    })
    await (store as any).syncAsks("a")
    await tick()
    expect(cancelled).toEqual([
      ["a", "f1"],
      ["a", "f2"],
    ])
    expect(store.pendingQuestionCount()).toBe(0)

    store.setAutoDismissQuestions(false)
    Object.assign(store.backend, {
      permissions: async () => [],
      forms: async () => [form("f3", "a")],
    })
    await (store as any).syncAsks("a")
    await tick()
    expect(cancelled.length).toBe(2)
    expect(store.pendingQuestionCount()).toBe(1)
  })
})

describe("form events", () => {
  test("registers a question from the nested form.created payload", async () => {
    const { store, form } = setup()
    let pending = [form("f1", "a")]
    Object.assign(store.backend, { permissions: async () => [], forms: async () => pending })
    // The live server nests the form under `data.form`, with no sessionID on the event.
    ;(store as any).onEvent({ id: "e1", type: "form.created", data: { form: form("f1", "a") } })
    await tick()
    expect(store.pendingQuestionCount()).toBe(1)
    expect(store.status("a")).toBe("needs-you")

    // Cancelling carries the session id directly and drops the question.
    pending = []
    ;(store as any).onEvent({ id: "e2", type: "form.cancelled", data: { id: "f1", sessionID: "a" } })
    await tick()
    expect(store.pendingQuestionCount()).toBe(0)
  })

  test("auto-dismisses immediately from nested form.created and clears nested form.cancelled", async () => {
    const { store, cancelled, form } = setup()
    let pending = [form("f1", "a")]
    Object.assign(store.backend, {
      permissions: async () => [],
      forms: async () => pending,
      cancelForm: async (sid: string, fid: string) => {
        cancelled.push([sid, fid])
        pending = pending.filter((f) => f.id !== fid)
      },
    })
    const autoDismissed: string[] = []
    store.onAutoDismissed = (f) => autoDismissed.push(f.id)
    store.setAutoDismissQuestions(true)

    ;(store as any).onEvent({ id: "e1", type: "form.created", data: { form: form("f1", "a") } })
    await tick()
    expect(cancelled).toEqual([["a", "f1"]])
    expect(autoDismissed).toEqual(["f1"])
    expect(store.pendingQuestionCount()).toBe(0)

    store.setAutoDismissQuestions(false)
    const f2 = form("f2", "a")
    store.forms.set("a", [f2])
    pending = []
    ;(store as any).onEvent({ id: "e2", type: "form.cancelled", data: { form: { id: "f2", sessionID: "a" } } })
    expect(store.pendingQuestionCount()).toBe(0)
  })

  test("concurrent replyForm and dismissForm coalesce without duplicate cancel or toast", async () => {
    const { store, cancelled, form } = setup()
    let finishReply!: () => void
    const replyGate = new Promise<void>((r) => { finishReply = r })
    let replied = 0
    Object.assign(store.backend, {
      replyForm: async () => { replied++; await replyGate },
      permissions: async () => [],
      forms: async () => [],
    })
    const f1 = form("f1", "a")
    store.forms.set("a", [f1])
    const notices: string[] = []
    store.onAutoDismissed = (f) => notices.push(f.id)

    const manual = store.replyForm(f1, { choice: "yes" })
    const auto = store.dismissForm(f1, true)
    finishReply()
    await manual
    expect(await auto).toBe(false)
    expect(replied).toBe(1)
    expect(cancelled).toEqual([])
    expect(notices).toEqual([])
    expect(store.pendingQuestionCount()).toBe(0)

    // Concurrent dismissForm calls also share a single cancelForm request and notify once.
    let finishCancel!: () => void
    const cancelGate = new Promise<void>((r) => { finishCancel = r })
    let cancelCalls = 0
    Object.assign(store.backend, {
      cancelForm: async () => { cancelCalls++; await cancelGate },
    })
    const f2 = form("f2", "a")
    store.forms.set("a", [f2])
    const d1 = store.dismissForm(f2, true)
    const d2 = store.dismissForm(f2, true)
    finishCancel()
    expect(await Promise.all([d1, d2])).toEqual([true, false])
    expect(cancelCalls).toBe(1)
    expect(notices).toEqual(["f2"])
  })

  test("dismissAllPendingForms covers descendant subagents and discovers idle auto-dismisses", async () => {
    const { store, cancelled, form } = setup()
    store.sessions.set("child", { ...store.sessions.get("a")!, id: "child", parentID: "a" })
    store.sessions.set("other", { ...store.sessions.get("a")!, id: "other" })
    ;(store as any).rebuildChildren()
    store.forms.set("a", [form("fa", "a")])
    store.forms.set("child", [form("fc", "child")])
    store.forms.set("other", [form("fo", "other")])

    const count = await store.dismissAllPendingForms("a")
    expect(count).toBe(2)
    expect(cancelled).toEqual([["a", "fa"], ["child", "fc"]])
    expect(store.pendingQuestionCount()).toBe(1)

    // Discovery auto-dismisses forms found in idle sessions when toggled on.
    store.forms.delete("other")
    Object.assign(store.backend, { pendingForms: async () => [form("fdisc", "other")] })
    store.autoDismissQuestions = true
    await (store as any).discoverPendingForms(true)
    await tick()
    expect(cancelled.some(([, id]) => id === "fdisc")).toBe(true)
    expect(store.pendingQuestionCount()).toBe(0)
  })
})
