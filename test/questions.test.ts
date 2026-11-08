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
