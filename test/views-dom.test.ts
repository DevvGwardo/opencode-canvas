import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import { BrowserPanel } from "../src/app/browser"
import type { CanvasView } from "../src/app/canvas"
import { LoopManager } from "../src/app/loops"
import { SessionPanel } from "../src/app/panel"
import type { Store } from "../src/app/store"
import { Transcript } from "../src/app/transcript"
import type { InboxItem, OcEvent, Session } from "../src/app/types"
import { FakeEvent, type FakeElement, withDom } from "./dom-harness"

function makeSession(id: string, directory = "/repo", title = "Session Title"): Session {
  return {
    id,
    title,
    location: { directory },
    time: { created: 1, updated: 1 },
    status: "idle",
  } as unknown as Session
}

function makePanelStore(session: Session) {
  const listeners = new Set<{
    event?: (ev: OcEvent) => void
    cards?: (ids: Set<string>) => void
    connection?: (s: string) => void
    structure?: () => void
  }>()
  const store = {
    sessions: new Map([[session.id, session]]),
    children: new Map(),
    running: new Set<string>(),
    permissions: new Map(),
    forms: new Map(),
    autoApproveAll: false,
    on: (l: any) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    markViewed: () => {},
    markStructure: () => {
      for (const l of listeners) l.structure?.()
    },
    touchCard: () => {},
    projectLabel: () => "repo",
    title: (s: Session) => s.title,
    activityLabel: () => "Working…",
    sessionAutoApproves: () => false,
    needsInput: () => undefined,
    pendingInputSessions: () => [],
    pendingPermissionCount: () => 0,
    subagentCount: () => 0,
    syncAsks: async () => {},
    emitEvent: (ev: OcEvent) => {
      for (const l of listeners) l.event?.(ev)
    },
    emitConnection: (state: string) => {
      for (const l of listeners) l.connection?.(state)
    },
  }
  return store
}

class MockEventSource {
  static last: MockEventSource | undefined
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    MockEventSource.last = this
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  close() {
    this.closed = true
  }
}

