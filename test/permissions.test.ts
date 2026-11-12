import { describe, expect, test } from "bun:test"
import { autoApproveToggle, autoDismissToggle } from "../src/app/approve"
import type { Backend } from "../src/app/backend"
import { ALLOW_ALL, Store } from "../src/app/store"
import type { FormInfo, PermissionRequest, Session } from "../src/app/types"

function setup() {
  const replies: Array<[string, string, string]> = []
  const patches: Array<[string, unknown]> = []
  const backend = {
    kind: "demo",
    replyPermission: async (sid: string, rid: string, d: string) => void replies.push([sid, rid, d]),
    setSessionPermissions: async (id: string, rules: unknown) => void patches.push([id, rules]),
  } as unknown as Backend
  const store = new Store(backend)
  const mk = (id: string, extra: Partial<Session> = {}): Session => ({
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/x" },
    ...extra,
  })
  store.sessions.set("a", mk("a"))
  store.sessions.set("b", mk("b", { permissions: [{ action: "read", resource: "*", effect: "allow" }] }))
  store.sessions.set("c", mk("c", { parentID: "b" }))
  ;(store as any).rebuildChildren()
  const req = (id: string, sid: string): PermissionRequest => ({ id, sessionID: sid, action: "shell", resources: ["ls"] })
  const ask = (r: PermissionRequest) => (store as any).onEvent({ id: "e", type: "permission.asked", data: r })
  return { store, replies, patches, req, ask }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("permissions", () => {
  test("asks wait for you by default", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    await tick()
    expect(replies).toEqual([])
    expect(store.pendingPermissionCount()).toBe(1)
    expect(store.status("a")).toBe("needs-you")
  })

  test("allow all pending approves once, everywhere", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    ask(req("per_2", "b"))
    const n = await store.approveAllPending()
    expect(n).toBe(2)
    expect(replies.map((r) => r[2])).toEqual(["once", "once"])
    expect(store.pendingPermissionCount()).toBe(0)
  })

  test("global auto-approve clears the backlog and approves new asks", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_1", "a"))
    store.setAutoApproveAll(true)
    await tick()
    ask(req("per_2", "a"))
    await tick()
    expect(replies.map((r) => r[1]).sort()).toEqual(["per_1", "per_2"])
    store.setAutoApproveAll(false)
    ask(req("per_3", "a"))
    await tick()
    expect(replies.length).toBe(2)
  })

  test("per-session rule keeps other rules and covers its subagents", async () => {
    const { store, patches, replies, req, ask } = setup()
    ask(req("per_1", "b"))
    await store.setSessionAutoApprove("b", true)
    expect(patches.at(-1)).toEqual(["b", [{ action: "read", resource: "*", effect: "allow" }, ALLOW_ALL]])
    expect(replies.map((r) => r[1])).toEqual(["per_1"])
    expect(store.sessionAutoApproves("c")).toBe(true)
    ask(req("per_2", "c"))
    await tick()
    expect(replies.map((r) => r[1])).toEqual(["per_1", "per_2"])
    await store.setSessionAutoApprove("b", false)
    expect(patches.at(-1)).toEqual(["b", [{ action: "read", resource: "*", effect: "allow" }]])
    expect(store.sessionAutoApproves("b")).toBe(false)
  })

  test("turning auto off on a session with no other rules clears them", async () => {
    const { store, patches } = setup()
    await store.setSessionAutoApprove("a", true)
    await store.setSessionAutoApprove("a", false)
    expect(patches.at(-1)).toEqual(["a", null])
  })

  test("enabling session auto-approve also clears waiting subagent requests", async () => {
    const { store, replies, req, ask } = setup()
    ask(req("per_child", "c"))
    await store.setSessionAutoApprove("b", true)
    expect(replies.map((r) => r[1])).toEqual(["per_child"])
    await expect(store.setSessionAutoApprove("c", false)).rejects.toThrow("inherited from a parent")
    expect(store.sessionAutoApproves("c")).toBe(true)
  })

  test("a reload clears asks answered elsewhere while disconnected", async () => {
    const { store, req, ask } = setup()
    ask(req("per_1", "a"))
    expect(store.status("a")).toBe("needs-you")
    // Nothing is running any more and the server has no pending asks.
    Object.assign(store.backend, {
      listProjects: async () => [],
      listSessions: async () => [...store.sessions.values()],
      active: async () => new Set<string>(),
      permissions: async () => [],
      forms: async () => [],
      pendingForms: async () => [],
    })
    await store.reload()
    await tick()
    expect(store.pendingPermissionCount()).toBe(0)
    expect(store.status("a")).not.toBe("needs-you")
  })

  test("setSessionAutoApprove applies rules to replaced session instance after reload", async () => {
    const { store } = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    store.backend.setSessionPermissions = () => gate
    const updating = store.setSessionAutoApprove("a", true)
    const fresh: Session = { ...store.sessions.get("a")!, title: "refreshed" }
    store.sessions.set("a", fresh)
    release()
    await updating
    expect(fresh.permissions).toEqual([ALLOW_ALL])
  })

  test("autoApproveToggle and autoDismissToggle isolate stores, keep independent confirm timers, and await real backlog count", async () => {
    const realDoc = Object.getOwnPropertyDescriptor(globalThis, "document")
    const realRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")

    class FakeClassList {
      private set = new Set<string>()
      add(...names: string[]) { for (const n of names) this.set.add(n) }
      remove(...names: string[]) { for (const n of names) this.set.delete(n) }
      contains(n: string) { return this.set.has(n) }
      toggle(n: string, force?: boolean) {
        if (force === undefined ? !this.set.has(n) : force) { this.set.add(n); return true }
        this.set.delete(n); return false
      }
    }
    class FakeElement {
      type = ""
      className = ""
      title = ""
      textContent: string | null = ""
      classList = new FakeClassList()
      attrs = new Map<string, string>()
      children: FakeElement[] = []
      listeners = new Map<string, Array<() => void>>()
      private label?: FakeElement
      set innerHTML(html: string) {
        if (html.includes("aa-label")) {
          this.label = new FakeElement()
          this.label.className = "aa-label"
        }
      }
      setAttribute(k: string, v: string) { this.attrs.set(k, v) }
      getAttribute(k: string) { return this.attrs.get(k) ?? null }
      querySelector(sel: string) { return sel === ".aa-label" ? this.label ?? null : null }
      addEventListener(ev: string, fn: () => void) {
        const list = this.listeners.get(ev) ?? []
        list.push(fn)
        this.listeners.set(ev, list)
      }
      click() { for (const fn of this.listeners.get("click") ?? []) fn() }
      append(...nodes: FakeElement[]) { this.children.push(...nodes) }
      remove() {}
    }

    const body = new FakeElement()
    const fakeDoc = {
      body,
      createElement: () => new FakeElement(),
    }
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDoc })
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: () => void) => { cb(); return 0 } })

    const toasts = () => body.children.flatMap((c) => c.children.map((t) => t.textContent ?? ""))
    try {
      const s1 = setup()
      const s2 = setup()
      s1.store.backend.replyPermission = async () => { throw new Error("server down") }
      s1.ask(s1.req("per_fail", "a"))

      const b1a = autoApproveToggle(s1.store) as unknown as FakeElement
      const b1b = autoApproveToggle(s1.store) as unknown as FakeElement
      const b2 = autoApproveToggle(s2.store) as unknown as FakeElement

      expect(b1a.type).toBe("button")
      b1a.click()
      expect(b1a.classList.contains("confirming")).toBe(true)
      expect(b1b.classList.contains("confirming")).toBe(false)

      // Confirm on b1a while replyPermission rejects: toast must NOT falsely say approved 1 request.
      const before = toasts().length
      b1a.click()
      await tick()
      expect(s1.store.autoApproveAll).toBe(true)
      expect(s2.store.autoApproveAll).toBe(false)
      expect(b1b.classList.contains("on")).toBe(true)
      expect(b2.classList.contains("on")).toBe(false)
      expect(toasts().slice(before)).toEqual(["Auto-approve on"])

      // Succeeding backlog dismiss reports actual dismissed count.
      const d1 = autoDismissToggle(s1.store) as unknown as FakeElement
      const d2 = autoDismissToggle(s2.store) as unknown as FakeElement
      s1.store.backend.cancelForm = async () => {}
      const f: FormInfo = { id: "f1", sessionID: "a", title: "Pick", fields: [] }
      s1.store.forms.set("a", [f])
      const beforeDismiss = toasts().length
      d1.click()
      await tick()
      expect(s1.store.autoDismissQuestions).toBe(true)
      expect(s2.store.autoDismissQuestions).toBe(false)
      expect(d1.classList.contains("on")).toBe(true)
      expect(d2.classList.contains("on")).toBe(false)
      expect(toasts().slice(beforeDismiss)).toEqual(["Won't wait for answers: dismissed 1 waiting question"])
    } finally {
      if (realDoc) Object.defineProperty(globalThis, "document", realDoc)
      else Reflect.deleteProperty(globalThis, "document")
      if (realRaf) Object.defineProperty(globalThis, "requestAnimationFrame", realRaf)
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame")
    }
  })
})
