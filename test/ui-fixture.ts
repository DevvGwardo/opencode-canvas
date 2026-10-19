// Runs inside isolated Chromium, without a DOM emulation dependency.
import type { Backend } from "../src/app/backend"
import { CanvasView } from "../src/app/canvas"
import { createSessionCard, updateSessionCard } from "../src/app/card"
import { autoApproveToggle, autoApprovedNotices } from "../src/app/approve"
import { questionForm } from "../src/app/forms"
import { ensureAccess } from "../src/app/login"
import { SessionPanel } from "../src/app/panel"
import { NewSessionPicker } from "../src/app/picker"
import { spinner } from "../src/app/spinners"
import { Store } from "../src/app/store"
import { Transcript } from "../src/app/transcript"
import type { FormInfo, Message, Page, Session } from "../src/app/types"

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { cancelable: true }))
const errors: string[] = []
let passed = 0

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++ } catch (e) { errors.push(`${name}: ${(e as Error).message}`) }
}

const question: FormInfo = {
  id: "question", sessionID: "child", title: "How should we proceed?",
  fields: [{
    key: "choice", type: "string", title: "Approach", required: true, custom: true,
    options: [{ value: "small", label: "Small fix", description: "Keep the change focused." }],
  }],
}
const host = document.createElement("div")
document.body.append(host)

function setup(overrides: Partial<Backend> = {}) {
  const backend = {
    kind: "demo", messages: async () => ({ data: [] }), inbox: async () => [],
    permissions: async () => [], forms: async () => [], markViewed: async () => {},
    listCommands: async () => [], replyForm: async () => {}, cancelForm: async () => {},
    listModels: async () => [], serverDefaultModel: async () => undefined, listFolders: async () => [],
    ...overrides,
  } as Backend
  const store = new Store(backend)
  const session = (id: string, parentID?: string): Session => ({
    id, parentID, title: id, projectID: "p", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 }, location: { directory: "/test" },
  })
  store.addSessions([session("root"), session("child", "root")])
  return { backend, store }
}

