import { afterEach, describe, expect, test } from "bun:test"
import { toast } from "../src/app/toast"

class FakeClassList {
  private set = new Set<string>()
  constructor(private onSync: (cls: string) => void) {}
  sync(cls: string) {
    this.set = new Set(cls.split(/\s+/).filter(Boolean))
  }
  add(...tokens: string[]) {
    for (const t of tokens) if (t) this.set.add(t)
    this.onSync([...this.set].join(" "))
  }
  remove(...tokens: string[]) {
    for (const t of tokens) this.set.delete(t)
    this.onSync([...this.set].join(" "))
  }
  contains(token: string) {
    return this.set.has(token)
  }
}

class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | null = null
  attrs = new Map<string, string>()
  textContent: string | null = ""
  private cls = ""
  readonly classList = new FakeClassList((v) => {
    this.cls = v
  })

  constructor(readonly tagName: string, private root: FakeElement | null = null) {}

  get className() {
    return this.cls
  }
  set className(v: string) {
    this.cls = v
    this.classList.sync(v)
  }
  get parentElement() {
    return this.parent
  }
  get isConnected(): boolean {
    if (this === this.root) return (globalThis as any).document?.body === this
    return this.parent ? this.parent.isConnected : false
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v)
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null
  }
  append(...nodes: FakeElement[]) {
    for (const n of nodes) {
      n.remove()
      n.parent = this
      this.children.push(n)
    }
  }
  remove() {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }
  querySelector(selector: string): FakeElement | null {
    const wantClass = selector.startsWith(".") ? selector.slice(1) : null
    for (const c of this.children) {
      if (wantClass ? c.classList.contains(wantClass) : c.tagName === selector.toUpperCase()) return c
      const nested = c.querySelector(selector)
      if (nested) return nested
    }
    return null
  }
}

function installFakeDom() {
  const realDocument = (globalThis as any).document
  const realRaf = (globalThis as any).requestAnimationFrame
  const body = new FakeElement("BODY")
  ;(body as any).root = body
  const rafQueue: FrameRequestCallback[] = []
  ;(globalThis as any).document = {
    body,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase(), body),
  }
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
  return {
    body,
    flushRaf: () => {
      while (rafQueue.length) rafQueue.shift()!(0)
    },
    restore: () => {
      ;(globalThis as any).document = realDocument
      ;(globalThis as any).requestAnimationFrame = realRaf
    },
  }
}

let restoreDom: (() => void) | undefined

afterEach(() => {
  restoreDom?.()
  restoreDom = undefined
})

describe("toast", () => {
  test("creates live-region host, re-attaches after body reset, and adds .in on rAF", async () => {
    const dom = installFakeDom()
    restoreDom = dom.restore

    toast("Saved", 20)
    const host = dom.body.querySelector(".toasts")!
    expect(host).toBeDefined()
    expect(host.getAttribute("role")).toBe("status")
    expect(host.getAttribute("aria-live")).toBe("polite")
    expect(host.getAttribute("aria-atomic")).toBe("false")
    expect(host.children.length).toBe(1)
    const item = host.children[0]
    expect(item.textContent).toBe("Saved")
    expect(item.classList.contains("in")).toBe(false)

    dom.flushRaf()
    expect(item.classList.contains("in")).toBe(true)

    // Simulate body replacement (e.g. showUnavailable): a new toast must attach a live host.
    dom.body.children.length = 0
    host.parent = null
    toast("Reattached", 20)
    const host2 = dom.body.querySelector(".toasts")!
    expect(host2.isConnected).toBe(true)
    expect(host2.children.at(-1)?.textContent).toBe("Reattached")

    await new Promise((r) => setTimeout(r, 360))
    expect(host2.children.length).toBe(0)
  })

  test("fast dismissal cancels queued .in class addition and clamps invalid duration", async () => {
    const dom = installFakeDom()
    restoreDom = dom.restore

    toast("Brief", -50)
    const host = dom.body.querySelector(".toasts")!
    const item = host.children[0]

    // Wait past the 0ms dismiss timer, BEFORE flushing rAF.
    await new Promise((r) => setTimeout(r, 20))
    dom.flushRaf()
    expect(item.classList.contains("in")).toBe(false)

    await new Promise((r) => setTimeout(r, 330))
    expect(host.children.includes(item)).toBe(false)
  })
})
