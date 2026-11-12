// "New session" picker: choose one of your projects (or type a folder path,
// with autocomplete) and the model to run it on.

import type { Backend, ModelOption } from "./backend"
import { basename, timeAgo } from "./format"
import { defaultModel, effortLabel, modelRef, models, serverDefault, setDefaultModel } from "./models"
import type { Store } from "./store"
import type { ModelRef } from "./types"
import { toast } from "./toast"

interface Option {
  kind: "project" | "folder" | "path" | "model" | "server-default"
  label: string
  sub: string
  directory?: string
  model?: ModelRef
  current?: boolean
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export const looksLikePath = (q: string) => /^(~([\\/]|$)|[a-zA-Z]:[\\/]|[\\/]{1,2}|\.\.?[\\/])/.test(q)

export function isRootPath(p: string): boolean {
  return p === "/" || p === "\\" || /^[a-zA-Z]:[\\/]$/.test(p)
}

export function pathSep(p: string, home?: string): "\\" | "/" {
  if (p.includes("\\") && !p.includes("/")) return "\\"
  if (p.includes("/")) return "/"
  return home?.includes("\\") ? "\\" : "/"
}

function stripTrailing(p: string): string {
  if (isRootPath(p)) return p
  return p.replace(/[\\/]+$/, "") || p[0]
}

export function expandPath(q: string, home?: string): string {
  if (!home) return q
  if (q === "~") return home
  if (q.startsWith("~/") || q.startsWith("~\\")) {
    const cleanHome = stripTrailing(home)
    const sep = pathSep(cleanHome)
    const rest = q.slice(2).replace(/[\\/]/g, sep)
    return isRootPath(cleanHome) ? cleanHome + rest : cleanHome + sep + rest
  }
  return q
}

export function compactPath(p: string, home?: string): string {
  if (!home) return p
  const cleanHome = stripTrailing(home)
  const normP = p.replace(/\\/g, "/")
  const normH = cleanHome.replace(/\\/g, "/")
  const cmp = /^[a-zA-Z]:\//.test(normH) ? ([normP.toLowerCase(), normH.toLowerCase()] as const) : ([normP, normH] as const)
  if (cmp[0] === cmp[1]) return "~"
  const prefix = cmp[1].endsWith("/") ? cmp[1] : cmp[1] + "/"
  if (cmp[0].startsWith(prefix)) {
    const offset = normH.endsWith("/") ? normH.length - 1 : normH.length
    return "~" + normP.slice(offset)
  }
  return p
}

export function parentDir(p: string): string {
  const clean = stripTrailing(p)
  if (isRootPath(clean)) return clean
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"))
  if (slash < 0) return "/"
  if (slash === 0) return clean[0] === "\\" ? "\\" : "/"
  if (/^[a-zA-Z]:[\\/]$/.test(clean.slice(0, slash + 1))) return clean.slice(0, slash + 1)
  return clean.slice(0, slash)
}

export function joinDir(base: string, name: string, home?: string): string {
  if (isRootPath(base)) return base + name
  return stripTrailing(base) + pathSep(base, home) + name
}

export function splitFolderLookup(path: string, home?: string) {
  const trailing = /[\\/]$/.test(path)
  const exact = trailing ? stripTrailing(path) : path
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  let parent: string
  if (slash < 0) parent = pathSep(path, home)
  else if (slash === 0) parent = path[0] === "\\" ? "\\" : "/"
  else if (/^[a-zA-Z]:[\\/]$/.test(path.slice(0, slash + 1))) parent = path.slice(0, slash + 1)
  else parent = path.slice(0, slash)
  const leafName = path.slice(slash + 1)
  return {
    trailing,
    exact,
    parent,
    leafName,
    leaf: leafName.toLowerCase(),
    base: trailing ? exact : parent,
    isExactRoot: isRootPath(exact),
  }
}

const keyOf = (m?: ModelRef) => (m ? `${m.providerID}/${m.id}` : "")

const ICON: Record<Option["kind"], string> = {
  project: "◆",
  folder: "▸",
  path: "+",
  model: "◇",
  "server-default": "◇",
}

export class NewSessionPicker {
  private el?: HTMLElement
  private box!: HTMLElement
  private input!: HTMLInputElement
  private list!: HTMLElement
  private foot!: HTMLElement
  private modelBtn!: HTMLButtonElement
  private effort!: HTMLSelectElement
  private autoBox!: HTMLInputElement
  private previousFocus?: HTMLElement
  private inertBefore?: Map<HTMLElement, boolean>
  private options: Option[] = []
  private active = 0
  private seq = 0
  private folderCache = new Map<string, Promise<string[] | undefined>>()
  private mode: "where" | "model" = "where"
  private whereQuery = ""
  private preferred?: string
  private modelDirectory?: string
  private choosing?: HTMLElement
  /** undefined = OpenCode's configured default. */
  private model?: ModelRef

