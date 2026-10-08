// The open session: expands out of its card, streams the transcript live,
// and steers or queues new input.

import type { Backend } from "./backend"
import type { CanvasView } from "./canvas"
import { CANVAS_COMMANDS, parseCommand, runCanvasCommand, sendPrompt, SlashCommands } from "./commands"
import { basename, shellQuote, timeAgo } from "./format"
import { defaultModel, effortLabel, modelLabel, modelRef, models, setDefaultModel, sessionModelOption, setSessionEffort } from "./models"
import { spinner } from "./spinners"
import type { Store } from "./store"
import { toast } from "./toast"
import { Transcript } from "./transcript"
import type { InboxItem } from "./types"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}


export class SessionPanel {
  readonly el: HTMLElement
  private scrim: HTMLElement
  private header: HTMLElement
  private projectEl: HTMLElement
  private statusEl: HTMLElement
  private modelBtn: HTMLButtonElement
  private effortBtn: HTMLButtonElement
  private autoBadge: HTMLElement
  private subBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private menuBtn: HTMLButtonElement
  private titleEl: HTMLElement
  private line: HTMLElement
  private transcript: Transcript
  private input: HTMLTextAreaElement
  private hint: HTMLElement
  private attachRow: HTMLElement
  private slash: SlashCommands
  private sendBtn: HTMLButtonElement
  private queueBtn: HTMLButtonElement
  private popover?: HTMLElement
  private drafts = new Map<string, { text: string; attachments: Array<{ uri: string; name: string }> }>()
  private changingModel = false

  id?: string
  /** Set by the app once the tiled view exists. */
  tiles?: { isPinned(id: string): boolean; togglePin(id: string): void }
  private attachments: Array<{ uri: string; name: string }> = []
  private closing = false
  private statusState = ""