describe("BrowserPanel client fixes", () => {
  test("handles non-JSON 200 status responses without crashing with a SyntaxError", async () => {
    await withDom(async ({ document }) => {
      const host = document.createElement("div")
      document.body.append(host as any)
      ;(globalThis as any).fetch = async () => new Response("<html>Bad Gateway</html>", { status: 200 })
      const panel = new BrowserPanel(host as unknown as HTMLElement, () => {})
      try {
        panel.open()
        await new Promise((r) => setTimeout(r, 0))
        expect(host.querySelector(".browser-status")!.textContent).toBe("Browser returned an invalid status response.")
      } finally {
        panel.destroy()
      }
    })
  })

  test("ignores clicks/touches on hidden or zero-sized viewport and sends bounded clicks when sized", async () => {
    await withDom(async ({ document }) => {
      const host = document.createElement("div")
      document.body.append(host as any)
      const actions: unknown[] = []
      ;(globalThis as any).EventSource = MockEventSource
      ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
        if (url === "/canvas/browser") return new Response(JSON.stringify({ available: true, running: true }), { status: 200 })
        actions.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }
      const panel = new BrowserPanel(host as unknown as HTMLElement, () => {})
      try {
        panel.open()
        await new Promise((r) => setTimeout(r, 0))
        MockEventSource.last!.emit({
          type: "state",
          active: "tab1",
          width: 1280,
          height: 800,
          url: "https://example.com",
          title: "Example",
          tabs: [{ id: "tab1", title: "Example" }],
        })
        const img = host.querySelector(".browser-frame") as unknown as FakeElement
        // Image is initially hidden (no frame yet): click must NOT send NaN/click.
        img.dispatchEvent(new FakeEvent("click", { clientX: 50, clientY: 50 }))
        await new Promise((r) => setTimeout(r, 0))
        expect(actions).toEqual([])

        // Receive a frame so image becomes visible, but simulate zero bounding box.
        MockEventSource.last!.emit({ type: "frame", width: 1280, height: 800, data: "AQ==" })
        img.setRect({ left: 0, top: 0, width: 0, height: 0 })
        img.dispatchEvent(new FakeEvent("click", { clientX: 50, clientY: 50 }))
        img.dispatchEvent(new FakeEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 }))
        img.dispatchEvent(new FakeEvent("pointerup", { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 40 }))
        await new Promise((r) => setTimeout(r, 0))
        expect(actions).toEqual([])

        // Sized rect produces valid integer/bounded float coordinates.
        img.setRect({ left: 0, top: 0, width: 640, height: 400 })
        img.dispatchEvent(new FakeEvent("pointerup", { pointerType: "touch", pointerId: 1, clientX: 320, clientY: 200 }))
        img.dispatchEvent(new FakeEvent("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 0, clientY: 0 }))
        img.dispatchEvent(new FakeEvent("pointerup", { pointerType: "touch", pointerId: 2, clientX: 100, clientY: 100 }))
        await new Promise((r) => setTimeout(r, 0))
        expect(actions).toEqual([
          { type: "scroll", x: 0, y: 0, deltaX: -200, deltaY: -200 },
        ])
      } finally {
        panel.destroy()
      }
    })
  })

  test("handles dialog Escape/Enter, clears dialog on disconnect, and clears pendingUrl/expand on close", async () => {
    await withDom(async ({ document }) => {
      const host = document.createElement("div")
      document.body.append(host as any)
      const actions: any[] = []
      ;(globalThis as any).EventSource = MockEventSource
      ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
        if (url === "/canvas/browser") return new Response(JSON.stringify({ available: true, running: true }), { status: 200 })
        actions.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }
      const panel = new BrowserPanel(host as unknown as HTMLElement, () => {})
      try {
        panel.open("https://first.test")
        await new Promise((r) => setTimeout(r, 0))
        MockEventSource.last!.emit({
          type: "state",
          active: "t1",
          width: 1280,
          height: 800,
          url: "about:blank",
          title: "Blank",
          tabs: [{ id: "t1", title: "Blank" }],
        })
        await new Promise((r) => setTimeout(r, 0))
        expect(actions.shift()).toEqual({ type: "navigate", url: "https://first.test/" })

        // Show dialog and press Escape: dismisses dialog without closing BrowserPanel.
        MockEventSource.last!.emit({ type: "dialog", kind: "confirm", message: "Continue?" })
        const dialog = host.querySelector(".browser-dialog")!
        expect(dialog.hidden).toBe(false)
        dialog.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }))
        await new Promise((r) => setTimeout(r, 0))
        expect(dialog.hidden).toBe(true)
        expect(panel.isOpen).toBe(true)
        expect(actions.shift()).toEqual({ type: "dialog", accept: false, text: "" })

        // Prompt dialog accepts on Enter.
        MockEventSource.last!.emit({ type: "dialog", kind: "prompt", message: "Name?" })
        const promptInput = dialog.querySelector("input")!
        promptInput.value = "alice"
        promptInput.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }))
        await new Promise((r) => setTimeout(r, 0))
        expect(dialog.hidden).toBe(true)
        expect(actions.shift()).toEqual({ type: "dialog", accept: true, text: "alice" })

        // Disconnect hides an active dialog.
        MockEventSource.last!.emit({ type: "dialog", kind: "alert", message: "Hung" })
        expect(dialog.hidden).toBe(false)
        document.hidden = true
        document.dispatchEvent("visibilitychange")
        expect(dialog.hidden).toBe(true)

        // Expand toggles .on/aria-pressed, and close() resets them + pendingUrl.
        document.hidden = false
        document.dispatchEvent("visibilitychange")
        await new Promise((r) => setTimeout(r, 0))
        const expandBtn = host.querySelectorAll(".browser-btn").find((b) => b.textContent === "Expand")!
        expandBtn.click()
        expect(expandBtn.classList.contains("on")).toBe(true)
        expect(expandBtn.getAttribute("aria-pressed")).toBe("true")
        panel.open("https://queued.test")
        panel.close()
        expect(expandBtn.classList.contains("on")).toBe(false)
        expect(expandBtn.getAttribute("aria-pressed")).toBe("false")
        // Reopening without URL should NOT navigate to old pendingUrl.
        actions.length = 0
        panel.open()
        await new Promise((r) => setTimeout(r, 0))
        MockEventSource.last!.emit({
          type: "state",
          active: "t1",
          width: 1280,
          height: 800,
          url: "about:blank",
          title: "Blank",
          tabs: [{ id: "t1", title: "Blank" }],
        })
        await new Promise((r) => setTimeout(r, 0))
        expect(actions).toEqual([])
      } finally {
        panel.destroy()
      }
    })
  })
})