  constructor(
    private host: HTMLElement,
    private store: Store,
    private backend: Backend,
    private home: string | undefined,
    private onPick: (directory: string, model: ModelRef | undefined, autoApprove: boolean) => Promise<void>,
  ) {}

  get isOpen() {
    return !!this.el
  }

  open(preferDirectory?: string) {
    if (this.el) return this.input.focus()
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.preferred = preferDirectory
    this.modelDirectory = preferDirectory
    this.model = defaultModel()
    this.mode = "where"
    this.whereQuery = ""
    this.options = []
    this.active = 0
    this.folderCache.clear()

    const scrim = h("div", "picker-scrim")
    scrim.addEventListener("pointerdown", () => this.close())
    const box = h("div", "picker")
    box.setAttribute("role", "dialog")
    box.setAttribute("aria-modal", "true")
    box.setAttribute("aria-label", "New session")
    box.addEventListener("pointerdown", (e) => e.stopPropagation())
    box.addEventListener("keydown", (e) => this.onDialogKey(e))
    this.box = box

    const head = h("div", "picker-head")
    this.modelBtn = h("button", "picker-model-btn") as HTMLButtonElement
    this.modelBtn.type = "button"
    this.modelBtn.title = "Choose the model (Shift+Tab)"
    this.modelBtn.addEventListener("click", () => this.setMode(this.mode === "model" ? "where" : "model"))
    this.effort = h("select", "effort-select") as HTMLSelectElement
    this.effort.setAttribute("aria-label", "Model effort for new session")
    this.effort.title = "Model effort, using the variants configured in OpenCode"
    const auto = h("label", "picker-auto")
    this.autoBox = h("input") as HTMLInputElement
    this.autoBox.type = "checkbox"
    this.autoBox.checked = this.store.autoApproveAll
    auto.title = "Start the session with an allow-everything rule: it never stops to ask for permission"
    auto.append(this.autoBox, document.createTextNode(" Auto-approve"))
    const headRight = h("div", "picker-head-right")
    headRight.append(auto, this.modelBtn, this.effort)
    head.append(h("span", "picker-title", "New session"), headRight)

    this.input = h("input", "picker-input") as HTMLInputElement
    this.input.spellcheck = false
    this.input.autocomplete = "off"
    this.input.setAttribute("role", "combobox")
    this.input.setAttribute("aria-expanded", "true")
    this.input.setAttribute("aria-autocomplete", "list")
    this.list = h("div", "picker-list")
    this.list.id = "picker-list"
    this.list.setAttribute("role", "listbox")
    this.input.setAttribute("aria-controls", this.list.id)
    this.foot = h("div", "picker-foot")
    box.append(head, this.input, this.list, this.foot)
    scrim.append(box)
    this.inertBefore = new Map()
    for (const child of Array.from(this.host.children)) {
      if (child instanceof HTMLElement) {
        this.inertBefore.set(child, child.inert)
        child.inert = true
      }
    }
    this.host.append(scrim)
    this.el = scrim

    this.input.addEventListener("input", () => void this.refresh())
    this.setMode("where")
    void this.renderModelButton()
    requestAnimationFrame(() => this.input.focus())
  }