async function run() {
  await check("choices, validation, and duplicate submissions", async () => {
    let calls = 0
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const form = questionForm(question, async () => { calls++; await pending }, async () => {})
    host.append(form)
    assert(form.textContent?.includes("Small fix") && form.textContent.includes("Keep the change focused."), "Choice labels/descriptions disappeared")
    submit(form)
    assert(calls === 0 && !form.querySelector<HTMLElement>(".ask-error")!.hidden, "Required choice wasn't enforced")
    form.querySelector<HTMLInputElement>("input[type=radio]")!.click()
    submit(form)
    submit(form)
    assert(calls === 1 && form.getAttribute("aria-busy") === "true", "Duplicate reply was sent")
    assert([...form.querySelectorAll<HTMLInputElement>("input")].every((input) => input.disabled), "Answer remained editable during submission")
    resolve()
    await sleep(0)
    assert(!form.hasAttribute("aria-busy"), "Question stayed busy")
    submit(form)
    assert(calls === 1, "An answered question could be submitted again before removal")
    form.remove()
  })

  await check("custom answers survive failed replies", async () => {
    let calls = 0
    let answer: Record<string, unknown> = {}
    const form = questionForm(question, async (value) => {
      calls++
      if (calls === 1) throw new Error("Try again")
      answer = value
    }, async () => {})
    host.append(form)
    const custom = form.querySelector<HTMLInputElement>("input[type=text]")!
    custom.value = "Another approach"
    custom.dispatchEvent(new Event("input"))
    submit(form)
    await sleep(0)
    assert(custom.value === "Another approach" && !custom.disabled, "Failed reply erased or locked the answer")
    assert(form.querySelector(".ask-error")?.textContent === "Try again", "Reply error was not shown inline")
    submit(form)
    await sleep(0)
    assert(answer.choice === "Another approach" && calls === 2, "Custom answer couldn't be retried")
    form.remove()
  })

  await check("numeric and multiselect answers preserve defaults", async () => {
    let answer: Record<string, unknown> = {}
    const form = questionForm({
      ...question, fields: [
        { key: "ratio", type: "number", default: 1.5 },
        { key: "count", type: "integer", default: 0 },
        { key: "enabled", type: "boolean", default: false },
        { key: "hidden", type: "string", hidden: true, default: "context" },
        { key: "many", type: "multiselect", required: true, custom: true, options: [{ value: "a", label: "A" }] },
      ],
    }, async (value) => { answer = value }, async () => {})
    host.append(form)
    assert(form.checkValidity(), "Fractional number input still has an integer step")
    submit(form)
    assert(!form.querySelector<HTMLElement>(".ask-error")!.hidden, "Empty required multiselect was accepted")
    form.querySelector<HTMLInputElement>('input[value="a"]')!.checked = true
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "b\nc"
    form.requestSubmit()
    await sleep(0)
    assert(answer.ratio === 1.5 && answer.count === 0 && answer.enabled === false && answer.hidden === "context", "Default/false/zero values were lost")
    assert(JSON.stringify(answer.many) === '["a","b","c"]', "Multiple/custom selections weren't preserved")
    form.remove()
  })

  await check("external questions can be dismissed, not falsely answered", async () => {
    let dismissed = false
    const form = questionForm({ ...question, fields: [{ key: "login", type: "external", url: "https://example.com/authorize" }] },
      async () => { throw new Error("External answer was sent") },
      async () => { dismissed = true },
    )
    host.append(form)
    assert(form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled, "External question could be submitted")
    assert(form.querySelector<HTMLAnchorElement>("a")?.href === "https://example.com/authorize", "External action link disappeared")
    form.querySelector<HTMLButtonElement>('button[type=button]')!.click()
    await sleep(0)
    assert(dismissed, "External question couldn't be dismissed")
    form.remove()
  })

  await check("conditional questions track answers without blocking hidden fields", async () => {
    let answer: Record<string, unknown> = {}
    const form = questionForm({ ...question, fields: [
      { key: "enabled", type: "boolean", default: false },
      { key: "details", type: "string", required: true, minLength: 3, when: [{ key: "enabled", op: "eq", value: true }] },
    ] }, async (value) => { answer = value }, async () => {})
    host.append(form)
    const field = form.querySelectorAll<HTMLFieldSetElement>("fieldset")[1]
    assert(field.hidden && field.disabled && form.checkValidity(), "Inactive required field blocked the form")
    form.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    assert(!field.hidden && !field.disabled && !form.checkValidity(), "Conditional field didn't activate")
    field.querySelector<HTMLTextAreaElement>("textarea")!.value = "Ready"
    form.requestSubmit()
    await sleep(0)
    assert(answer.enabled === true && answer.details === "Ready", "Activated field wasn't answered")
    form.remove()
  })

  await check("custom multiple-choice defaults preserve commas", async () => {
    let answer: Record<string, unknown> = {}
    const form = questionForm({ ...question, fields: [{
      key: "locations", type: "multiselect", custom: true, default: ["Austin, TX", "Boston, MA"], options: [],
    }] }, async (value) => { answer = value }, async () => {})
    host.append(form)
    form.requestSubmit()
    await sleep(0)
    assert(JSON.stringify(answer.locations) === '["Austin, TX","Boston, MA"]', "Custom answers were split at commas")
    form.remove()
  })

  await check("parent transcript shows child questions and retains edits", async () => {
    let answeredSession = ""
    const { store, backend } = setup({ replyForm: async (id) => { answeredSession = id } })
    store.forms.set("child", [question])
    const transcript = new Transcript(store, backend, { pageSize: 1 })
    host.append(transcript.scroller)
    try {
      transcript.setSession("root")
      await transcript.load(false)
      const form = transcript.list.querySelector<HTMLFormElement>("form")!
      assert(form && transcript.list.textContent?.includes("Subagent · child"), "Child question wasn't visible in the parent")
      const custom = form.querySelector<HTMLInputElement>("input[type=text]")!
      custom.value = "Keep this draft"
      custom.dispatchEvent(new Event("input"))
      store.touchCard("root")
      await frame()
      await frame()
      assert(transcript.list.querySelector("form") === form && custom.value === "Keep this draft", "Background rendering discarded the answer")
      submit(form)
      await sleep(0)
      assert(answeredSession === "child" && !store.forms.has("child"), "Reply targeted the parent or left a stale question")
    } finally {
      transcript.destroy()
      transcript.scroller.remove()
      store.stop()
    }
  })

  await check("older-page failures keep the retry button", async () => {
    const { store, backend } = setup({
      messages: async (_id, _limit, cursor) => {
        if (cursor) throw new Error("Earlier page unavailable")
        return { data: [{ type: "user", id: "latest", text: "Latest", time: { created: 0 } }], cursor: { next: "older" } }
      },
    })
    const transcript = new Transcript(store, backend, { pageSize: 1 })
    host.append(transcript.scroller)
    try {
      transcript.setSession("root")
      await transcript.load(false)
      await (transcript as any).loadOlder()
      const button = transcript.scroller.querySelector<HTMLButtonElement>(".earlier")!
      assert(!button.hidden && button.textContent === "Load earlier messages", "Failed history fetch removed its retry button")
    } finally {
      transcript.destroy()
      transcript.scroller.remove()
      store.stop()
    }
  })

  await check("old history cannot leak into a reopened session", async () => {
    let resolve!: (page: Page<Message>) => void
    const pending = new Promise<Page<Message>>((done) => { resolve = done })
    const { store, backend } = setup({
      messages: async (_id, _limit, cursor) => cursor ? pending : {
        data: [{ type: "user", id: "latest", text: "Latest", time: { created: 0 } }], cursor: { next: "older" },
      },
    })
    const transcript = new Transcript(store, backend, { pageSize: 1 })
    try {
      transcript.setSession("root")
      await transcript.load(false)
      const older = (transcript as any).loadOlder()
      transcript.setSession("child")
      transcript.setSession("root")
      await transcript.load(false)
      resolve({ data: [{ type: "user", id: "stale", text: "Stale", time: { created: 0 } }] })
      await older
      assert(!transcript.messages.some((m) => m.id === "stale"), "Stale history was merged after closing/reopening")
    } finally {
      transcript.destroy()
      store.stop()
    }
  })

  await check("rapid panel reopen cancels the old close animation", async () => {
    const { store, backend } = setup()
    const canvas = { setOpen: () => {}, cardRect: () => new DOMRect(20, 20, 300, 200) } as unknown as CanvasView
    const panel = new SessionPanel(host, store, backend, canvas, () => {}, () => {})
    panel.open("root")
    panel.close()
    panel.open("root")
    assert(!panel.el.classList.contains("leaving"), "Reopened panel contents are still hidden")
    await sleep(450)
    assert(panel.isOpen && panel.el.classList.contains("visible"), "Old close timer closed the reopened panel")
    panel.close()
    await sleep(420)
    store.stop()
  })

  await check("new-session models and effort use the selected project", async () => {
    localStorage.removeItem("occ.model")
    const directories: Array<string | undefined> = []
    const option = (directory?: string) => ({
      id: directory === "/other" ? "other-model" : "test-model", providerID: "fixture",
      name: directory === "/other" ? "Other project model" : "Test project model",
      variants: directory === "/other" ? ["low"] : ["high"],
    })
    const { store, backend } = setup({
      listModels: async (directory) => { directories.push(directory); return [option(directory)] },
      serverDefaultModel: async (directory) => { directories.push(directory); return option(directory) },
    })
    store.addSessions([{ ...store.sessions.get("root")!, id: "other", projectID: "other", location: { directory: "/other" } }])
    const picker = new NewSessionPicker(host, store, backend, "/home", async () => {})
    try {
      picker.open("/other")
      await (picker as any).renderModelButton()
      assert(host.querySelector(".picker-model-btn")?.textContent?.includes("Other project model"), "Default model wasn't scoped to the preferred project")
      await (picker as any).setMode("model")
      await sleep(0)
      assert(host.querySelector(".picker-list")?.textContent?.includes("Other project model"), "Model discovery used global configuration")
      assert(directories.length > 0 && directories.every((d) => d === "/other"), "Model requests lost the project directory")
      const efforts = [...host.querySelectorAll<HTMLOptionElement>(".effort-select option")].map((o) => o.value)
      assert(efforts.includes("low") && !efforts.includes("high"), "Effort choices came from another project")
    } finally { picker.close(); store.stop() }
  })

  await check("closing a picker cancels an in-flight folder choice", async () => {
    localStorage.removeItem("occ.model")
    let resolve!: (folders: string[]) => void
    const pending = new Promise<string[]>((done) => { resolve = done })
    let created = 0
    const { store, backend } = setup({ listFolders: () => pending })
    const picker = new NewSessionPicker(host, store, backend, "/home", async () => { created++ })
    try {
      picker.open("/test")
      ;(picker as any).options = [{ kind: "path", directory: "/test/new" }]
      const choosing = (picker as any).choose()
      picker.close()
      picker.open("/test")
      resolve(["new"])
      await choosing
      assert(created === 0 && picker.isOpen, "Cancelled choice created a session or closed a newer picker")
    } finally { picker.close(); store.stop() }
  })

  await check("repeated folder choices create only one session", async () => {
    localStorage.removeItem("occ.model")
    let resolve!: (folders: string[]) => void
    const pending = new Promise<string[]>((done) => { resolve = done })
    let created = 0
    const { store, backend } = setup({ listFolders: () => pending })
    const picker = new NewSessionPicker(host, store, backend, "/home", async () => { created++ })
    try {
      picker.open("/test")
      ;(picker as any).options = [{ kind: "path", directory: "/test/new" }]
      const a = (picker as any).choose()
      const b = (picker as any).choose()
      resolve(["new"])
      await Promise.all([a, b])
      assert(created === 1, "Repeated Enter/click created duplicate sessions")
    } finally { picker.close(); store.stop() }
  })

  await check("canvas cards are reachable and activatable by keyboard", async () => {
    const { store } = setup()
    const opened: string[] = []
    const canvasHost = document.createElement("div")
    document.body.append(canvasHost)
    const canvas = new CanvasView(canvasHost, store, { open: (id) => opened.push(id), newSession: () => {} })
    try {
      ;(canvas as any).sync()
      const cards = [...canvasHost.querySelectorAll<HTMLElement>(".card")]
      assert(cards.length >= 2, "Expected a session card and a new-session card")
      // Roving tabindex: the canvas is a single tab stop, not one per session.
      const stops = cards.filter((c) => c.tabIndex === 0)
      assert(stops.length === 1, `Expected exactly one tab stop, got ${stops.length}`)
      const first = stops[0]
      const firstId = first.dataset.id!
      first.focus()
      await frame()
      assert(document.activeElement === first, "A card could not take keyboard focus")
      assert(canvas.selected === firstId, "Focusing a card did not select it")
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      assert(opened.includes(firstId), "Enter on a focused card did not activate it")
      opened.length = 0
      first.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
      assert(opened.includes(firstId), "Space on a focused card did not activate it")
      // Subagent cards exist but sit inert behind their root outside the agents layout.
      const other = cards.find((c) => c !== first && !c.classList.contains("inert"))!
      canvas.select(other.dataset.id!, false)
      assert(other.tabIndex === 0 && first.tabIndex === -1, "The tab stop did not follow the selection")
    } finally {
      canvasHost.remove()
      store.stop()
    }
  })

  await check("cards show live activity, subagent count, and accessible status", async () => {
    const { store } = setup()
    const root = store.sessions.get("root")!
    const els = createSessionCard("root")
    host.append(els.root)
    try {
      store.running.add("root")
      store.activity.set("root", "Running bun test…")
      updateSessionCard(els, store, "root")
      assert(els.root.dataset.status === "working", "A running session did not render as working")
      assert(els.status.querySelector(".label")?.textContent === "Running bun test…", "The card did not show the live activity")
      assert((els.root.getAttribute("aria-label") ?? "").includes("working"), "The card is missing an accessible status label")
      assert(els.sub.textContent === "1 subagent", "Subagent count was not shown")
      // An unseen failure is loud; once viewed it settles to a quiet label.
      store.running.delete("root")
      store.activity.delete("root")
      root.outcome = "failed"
      root.time.idle = Date.now()
      root.time.viewed = undefined
      updateSessionCard(els, store, "root")
      assert(els.root.classList.contains("fresh") && els.root.dataset.status === "failed", "An unseen failure was not flagged")
      root.time.viewed = Date.now()
      updateSessionCard(els, store, "root")
      assert(!els.root.classList.contains("fresh") && els.root.dataset.status === "failed", "A viewed failure stayed loud")
    } finally {
      els.root.remove()
      store.stop()
    }
  })

  await check("an opened or culled card is never the tab stop", async () => {
    const { store } = setup()
    const canvasHost = document.createElement("div")
    document.body.append(canvasHost)
    const canvas = new CanvasView(canvasHost, store, { open: () => {}, newSession: () => {} })
    try {
      ;(canvas as any).sync()
      const cards = [...canvasHost.querySelectorAll<HTMLElement>(".card")]
      const first = cards[0]
      canvas.select(first.dataset.id!, false)
      assert(first.tabIndex === 0, "The selected card was not the tab stop")
      canvas.setOpen(first.dataset.id!)
      assert(first.tabIndex === -1, "An open (hidden) card kept the tab stop")
      assert(cards.some((c) => c !== first && c.tabIndex === 0), "Opening a card left no fallback tab stop")
      canvas.setOpen(undefined)
      canvas.select(first.dataset.id!, false)
      assert(first.tabIndex === 0, "The tab stop did not return to the selected card after closing")
    } finally {
      canvasHost.remove()
      store.stop()
    }
  })

  await check("an empty refetch does not wipe the loaded transcript", async () => {
    let calls = 0
    const { store, backend } = setup({
      messages: async () => {
        calls++
        return calls <= 2
          ? { data: [{ type: "user", id: "m1", text: "Hello", time: { created: 0 } }], cursor: { next: null } }
          : { data: [] }
      },
    })
    const transcript = new Transcript(store, backend, { pageSize: 50 })
    try {
      transcript.setSession("root")
      await transcript.load(false)
      assert(transcript.messages.length === 1, "The initial load lost its messages")
      await transcript.load(false)
      assert(transcript.messages.length === 1 && transcript.messages[0].id === "m1", "An empty refetch wiped the transcript")
    } finally {
      transcript.destroy()
      store.stop()
    }
  })

  await check("a failed sign-in with a non-JSON body shows a plain message", async () => {
    const real = window.fetch
    const root = document.createElement("div")
    host.append(root)
    try {
      window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return new Response("<html><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })
        return Response.json({ required: true, authenticated: false })
      }) as typeof fetch
      void ensureAccess(root)
      await sleep(30)
      const form = root.querySelector<HTMLFormElement>("form")
      assert(form, "The sign-in form was not rendered")
      form!.querySelector<HTMLInputElement>("input")!.value = "correct horse battery"
      submit(form!)
      await sleep(30)
      const message = root.querySelector<HTMLElement>(".login-error")?.textContent ?? ""
      assert(message === "Sign in failed (502)", `A non-JSON failure showed: ${message}`)
    } finally {
      window.fetch = real
      root.remove()
    }
  })

  await check("auto-approve needs a second click and batches its notices", async () => {
    const { store } = setup()
    const button = autoApproveToggle(store)
    host.append(button)
    try {
      const label = () => button.querySelector(".aa-label")!.textContent
      button.click()
      assert(label() === "Click again: allow everything?" && !store.autoApproveAll, "One click enabled auto-approve")
      button.click()
      assert(store.autoApproveAll && label() === "Auto-approve on" && button.getAttribute("aria-pressed") === "true", "The confirming click did not enable auto-approve")
      button.click()
      assert(!store.autoApproveAll && label() === "Auto-approve", "Clicking while on did not turn auto-approve off")
      const notices = document.querySelector(".toasts")!
      const before = notices.querySelectorAll(".toast").length
      autoApprovedNotices(store)
      const req = (action: string) => ({ id: `p-${action}`, sessionID: "root", action, resources: [] as string[] })
      store.onAutoApproved!(req("shell"))
      store.onAutoApproved!(req("read"))
      await sleep(800)
      const shown = [...notices.querySelectorAll<HTMLElement>(".toast")].slice(before)
      assert(shown.length === 1 && shown[0].textContent === "Auto-approved 2 requests", `Batched notices showed: ${shown.map((t) => t.textContent).join(" | ")}`)
    } finally {
      button.remove()
      store.stop()
    }
  })

  await check("spinner canvases pinned to a style paint a frame", async () => {
    const canvas = spinner(16, "extra", "wave")
    assert(canvas.className === "spin extra" && canvas.dataset.style === "wave", "A pinned spinner lost its class or style")
    assert(canvas.getAttribute("aria-hidden") === "true", "A spinner is exposed to screen readers")
    assert(canvas.style.width === "16px" && canvas.style.width === canvas.style.height, "A spinner canvas is not square at the requested size")
    host.append(canvas)
    try {
      await sleep(80)
      const image = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
      assert(image.some((value, i) => i % 4 === 3 && value > 0), "The spinner never painted a frame")
    } finally {
      canvas.remove()
    }
  })

  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passed, errors }) })
}

void run().catch(async (e) => {
  await fetch("/result", { method: "POST", body: JSON.stringify({ passed, errors: [...errors, (e as Error).message] }) })
})
