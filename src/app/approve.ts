// The global "Auto-approve" switch. Turning it on asks for a second click,
// because it lets every agent run commands and edit files without asking.

import type { Store } from "./store"
import { toast } from "./toast"

const toggles = new WeakMap<Store, Set<HTMLButtonElement>>()
const dismissToggles = new WeakMap<Store, Set<HTMLButtonElement>>()

function togglesFor(map: WeakMap<Store, Set<HTMLButtonElement>>, store: Store): Set<HTMLButtonElement> {
  let set = map.get(store)
  if (!set) map.set(store, set = new Set())
  return set
}

function paintButton(store: Store, b: HTMLButtonElement) {
  b.classList.toggle("on", store.autoApproveAll)
  b.classList.remove("confirming")
  b.querySelector(".aa-label")!.textContent = store.autoApproveAll ? "Auto-approve on" : "Auto-approve"
  b.setAttribute("aria-pressed", String(store.autoApproveAll))
  b.title = store.autoApproveAll
    ? "Approving every permission request from every session while this page is open. Click to stop."
    : "Approve every permission request automatically (while this page is open)"
}

function paint(store: Store) {
  for (const b of togglesFor(toggles, store)) paintButton(store, b)
}

export function autoApproveToggle(store: Store): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = "aa-toggle"
  b.innerHTML = `<span class="aa-dot" aria-hidden="true"></span><span class="aa-label"></span>`
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  b.addEventListener("click", () => {
    if (store.autoApproveAll) {
      clearTimeout(confirmTimer)
      store.setAutoApproveAll(false)
      toast("Auto-approve off: sessions will ask again")
      return paint(store)
    }
    if (!b.classList.contains("confirming")) {
      b.classList.add("confirming")
      b.querySelector(".aa-label")!.textContent = "Click again: allow everything?"
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => {
        if (b.classList.contains("confirming") && !store.autoApproveAll) paintButton(store, b)
      }, 4000)
      return
    }
    clearTimeout(confirmTimer)
    const pending = store.pendingPermissionCount()
    const approving = store.setAutoApproveAll(true)
    if (pending) {
      void approving.then((n) => toast(n ? `Auto-approve on: approved ${n} waiting request${n === 1 ? "" : "s"}` : "Auto-approve on"))
    } else {
      toast("Auto-approve on")
    }
    paint(store)
  })
  togglesFor(toggles, store).add(b)
  paintButton(store, b)
  return b
}

/** Batch "approved X" notices so a burst of tool calls shows one toast. */
export function autoApprovedNotices(store: Store) {
  let batch: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  store.onAutoApproved = (req) => {
    const s = store.sessions.get(req.sessionID)
    const where = s ? store.projectLabel(s) : "a session"
    const what = req.resources?.[0] ? `${req.action} ${req.resources[0]}` : req.action
    batch.push(`${what.length > 48 ? what.slice(0, 47) + "…" : what} (${where})`)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const items = batch
      batch = []
      toast(items.length === 1 ? `Auto-approved ${items[0]}` : `Auto-approved ${items.length} requests`)
    }, 600)
  }
}

function paintDismiss(store: Store) {
  for (const b of togglesFor(dismissToggles, store)) {
    b.classList.toggle("on", store.autoDismissQuestions)
    b.querySelector(".aa-label")!.textContent = store.autoDismissQuestions ? "Dismissing questions" : "Dismiss questions"
    b.setAttribute("aria-pressed", String(store.autoDismissQuestions))
    b.title = store.autoDismissQuestions
      ? "Automatically dismissing question prompts while this page is open. Click to stop."
      : "Automatically dismiss question prompts instead of waiting for your answer (while this page is open)"
  }
}

export function autoDismissToggle(store: Store): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = "aa-toggle dismiss"
  b.innerHTML = `<span class="aa-dot" aria-hidden="true"></span><span class="aa-label"></span>`
  b.addEventListener("click", () => {
    const on = !store.autoDismissQuestions
    const pending = on ? store.pendingQuestionCount() : 0
    const dismissing = store.setAutoDismissQuestions(on)
    if (!on) {
      toast("Questions will wait for you again")
    } else if (pending) {
      void dismissing.then((n) => toast(
        n ? `Won't wait for answers: dismissed ${n} waiting question${n === 1 ? "" : "s"}` : "Won't wait for answers: dismissing new questions",
      ))
    } else {
      toast("Won't wait for answers: dismissing new questions")
    }
    paintDismiss(store)
  })
  togglesFor(dismissToggles, store).add(b)
  paintDismiss(store)
  return b
}

/** Batch "dismissed X" notices so a burst of questions shows one toast. */
export function autoDismissedNotices(store: Store) {
  let batch: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  store.onAutoDismissed = (form) => {
    const s = store.sessions.get(form.sessionID)
    const where = s ? store.projectLabel(s) : "a session"
    const what = form.title || "question"
    batch.push(`${what.length > 48 ? what.slice(0, 47) + "…" : what} (${where})`)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const items = batch
      batch = []
      toast(items.length === 1 ? `Dismissed ${items[0]}` : `Dismissed ${items.length} questions`)
    }, 600)
  }
}