  close() {
    this.seq++
    if (this.inertBefore) {
      for (const [el, was] of this.inertBefore) {
        if (el.isConnected) el.inert = was
      }
      this.inertBefore = undefined
    }
    this.el?.remove()
    this.el = undefined
    const prev = this.previousFocus
    this.previousFocus = undefined
    if (prev?.isConnected) prev.focus()
  }

  private setMode(mode: "where" | "model") {
    if (mode === "model" && this.mode === "where") this.whereQuery = this.input.value
    this.mode = mode
    this.modelBtn.classList.toggle("on", mode === "model")
    this.input.value = mode === "where" ? this.whereQuery : ""
    this.input.placeholder =
      mode === "where" ? "Search projects, or type a folder path (~/code/app)" : "Search models (e.g. anthropic sonnet)"
    this.input.setAttribute("aria-label", mode === "where" ? "Project or folder" : "Model")
    this.foot.innerHTML =
      mode === "where"
        ? `<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Tab</kbd> into folder</span><span><kbd>⇧</kbd><kbd>Tab</kbd> model</span><span><kbd>Enter</kbd> start</span><span><kbd>Esc</kbd> cancel</span>`
        : `<span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> use model</span><span><kbd>Esc</kbd> back</span>`
    void this.refresh()
    this.input.focus()
  }

  private async renderModelButton() {
    const btn = this.modelBtn
    const selected = this.model
    const directory = this.modelDirectory
    const effort = this.effort
    effort.disabled = true
    btn.replaceChildren(h("span", "pm-k", "Model"))
    let name: string
    let sub: string
    let option: ModelOption | undefined
    if (selected) {
      const all = await models(this.backend, directory).catch(() => [] as ModelOption[])
      const m = all.find((x) => keyOf(x) === keyOf(selected))
      option = m
      name = m?.name ?? selected.id
      sub = selected.providerID
    } else {
      const d = await serverDefault(this.backend, directory)
      option = d
      name = d ? d.name : "OpenCode default"
      sub = d ? "OpenCode default" : ""
    }
    if (btn !== this.modelBtn || selected !== this.model || directory !== this.modelDirectory || !this.el) return
    const variant = this.model?.variant && option?.variants?.includes(this.model.variant) ? this.model.variant : ""
    btn.append(h("span", "pm-v", name))
    if (sub) btn.append(h("span", "pm-s", sub))
    btn.append(h("span", "pm-caret", "▾"))
    effort.replaceChildren(new Option("Default effort", ""), ...(option?.variants ?? []).map((v) => new Option(effortLabel(v), v)))
    effort.value = variant
    effort.disabled = !option?.variants?.length
    // Choosing effort for OpenCode's default makes that model explicit.
    effort.onchange = () => {
      if (!option) return
      this.model = { id: option.id, providerID: option.providerID, ...(effort.value ? { variant: effort.value } : {}) }
      setDefaultModel(this.model)
      void this.renderModelButton()
    }
  }

  // ---- where -------------------------------------------------------------------

  private expand(q: string) {
    return expandPath(q, this.home)
  }

  private show(p: string) {
    return compactPath(p, this.home)
  }

  private folders(dir: string) {
    let p = this.folderCache.get(dir)
    if (!p) {
      p = this.backend.listFolders(dir).catch(() => undefined)
      this.folderCache.set(dir, p)
    }
    return p
  }