describe("Transcript regression and race fixes", () => {
  test("refetches on session.compaction.started, labels compaction inbox items, preserves scroll-to-end across overlapping loads, and drops stale act refetches", async () => {
    await withDom(async () => {
      const s1 = makeSession("ses_1")
      const s2 = makeSession("ses_2")
      const store = makePanelStore(s1)
      store.sessions.set(s2.id, s2)

      let calls1 = 0
      let calls2 = 0
      let releaseFirst!: () => void
      const backend = {
        messages: async (id: string) => {
          if (id === "ses_1") {
            calls1++
            if (calls1 === 1) await new Promise<void>((res) => { releaseFirst = res })
            return { data: [] }
          }
          calls2++
          return { data: [] }
        },
        inbox: async (id: string): Promise<InboxItem[]> =>
          id === "ses_1" ? [{ id: "i1", sessionID: id, type: "compaction", delivery: "queue", payload: {} }] : [],
      } as unknown as Backend

      const transcript = new Transcript(store as unknown as Store, backend, { pageSize: 20 })
      try {
        ;(transcript.scroller as unknown as FakeElement).scrollHeight = 500
        transcript.scroller.scrollTop = 0
        transcript.setSession("ses_1")
        // Live reconnect supersedes initial load(true) with load(false).
        store.emitConnection("live")
        releaseFirst()
        await new Promise((r) => setTimeout(r, 0))
        // Still scrolled to bottom because pendingScrollEnd survived overlapping load.
        expect(transcript.scroller.scrollTop).toBe(500)
        // Compaction inbox item falls back cleanly to "Context compaction".
        expect(transcript.list.textContent).toContain("Context compaction")

        // session.compaction.started triggers refetch (beyond the two initial loads).
        const before = calls1
        store.emitEvent({ id: "e1", type: "session.compaction.started", created: Date.now(), data: { sessionID: "ses_1" } })
        await new Promise((r) => setTimeout(r, 350))
        expect(calls1).toBeGreaterThan(before)

        // Switching session during act() must NOT refetch the newly selected session.
        let finishAct!: () => void
        const actPromise = transcript.act(() => new Promise<void>((res) => { finishAct = res }))
        transcript.setSession("ses_2")
        await new Promise((r) => setTimeout(r, 0))
        const calls2AtSwitch = calls2
        finishAct()
        await actPromise
        await new Promise((r) => setTimeout(r, 80))
        expect(calls2).toBe(calls2AtSwitch)
      } finally {
        transcript.destroy()
      }
    })
  })
})

