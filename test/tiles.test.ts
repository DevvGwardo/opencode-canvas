import { describe, expect, test } from "bun:test"
import type { Backend } from "../src/app/backend"
import type { Store } from "../src/app/store"
import { TilesView, gridFor, projectHue } from "../src/app/tiles"
import type { Session } from "../src/app/types"
import { FakeEvent, withDom } from "./dom-harness"

function makeSession(id: string): Session {
  return {
    id,
    title: "Test session",
    location: { directory: "/repo" },
    time: { created: 1, updated: 1 },
    status: "idle",
  } as unknown as Session
}

function makeStore(session: Session) {
  const listeners = new Set<{ structure?: () => void; cards?: (ids: Set<string>) => void }>()
  const store = {
    sessions: new Map([[session.id, session]]),
    children: new Map(),
    running: new Set<string>([session.id]),
    permissions: new Map(),
    forms: new Map(),
    autoApproveAll: false,
    autoDismissQuestions: false,
    on: (l: { structure?: () => void; cards?: (ids: Set<string>) => void }) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    roots: () => [...store.sessions.values()],
    status: () => "working",
    unseen: () => false,
    markViewed: () => {},
    projectLabel: () => "repo",
    groupKey: () => "/repo",
    title: (s: Session) => s.title,
    activityLabel: () => "Working…",
    sessionAutoApproves: () => false,
    needsInput: () => undefined,
    pendingInputSessions: () => [],
    pendingPermissionCount: () => 0,
    syncAsks: async () => {},
    touchCard: () => {},
    emitStructure: () => {
      for (const l of listeners) l.structure?.()
    },
  }
  return store
}

describe("tile grid", () => {
  test("one tile fills the screen", () => {
    expect(gridFor(1, 1600, 900)).toMatchObject({ cols: 1, rows: 1 })
  })

  test("a few tiles go side by side on a wide screen", () => {
    expect(gridFor(2, 1600, 900).cols).toBe(2)
    const four = gridFor(4, 1600, 900)
    expect(four.cols * four.rows).toBeGreaterThanOrEqual(4)
    expect(four.rows).toBe(2)
  })

  test("never narrower than the minimum, scrolls instead", () => {
    const g = gridFor(30, 1400, 800)
    expect((1400 - 10 * (g.cols - 1)) / g.cols).toBeGreaterThanOrEqual(360)
    expect(g.rowH).toBeGreaterThanOrEqual(300)
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(30)
  })

  test("narrow screens stack", () => {
    expect(gridFor(3, 420, 900).cols).toBe(1)
  })

  test("handles zero and negative dimensions without NaN", () => {
    for (const [n, w, h] of [[1, 0, 0], [3, -50, 100], [0, 0, 0]]) {
      const g = gridFor(n, w, h)
      expect(Number.isFinite(g.cols) && g.cols >= 1).toBe(true)
      expect(Number.isFinite(g.rows) && g.rows >= 1).toBe(true)
      expect(Number.isFinite(g.rowH) && g.rowH >= 1).toBe(true)
    }
  })
})

describe("project colour", () => {
  test("stable and spread out", () => {
    expect(projectHue("storefront-web")).toBe(projectHue("storefront-web"))
    const hues = new Set(["storefront-web", "mobile-app", "payments-api", "design-system", "data-pipeline", "infra"].map(projectHue))
    expect(hues.size).toBe(6)
  })
})

describe("Tile commands and failed-send draft safety", () => {
  test("/stop closes slash menu, resets composer height, and interrupts; failed send does not clobber replaced tile", async () => {
    await withDom(async ({ document }) => {
      const session = makeSession("ses_tile_1")
      const store = makeStore(session)
      let interrupted = 0
      let rejectPrompt!: (e: Error) => void
      const backend = {
        listCommands: async () => [],
        messages: async () => ({ data: [] }),
        inbox: async () => [],
        interrupt: async () => { interrupted++ },
        prompt: async () => new Promise<void>((_, rej) => { rejectPrompt = rej }),
        command: async () => {},
      } as unknown as Backend

      const host = document.createElement("div")
      document.body.append(host as any)
      const tiles = new TilesView(host as unknown as HTMLElement, store as unknown as Store, backend, {
        openOnCanvas: () => {},
        openBrowser: () => {},
        newSession: () => {},
        closed: () => {},
      })
      try {
        tiles.open()
        const input = host.querySelector(".tile-input")!
        const menu = host.querySelector(".slash-menu")!
        input.focus()
        input.value = "/sto"
        input.dispatchEvent(new FakeEvent("input"))
        expect(menu.hidden).toBe(false)

        input.value = "/stop"
        input.style.height = "84px"
        input.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }))
        await new Promise((r) => setTimeout(r, 0))
        expect(interrupted).toBe(1)
        expect(input.value).toBe("")
        expect(input.style.height).toBe("auto")
        expect(menu.hidden).toBe(true)

        // Start a prompt, destroy and recreate Tile for the same session before send rejects.
        input.value = "stale draft"
        input.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }))
        // Close and reopen TilesView so the old Tile is destroyed and a fresh Tile replaces it.
        tiles.close()
        tiles.open()
        const freshInput = host.querySelector(".tile-input")!
        freshInput.value = "new draft"

        rejectPrompt(new Error("boom"))
        await new Promise((r) => setTimeout(r, 0))
        expect(freshInput.value).toBe("new draft")
        expect(tiles.drafts.get("ses_tile_1")).not.toBe("stale draft")
      } finally {
        tiles.destroy()
      }
    })
  })
})