  private projectOptions(q: string): Option[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const seen = new Set<string>()
    const out: Option[] = []
    for (const g of this.store.groups()) {
      if (seen.has(g.directory)) continue
      seen.add(g.directory)
      const hay = `${g.label} ${g.directory}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      const n = g.sessions.length
      out.push({
        kind: "project",
        label: g.label,
        sub: `${this.show(g.directory)} · ${n} session${n === 1 ? "" : "s"} · ${timeAgo(g.updated)}`,
        directory: g.directory,
      })
    }
    if (this.preferred && !q) {
      const i = out.findIndex((o) => o.directory === this.preferred)
      if (i > 0) out.unshift(...out.splice(i, 1))
    }
    return out.slice(0, 60)
  }

  private async folderOptions(raw: string, seq: number): Promise<Option[] | undefined> {
    const path = this.expand(raw)
    // List the parent, filter by the last segment.
    const { trailing, exact, parent, leafName, leaf, base, isExactRoot } = splitFolderLookup(path, this.home)
    const [kids, exactKids] = await Promise.all([
      this.folders(parent),
      trailing ? this.folders(exact) : Promise.resolve(null),
    ])
    if (seq !== this.seq) return undefined
    const exists = trailing ? exactKids !== undefined || isExactRoot : !!kids?.includes(leafName)
    const start: Option = {
      kind: "path",
      label: `Start in ${this.show(exact)}`,
      sub: exists ? "New session in this folder" : "No folder here yet. Pick one below or keep typing",
      directory: exact,
    }
    const opts: Option[] = exists ? [start] : []
    const names = (trailing ? (exactKids ?? []) : (kids ?? []).filter((k) => k.toLowerCase().startsWith(leaf) && k.toLowerCase() !== leaf))
      .filter((k) => !k.startsWith(".") || leaf.startsWith("."))
      .slice(0, 40)
    for (const k of names) {
      const dir = joinDir(base, k, this.home)
      opts.push({ kind: "folder", label: k, sub: this.show(dir), directory: dir })
    }
    if (!exists) opts.push(start)
    return opts
  }

  // ---- model -------------------------------------------------------------------

  private async modelOptions(q: string, seq: number): Promise<Option[] | undefined> {
    const [all, def] = await Promise.all([
      models(this.backend, this.modelDirectory).catch(() => [] as ModelOption[]),
      serverDefault(this.backend, this.modelDirectory),
    ])
    if (seq !== this.seq) return undefined
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (s: string) => terms.every((t) => s.toLowerCase().includes(t))
    const current = keyOf(this.model)
    const out: Option[] = []
    if (match(`default opencode ${def?.name ?? ""} ${keyOf(def)}`))
      out.push({
        kind: "server-default",
        label: "OpenCode default",
        sub: def ? `${def.name} · ${keyOf(def)} (from your OpenCode config)` : "Whatever your OpenCode config picks",
        current: !this.model,
      })
    const hits = all.filter((m) => match(`${keyOf(m)} ${m.name}`))
    // Current choice first, then the server's order.
    hits.sort((a, b) => Number(keyOf(b) === current) - Number(keyOf(a) === current))
    for (const m of hits.slice(0, 80))
      out.push({
        kind: "model",
        label: m.name,
        sub: keyOf(m),
        model: modelRef(m, this.model),
        current: keyOf(m) === current,
      })
    return out
  }

  // ---- list ----------------------------------------------------------------------

  private async refresh() {
    const seq = ++this.seq
    const raw = this.input.value.trim()
    let opts: Option[] | undefined
    let empty = ""
    if (this.mode === "model") {
      opts = await this.modelOptions(raw, seq)
      empty = "No matching models"
    } else if (looksLikePath(raw)) {
      opts = await this.folderOptions(raw, seq)
    } else {
      opts = this.projectOptions(raw)
      empty = raw ? "No matching projects. Type a path like ~/code/app to start somewhere new." : "No projects yet. Type a folder path."
    }
    if (!opts || seq !== this.seq) return
    this.options = opts
    this.active = Math.max(0, this.mode === "model" && !raw ? opts.findIndex((o) => o.current) : 0)
    this.render(empty)
  }

  private render(empty: string) {
    if (this.mode === "where") {
      const directory = this.options[this.active]?.directory ?? this.preferred
      if (directory !== this.modelDirectory) {
        this.modelDirectory = directory
        void this.renderModelButton()
      }
    }
    this.list.replaceChildren()
    if (!this.options.length) {
      this.input.removeAttribute("aria-activedescendant")
      this.list.append(h("div", "picker-empty", empty))
      return
    }
    this.options.forEach((o, i) => {
      const b = h("button", `picker-item ${o.kind}${i === this.active ? " active" : ""}${o.current ? " current" : ""}`) as HTMLButtonElement
      b.type = "button"
      b.tabIndex = -1
      b.id = `picker-opt-${i}`
      b.setAttribute("role", "option")
      b.setAttribute("aria-selected", String(i === this.active))
      b.append(h("span", "picker-icon", ICON[o.kind]), h("span", "picker-label", o.label), h("span", "picker-sub", o.sub))
      b.addEventListener("click", () => {
        this.active = i
        if (o.kind === "folder") this.complete()
        else void this.choose()
      })
      b.addEventListener("dblclick", () => {
        this.active = i
        void this.choose()
      })
      this.list.append(b)
    })
    this.input.setAttribute("aria-activedescendant", `picker-opt-${this.active}`)
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" })
  }

  private complete() {
    const o = this.options[this.active]
    if (!o?.directory) return
    const shown = this.show(o.directory)
    this.input.value = shown.endsWith("/") || shown.endsWith("\\") ? shown : shown + pathSep(shown)
    void this.refresh()
    this.input.focus()
  }

  private async choose() {
    const o = this.options[this.active]
    const picker = this.el
    if (!o || !picker || this.choosing === picker) return
    if (this.mode === "model") {
      this.model = o.kind === "server-default" ? undefined : o.model
      setDefaultModel(this.model) // remembered for the next new session
      await this.renderModelButton()
      if (this.el !== picker) return
      return this.setMode("where")
    }
    if (!o.directory) return
    this.choosing = picker
    const selected = this.model
    const autoApprove = this.autoBox.checked
    try {
      // Make sure a typed folder exists before creating a session there.
      if (o.kind !== "project" && !isRootPath(o.directory)) {
        const parent = parentDir(o.directory)
        const siblings = await this.folders(parent)
        if (this.el !== picker) return
        if (!siblings?.includes(basename(o.directory))) {
          this.list.replaceChildren(h("div", "picker-empty error", `${o.directory} doesn't exist (or isn't a folder).`))
          return
        }
      }
      let model = selected
      if (selected) {
        const all = await models(this.backend, o.directory)
        if (this.el !== picker) return
        const option = all.find((m) => keyOf(m) === keyOf(selected))
        if (!option) throw new Error("This model is unavailable in the selected project. Choose another model or OpenCode default.")
        model = modelRef(option, selected)
      }
      if (this.el !== picker) return
      this.close()
      await this.onPick(o.directory, model, autoApprove)
    } catch (e) {
      if (this.el === picker) this.list.replaceChildren(h("div", "picker-empty error", (e as Error).message))
      else if (!this.el) toast(`Couldn't create a session: ${(e as Error).message}`)
    } finally {
      if (this.choosing === picker) this.choosing = undefined
    }
  }

  private onDialogKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === "Escape") {
      if (e.defaultPrevented) return
      e.preventDefault()
      if (this.mode === "model") this.setMode("where")
      else this.close()
      return
    }
    if (e.target === this.input) return this.onKey(e)
    if (e.key === "Tab") {
      const focusables = [...this.box.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (!focusables.length) return
      const idx = focusables.indexOf(document.activeElement as HTMLElement)
      const next = idx < 0 ? 0 : (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length
      e.preventDefault()
      focusables[next].focus()
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!this.options.length) return
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.options.length) % this.options.length
      this.render("")
    } else if (e.key === "Tab") {
      e.preventDefault()
      if (e.shiftKey) return this.setMode(this.mode === "model" ? "where" : "model")
      if (this.mode === "model") return
      const o = this.options[this.active]
      // Tab goes into the highlighted folder or project to browse inside it.
      if (o?.directory) this.complete()
    } else if (e.key === "Enter") {
      e.preventDefault()
      void this.choose()
    }
  }
}