describe("SessionPanel fixes", () => {
  test("targetRect ignores unpinned browser, Escape cancels rename on sync blur, Loop editor preserves --count in prompt, popovers toggle, resume omits empty dir, and model filter keeps focus", async () => {
    await withDom(async ({ document, flushRaf }) => {
      const s1 = makeSession("ses_1", "/repo", "Original Title")
      const s2 = makeSession("ses_2", "", "No Dir")
      const store = makePanelStore(s1)
      store.sessions.set(s2.id, s2)
      const renamed: Array<{ id: string; title: string }> = []
      const backend = {
        messages: async () => ({ data: [] }),
        inbox: async () => [],
        listCommands: async () => [],
        listModels: async () => [{ id: "m1", providerID: "p1", name: "Model 1" }],
        rename: async (id: string, title: string) => { renamed.push({ id, title }) },
      } as unknown as Backend
      const loops = new LoopManager(store as unknown as Store, backend as unknown as Backend, {
        storage: null,
        timers: { setTimeout: () => 1, clearTimeout: () => {} },
      })
      const host = document.createElement("div")
      document.body.append(host as any)

      // 1. Unpinned browser does not shrink panel width.
      const unpinnedBrowser = document.createElement("section")
      unpinnedBrowser.className = "browser-panel visible unpinned"
      unpinnedBrowser.setRect({ left: 900, width: 320 })
      document.body.append(unpinnedBrowser as any)

      const canvas = { setOpen: () => {}, cardRect: () => undefined } as unknown as CanvasView
      const panel = new SessionPanel(host as unknown as HTMLElement, store as unknown as Store, backend, canvas, () => {}, () => {})
      panel.loops = loops

      try {
        panel.open("ses_1")
        // With 1440px viewport and unpinned browser at left=900, panel keeps max 860px width instead of shrinking to (900-8-32)=860.. wait check 1000..1440:
        unpinnedBrowser.setRect({ left: 600, width: 360 })
        panel.open("ses_2") // switch back/forth or trigger resize:
        ;(globalThis.window as any).dispatchEvent(new FakeEvent("resize"))
        expect(panel.el.style.width).toBe("860px")

        // When browser IS pinned (no .unpinned), panel respects browser.left.
        unpinnedBrowser.classList.remove("unpinned")
        ;(globalThis.window as any).dispatchEvent(new FakeEvent("resize"))
        expect(panel.el.style.width).toBe("560px")

        // 2. Rename Escape does NOT commit even though contentEditable="false" synchronously blurs.
        const titleEl = host.querySelector(".panel-title")!
        titleEl.dispatchEvent("dblclick")
        titleEl.textContent = "Edited Title"
        titleEl.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }))
        expect(renamed).toEqual([])
        expect(s2.title).toBe("No Dir")
        expect(titleEl.textContent).toBe("No Dir")

        // 3. Clicking Loop button twice closes cleanly instead of reopening via el.pointerdown.
        const loopBtn = host.querySelector(".head-btn.loop")!
        loopBtn.dispatchEvent("pointerdown")
        loopBtn.click()
        expect(host.querySelector(".popover.loop-editor")).not.toBeNull()
        loopBtn.dispatchEvent("pointerdown")
        loopBtn.click()
        expect(host.querySelector(".popover.loop-editor")).toBeNull()

        // 4. Loop editor passes structured options so `--count`/`--stop` in prompt text are preserved.
        loopBtn.dispatchEvent("pointerdown")
        loopBtn.click()
        const pop = host.querySelector(".popover.loop-editor")!
        const loopPrompt = pop.querySelector(".loop-prompt")!
        const inputs = pop.querySelectorAll("input")
        loopPrompt.value = "Inspect --count 99 --stop BAD flag docs"
        inputs[0].value = "4"
        inputs[1].value = "0"
        inputs[2].value = "DONE"
        pop.querySelector(".btn.primary")!.click()
        expect(loops.get("ses_2")?.prompt).toBe("Inspect --count 99 --stop BAD flag docs")
        expect(loops.get("ses_2")?.maxIterations).toBe(4)
        expect(loops.get("ses_2")?.delayMs).toBe(0)
        expect(loops.get("ses_2")?.stopPhrase).toBe("DONE")
        loops.stop("ses_2")

        // Escape inside loop-editor closes popover.
        loopBtn.dispatchEvent("pointerdown")
        loopBtn.click()
        const pop2 = host.querySelector(".popover.loop-editor")!
        pop2.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }))
        expect(host.querySelector(".popover.loop-editor")).toBeNull()

        // 5. Empty directory omits broken `cd '' && ` in Copy resume command.
        let copied = ""
        ;(globalThis as any).navigator = { clipboard: { writeText: async (txt: string) => { copied = txt } } }
        const menuBtn = host.querySelector(".head-btn.menu")!
        menuBtn.dispatchEvent("pointerdown")
        menuBtn.click()
        const resumeItem = host.querySelectorAll(".pop-item").find((b) => b.textContent.includes("Copy resume command"))!
        resumeItem.click()
        await new Promise((r) => setTimeout(r, 0))
        expect(copied).toBe("opencode -s 'ses_2'")

        // 6. Opening session and immediately opening Model picker must not let 260ms timer steal focus from .pop-filter.
        panel.close()
        await new Promise((r) => setTimeout(r, 150))
        panel.open("ses_1")
        await panel.showModelPicker()
        const filter = host.querySelector(".pop-filter")!
        expect(document.activeElement).toBe(filter as any)
        await new Promise((r) => setTimeout(r, 300))
        flushRaf()
        expect(document.activeElement).toBe(filter as any)
      } finally {
        panel.destroy()
        loops.destroy()
      }
    })
  })
})