  constructor(
    private host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private canvas: CanvasView,
    private onClosed: () => void,
    private openBrowser: (url?: string) => void,
  ) {
    this.scrim = h("div", "scrim")
    this.scrim.addEventListener("pointerdown", () => this.close())
    this.el = h("section", "panel")
    this.el.setAttribute("role", "dialog")
    this.el.setAttribute("aria-modal", "false")

    this.header = h("header", "panel-head")
    const left = h("div", "head-left")
    this.projectEl = h("span", "head-project")
    this.statusEl = h("span", "head-status")
    this.modelBtn = h("button", "head-btn model") as HTMLButtonElement
    this.modelBtn.title = "Switch model"
    this.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void this.toggleModels()
    })
    this.effortBtn = h("button", "head-btn effort") as HTMLButtonElement
    this.effortBtn.title = "Choose model effort"
    this.effortBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void this.showEffortPicker()
    })
    this.autoBadge = h("span", "auto-badge", "Auto-approve")
    this.autoBadge.hidden = true
    left.append(this.projectEl, this.statusEl, this.modelBtn, this.effortBtn, this.autoBadge)
    const right = h("div", "head-right")
    this.subBtn = h("button", "head-btn subagents") as HTMLButtonElement
    this.subBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.toggleSubagents()
    })
    this.stopBtn = h("button", "head-btn stop", "Stop") as HTMLButtonElement
    this.stopBtn.title = "Interrupt (⌘.)"
    this.stopBtn.addEventListener("click", () => this.interrupt())
    this.menuBtn = h("button", "head-btn menu", "⋯") as HTMLButtonElement
    this.menuBtn.setAttribute("aria-label", "Session menu")
    this.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.toggleMenu()
    })
    const browserBtn = h("button", "head-btn", "Browser") as HTMLButtonElement
    browserBtn.title = "Open the integrated browser"
    browserBtn.addEventListener("click", () => this.openBrowser())
    right.append(this.subBtn, this.stopBtn, browserBtn, this.menuBtn)
    this.header.append(left, right)

    this.titleEl = h("h1", "panel-title")
    this.titleEl.title = "Double-click to rename"
    this.titleEl.addEventListener("dblclick", () => this.beginRename())
    this.line = h("div", "panel-line")

    this.transcript = new Transcript(store, backend, {
      pageSize: 80,
      onRender: () => this.renderHeader(),
      // You watched it finish: that counts as reviewed.
      onFinished: () => {
        if (this.id && !this.closing) this.store.markViewed(this.id)
      },
    })
    this.transcript.scroller.classList.add("panel-scroll")

    const composer = h("div", "composer")
    this.attachRow = h("div", "attachments")
    const row = h("div", "composer-row")
    this.input = h("textarea", "composer-input") as HTMLTextAreaElement
    this.input.rows = 1
    this.input.setAttribute("aria-label", "Session message")
    this.input.spellcheck = true
    this.hint = h("span", "composer-hint")
    const commands = h("button", "composer-command", "/") as HTMLButtonElement
    commands.title = "Slash commands"
    commands.setAttribute("aria-label", "Show slash commands")
    commands.addEventListener("click", () => this.slash.open())
    this.sendBtn = h("button", "composer-send", "Send") as HTMLButtonElement
    this.sendBtn.addEventListener("click", () => void this.send(this.store.running.has(this.id ?? "") ? "steer" : undefined))
    this.queueBtn = h("button", "composer-command", "Queue") as HTMLButtonElement
    this.queueBtn.addEventListener("click", () => void this.send("queue"))
    row.append(commands, this.input, this.hint, this.queueBtn, this.sendBtn)
    composer.append(this.attachRow, row)
    this.slash = new SlashCommands(this.input, composer, backend)
    this.bindComposer()

    this.el.append(this.header, this.titleEl, this.line, this.transcript.scroller, composer)
    this.el.addEventListener("pointerdown", () => this.closePopover())
    host.append(this.scrim, this.el)

    store.on({
      cards: (ids) => {
        if (this.id && ids.has(this.id)) this.renderHeader()
      },
    })
    window.addEventListener("resize", () => {
      if (this.id && !this.closing) this.applyGeometry(this.targetRect(), false)
    })
  }

  get isOpen() {
    return !!this.id && !this.closing
  }

  // ---- open / close -----------------------------------------------------------

  private targetRect() {
    const vw = innerWidth
    const vh = innerHeight
    const browser = document.querySelector<HTMLElement>(".browser-panel.visible:not(.expanded)")
    const available = browser && vw >= 1000 ? browser.getBoundingClientRect().left - 8 : vw
    const w = Math.min(860, available - 32)
    const top = vw < 640 ? 12 : 24
    const bottom = vw < 640 ? 64 : 74
    return new DOMRect((available - w) / 2, top, w, vh - top - bottom)
  }

  private applyGeometry(r: DOMRect, animate: boolean) {
    this.el.classList.toggle("animating", animate)
    Object.assign(this.el.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    })
  }

  open(id: string, from?: DOMRect) {
    if (this.id === id && this.isOpen) return this.focusInput()
    const switching = this.isOpen
    if (this.id && this.id !== id) this.saveDraft()
    this.id = id
    this.closing = false
    const draft = this.drafts.get(id)
    this.input.value = draft?.text ?? ""
    this.input.style.height = "auto"
    this.attachments = draft?.attachments ?? []
    this.renderAttachments()
    this.statusState = ""
    this.closePopover()
    this.canvas.setOpen(id)
    this.store.markViewed(id)
    this.renderHeader()
    const directory = this.store.sessions.get(id)?.location.directory
    if (directory) this.slash.setDirectory(directory)

    if (!switching) {
      this.el.classList.add("visible")
      this.scrim.classList.add("visible")
      this.el.classList.add("entering")
      const target = this.targetRect()
      this.applyGeometry(from ?? new DOMRect(target.left + target.width / 2 - 150, target.top + 80, 300, 200), false)
      void this.el.offsetWidth
      this.applyGeometry(target, true)
      setTimeout(() => this.el.classList.remove("entering"), 90)
    }
    this.transcript.setSession(id)
    setTimeout(() => {
      if (this.id === id && !matchMedia("(pointer: coarse)").matches) this.input.focus({ preventScroll: true })
    }, switching ? 0 : 260)
  }

  close() {
    if (!this.id || this.closing) return
    const id = this.id
    this.closing = true
    this.saveDraft()
    this.slash.close()
    this.closePopover()
    this.input.blur()
    const rect = this.canvas.cardRect(id)
    this.el.classList.add("leaving")
    this.scrim.classList.remove("visible")
    if (rect) this.applyGeometry(rect, true)
    const done = () => {
      if (!this.closing) return
      this.el.classList.remove("visible", "leaving", "animating")
      this.canvas.setOpen(undefined)
      this.id = undefined
      this.transcript.setSession(undefined)
      this.closing = false
      this.onClosed()
    }
    setTimeout(done, rect ? 380 : 120)
  }

  // ---- rendering ----------------------------------------------------------------

  private renderHeader() {
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    this.projectEl.textContent = this.store.projectLabel(s)
    this.projectEl.title = s.location.directory
    const working = this.store.running.has(id)
    const ask = this.store.needsInput(id)
    const state = ask ? `ask:${ask}` : working ? "working" : "idle"
    if (state !== this.statusState) {
      this.statusState = state
      this.statusEl.replaceChildren()
      if (ask) this.statusEl.append(h("span", "mark needs-you"), h("span", "label", ask === "permission" ? "Needs permission" : "Waiting for your answer"))
      else if (working) this.statusEl.append(spinner(13), h("span", "label"))
      else {
        const st = s.outcome === "failed" ? "failed" : s.outcome === "interrupted" ? "stopped" : "done"
        this.statusEl.append(h("span", `mark ${st}`), h("span", "label"))
      }
      this.el.dataset.status = ask ? "needs-you" : working ? "working" : (s.outcome ?? "done")
    }
    const label = this.statusEl.querySelector(".label")
    if (label && !ask)
      label.textContent = working
        ? this.store.activityLabel(id)
        : `${s.outcome === "failed" ? "Failed" : s.outcome === "interrupted" ? "Stopped" : "Done"} · ${timeAgo(s.time.idle ?? s.time.updated)}`
    this.el.classList.toggle("working", working)
    this.modelBtn.textContent = modelLabel(s.model)
    this.effortBtn.textContent = effortLabel(s.model?.variant)
    this.effortBtn.disabled = this.modelBtn.disabled = this.changingModel
    const auto = this.store.autoApproveAll || this.store.sessionAutoApproves(id)
    this.autoBadge.hidden = !auto
    this.autoBadge.title = this.store.sessionAutoApproves(id)
      ? "This session never asks for permission (⋯ menu to change)"
      : "Auto-approve is on for every session (top bar to change)"
    this.stopBtn.hidden = !working
    const n = this.store.subagentCount(id)
    this.subBtn.hidden = n === 0
    this.subBtn.textContent = `${n} subagent${n === 1 ? "" : "s"}`
    if (document.activeElement !== this.titleEl) this.titleEl.textContent = this.store.title(s)
    this.input.placeholder = working ? "Steer…" : this.transcript.messages.length ? "Reply…" : "Ask anything…"
    this.hint.textContent = working ? "Tab to queue" : ""
    this.hint.hidden = !working
    this.sendBtn.textContent = working ? "Steer" : "Send"
    this.queueBtn.hidden = !working
  }


  // ---- header actions -----------------------------------------------------------

  private async interrupt() {
    if (!this.id) return
    await this.transcript.act(() => this.backend.interrupt(this.id!))
  }

  private beginRename() {
    const id = this.id
    if (!id) return
    const t = this.titleEl
    t.contentEditable = "plaintext-only"
    t.focus()
    document.getSelection()?.selectAllChildren(t)
    const finish = (commit: boolean) => {
      t.contentEditable = "false"
      t.removeEventListener("keydown", onKey)
      t.removeEventListener("blur", onBlur)
      const title = t.textContent?.trim() ?? ""
      const s = this.store.sessions.get(id)
      if (commit && s && title && title !== s.title) {
        s.title = title
        this.store.markStructure()
        void this.transcript.act(() => this.backend.rename(id, title))
      }
      this.renderHeader()
    }
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === "Enter") {
        e.preventDefault()
        finish(true)
      } else if (e.key === "Escape") {
        e.preventDefault()
        finish(false)
      }
    }
    const onBlur = () => finish(true)
    t.addEventListener("keydown", onKey)
    t.addEventListener("blur", onBlur)
  }

  private closePopover() {
    this.popover?.remove()
    this.popover = undefined
  }

  private showPopover(anchor: HTMLElement, items: Array<{ label: string; sub?: string; run: () => void; working?: boolean }>) {
    this.closePopover()
    const pop = h("div", "popover")
    for (const it of items) {
      const b = h("button", "pop-item") as HTMLButtonElement
      if (it.working) b.append(spinner(12))
      b.append(h("span", "pop-label", it.label))
      if (it.sub) b.append(h("span", "pop-sub", it.sub))
      b.addEventListener("click", (e) => {
        e.stopPropagation()
        this.closePopover()
        it.run()
      })
      pop.append(b)
    }
    pop.addEventListener("pointerdown", (e) => e.stopPropagation())
    const r = anchor.getBoundingClientRect()
    const pr = this.el.getBoundingClientRect()
    pop.style.top = `${r.bottom - pr.top + 6}px`
    pop.style.right = `${pr.right - r.right}px`
    this.el.append(pop)
    this.popover = pop
  }

  private toggleSubagents() {
    if (this.popover) return this.closePopover()
    const id = this.id
    if (!id) return
    const kids = [...(this.store.children.get(id) ?? [])]
      .map((k) => this.store.sessions.get(k)!)
      .filter(Boolean)
      .sort((a, b) => b.time.updated - a.time.updated)
    this.showPopover(
      this.subBtn,
      kids.map((k) => ({
        label: this.store.title(k),
        sub: this.store.running.has(k.id) ? this.store.activityLabel(k.id) : `${k.agent ?? "subagent"} · ${timeAgo(k.time.updated)}`,
        working: this.store.running.has(k.id),
        run: () => this.open(k.id),
      })),
    )
  }

  private async toggleModels() {
    if (this.popover) return this.closePopover()
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    const pop = h("div", "popover models")
    const filter = h("input", "pop-filter") as HTMLInputElement
    filter.placeholder = "Search models"
    filter.spellcheck = false
    const list = h("div", "pop-list")
    pop.append(filter, list)
    pop.addEventListener("pointerdown", (e) => e.stopPropagation())
    const r = this.modelBtn.getBoundingClientRect()
    const pr = this.el.getBoundingClientRect()
    pop.style.top = `${r.bottom - pr.top + 6}px`
    pop.style.left = `${Math.max(12, r.left - pr.left)}px`
    this.closePopover()
    this.el.append(pop)
    this.popover = pop
    list.append(h("div", "pop-empty", "Loading models…"))
    let all: Awaited<ReturnType<typeof models>>
    try {
      all = await models(this.backend, s.location.directory)
    } catch (e) {
      list.replaceChildren(h("div", "pop-empty", `Couldn't list models: ${(e as Error).message}`))
      return
    }
    if (this.popover !== pop) return
    const current = s.model ? `${s.model.providerID}/${s.model.id}` : ""
    const pinned = defaultModel()
    const draw = () => {
      const q = filter.value.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = all
        .filter((m) => {
          const hay = `${m.providerID}/${m.id} ${m.name}`.toLowerCase()
          return q.every((t) => hay.includes(t))
        })
        .slice(0, 80)
      list.replaceChildren(
        ...hits.map((m) => {
          const key = `${m.providerID}/${m.id}`
          const b = h("button", `pop-item${key === current ? " current" : ""}`) as HTMLButtonElement
          b.append(h("span", "pop-label", m.name), h("span", "pop-sub", key + (pinned && `${pinned.providerID}/${pinned.id}` === key ? " · default for new sessions" : "")))
          b.addEventListener("click", async () => {
            this.closePopover()
            const ref = modelRef(m, s.model)
            this.changingModel = true
            this.renderHeader()
            try {
              await this.backend.switchModel(id, ref)
              const current = this.store.sessions.get(id)
              if (current) current.model = ref
              setDefaultModel(ref)
              this.store.touchCard(id)
            } catch (e) {
              toast(`Couldn't switch model: ${(e as Error).message}`)
            } finally {
              this.changingModel = false
              this.renderHeader()
            }
          })
          return b
        }),
      )
      if (!hits.length) list.append(h("div", "pop-empty", "No matching models"))
    }
    filter.addEventListener("input", draw)
    filter.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape") this.closePopover()
      if (e.key === "Enter") (list.querySelector(".pop-item") as HTMLButtonElement | null)?.click()
    })
    draw()
    filter.focus()
  }

  showModelPicker() {
    return this.toggleModels()
  }

  async showEffortPicker() {
    if (this.popover) return this.closePopover()
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    try {
      const option = await sessionModelOption(this.backend, s)
      if (this.id !== id || !this.isOpen) return
      const variants = option?.variants ?? []
      this.showPopover(this.effortBtn, ["default", ...variants].map((variant) => ({
        label: variant === "default" ? "Default effort" : effortLabel(variant),
        sub: variant === (s.model?.variant ?? "default") ? "Current effort" : variant === "default" ? "Use OpenCode's configured effort" : undefined,
        run: () => void this.changeEffort(variant).catch((e) => toast(`Couldn't change effort: ${(e as Error).message}`)),
      })))
      if (!variants.length) toast("This model doesn't advertise custom effort levels")
    } catch (e) {
      toast(`Couldn't list effort levels: ${(e as Error).message}`)
    }
  }

  private async changeEffort(variant: string) {
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s || this.changingModel) return
    this.changingModel = true
    this.renderHeader()
    try {
      await setSessionEffort(this.backend, s, variant)
      const current = this.store.sessions.get(id)
      if (current) current.model = s.model
      this.store.touchCard(id)
    } finally {
      this.changingModel = false
      this.renderHeader()
    }
  }

  private async setAuto(id: string, on: boolean) {
    try {
      await this.store.setSessionAutoApprove(id, on)
      toast(on ? "Auto-approving this session" : "This session will ask for permission again")
      this.renderHeader()
    } catch (e) {
      toast(`Couldn't change permissions: ${(e as Error).message}`)
    }
  }

  private toggleMenu() {
    if (this.popover) return this.closePopover()
    const id = this.id
    const s = id ? this.store.sessions.get(id) : undefined
    if (!id || !s) return
    const copy = (text: string, what: string) => {
      this.copyText(text).then(
        () => toast(`Copied ${what}`),
        () => toast("Clipboard unavailable"),
      )
    }
    const auto = this.store.sessionAutoApproves(id)
    const items = [
      auto
        ? { label: "Stop auto-approving", sub: "Ask for permission again", run: () => void this.setAuto(id, false) }
        : { label: "Auto-approve this session", sub: "Never stop to ask for permission", run: () => void this.setAuto(id, true) },
      ...(this.tiles
        ? [
            this.tiles.isPinned(id)
              ? { label: "Unpin from Tiles", run: () => this.tiles!.togglePin(id) }
              : { label: "Pin to Tiles", sub: "Keep its chat in the tiled view", run: () => this.tiles!.togglePin(id) },
          ]
        : []),
      { label: "Copy resume command", sub: `opencode -s ${id}`, run: () => copy(`cd ${shellQuote(s.location.directory)} && opencode -s ${shellQuote(id)}`, "resume command") },
      { label: "Copy session ID", sub: id, run: () => copy(id, "session ID") },
      { label: "Rename", run: () => this.beginRename() },
    ]
    if (s.parentID && this.store.sessions.has(s.parentID))
      items.unshift({ label: "Open parent session", sub: this.store.title(this.store.sessions.get(s.parentID)!), run: () => this.open(s.parentID!) })
    this.showPopover(this.menuBtn, items)
  }

  private async copyText(text: string) {
    try {
      if (navigator.clipboard) return await navigator.clipboard.writeText(text)
    } catch { /* Plain HTTP LAN pages need the legacy clipboard fallback. */ }
    const input = h("textarea") as HTMLTextAreaElement
    input.value = text
    input.readOnly = true
    input.style.cssText = "position:fixed;left:-9999px;top:0"
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    document.body.append(input)
    try {
      input.select()
      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable")
    } finally {
      input.remove()
      focused?.focus()
    }
  }

  // ---- composer -----------------------------------------------------------------

  private bindComposer() {
    const input = this.input
    const autosize = () => {
      input.style.height = "auto"
      input.style.height = `${Math.min(220, input.scrollHeight)}px`
    }
    input.addEventListener("input", autosize)
    input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.isComposing) return
      if (this.slash.onKey(e)) return
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void this.send(this.store.running.has(this.id ?? "") ? "steer" : undefined)
      } else if (e.key === "Tab" && !e.shiftKey && (input.value.trim() || this.attachments.length)) {
        e.preventDefault()
        void this.send("queue")
      } else if (e.key === "Escape") {
        e.preventDefault()
        if (input.value) input.blur()
        else this.close()
      } else if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void this.interrupt()
      }
    })
    input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"))
      if (!files.length) return
      e.preventDefault()
      for (const f of files) {
        if (f.size > 8 * 1024 * 1024) {
          toast("Images must be smaller than 8 MB")
          continue
        }
        const id = this.id
        const reader = new FileReader()
        reader.onload = () => {
          if (this.id !== id || this.closing) return
          this.attachments.push({ uri: String(reader.result), name: f.name || "image.png" })
          this.renderAttachments()
        }
        reader.readAsDataURL(f)
      }
    })
    this.el.addEventListener("dragover", (e) => e.preventDefault())
    this.el.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"))
      if (!files.length) return
      e.preventDefault()
      for (const f of files) {
        if (f.size > 8 * 1024 * 1024) {
          toast("Images must be smaller than 8 MB")
          continue
        }
        const id = this.id
        const reader = new FileReader()
        reader.onload = () => {
          if (this.id !== id || this.closing) return
          this.attachments.push({ uri: String(reader.result), name: f.name })
          this.renderAttachments()
        }
        reader.readAsDataURL(f)
      }
    })
  }

  private renderAttachments() {
    this.attachRow.replaceChildren(
      ...this.attachments.map((a, i) => {
        const chip = h("span", "attach-chip")
        const img = h("img") as HTMLImageElement
        img.src = a.uri
        const x = h("button", "x", "×") as HTMLButtonElement
        x.setAttribute("aria-label", `Remove ${a.name}`)
        x.addEventListener("click", () => {
          this.attachments.splice(i, 1)
          this.renderAttachments()
        })
        chip.append(img, h("span", "", basename(a.name)), x)
        return chip
      }),
    )
    this.attachRow.hidden = !this.attachments.length
  }

  private async send(delivery: "steer" | "queue" | undefined) {
    const id = this.id
    const draft = this.input.value
    const text = this.input.value.trim()
    if (!id || (!text && !this.attachments.length)) return
    const command = parseCommand(text)
    if (command && CANVAS_COMMANDS.some((c) => c.name === command.name)) {
      try {
        await runCanvasCommand(text, {
          help: () => this.slash.open(),
          model: () => this.showModelPicker(),
          effort: (variant) => variant ? this.changeEffort(variant) : this.showEffortPicker(),
          compact: async () => { await this.backend.compact(id, delivery); this.transcript.scheduleRefetch(80) },
          stop: () => this.interrupt(),
          browser: (url) => this.openBrowser(url),
        })
        if (command.name !== "help" && this.id === id && this.input.value === draft) this.input.value = ""
        this.slash.close()
        if (command.name === "help") this.slash.update()
      } catch (e) {
        toast((e as Error).message)
      }
      return
    }
    const files = this.attachments.length ? [...this.attachments] : undefined
    this.input.value = ""
    this.input.style.height = "auto"
    this.attachments = []
    this.renderAttachments()
    this.slash.close()
    // Optimistic: show it as pending until the server confirms.
    const temp: InboxItem = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      sessionID: id,
      type: "user",
      payload: { text },
      delivery: delivery ?? "steer",
    }
    this.transcript.addPending(temp)
    try {
      await sendPrompt(this.backend, id, text, delivery, files)
      this.transcript.scheduleRefetch(80)
    } catch (e) {
      this.transcript.removePending(temp)
      if (this.id === id && !this.input.value) {
        this.input.value = draft
        this.attachments = [...(files ?? []).map((f) => ({ ...f, name: f.name ?? "image.png" })), ...this.attachments]
        this.renderAttachments()
      } else if (this.id !== id && !this.drafts.get(id)?.text) {
        this.drafts.set(id, { text: draft, attachments: (files ?? []).map((f) => ({ ...f, name: f.name ?? "image.png" })) })
      }
      toast(`Couldn't send: ${(e as Error).message}`)
    }
  }

  focusInput() {
    this.input.focus()
  }

  private saveDraft() {
    if (!this.id) return
    if (this.input.value || this.attachments.length) this.drafts.set(this.id, { text: this.input.value, attachments: [...this.attachments] })
    else this.drafts.delete(this.id)
  }
}
