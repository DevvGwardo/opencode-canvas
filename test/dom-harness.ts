// Minimal, zero-dependency DOM harness for unit tests. Restores all globals cleanly after each run.

export class FakeEvent {
  defaultPrevented = false
  propagationStopped = false
  target: any = null
  currentTarget: any = null
  key = ""
  code = ""
  shiftKey = false
  ctrlKey = false
  metaKey = false
  altKey = false
  isComposing = false
  clientX = 0
  clientY = 0
  pointerType = "mouse"
  pointerId = 1
  deltaMode = 0
  deltaX = 0
  deltaY = 0

  constructor(readonly type: string, init: Record<string, any> = {}) {
    Object.assign(this, init)
  }

  preventDefault() {
    this.defaultPrevented = true
  }

  stopPropagation() {
    this.propagationStopped = true
  }
}

export class FakeNode {
  parentNode: FakeElement | null = null
  textData = ""

  get parentElement(): FakeElement | null {
    return this.parentNode
  }

  remove() {
    if (!this.parentNode) return
    const idx = this.parentNode.childNodes.indexOf(this)
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1)
    this.parentNode = null
  }
}

export class FakeTextNode extends FakeNode {
  constructor(text: string) {
    super()
    this.textData = text
  }
}

function matchSimple(el: FakeElement, part: string): boolean {
  let s = part.trim()
  if (!s) return false
  const nots: string[] = []
  s = s.replace(/:not\(([^)]+)\)/g, (_, inner) => {
    nots.push(inner)
    return ""
  })
  for (const n of nots) {
    if (matchSimple(el, n)) return false
  }
  const attrMatches = [...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
  s = s.replace(/\[[^\]]+\]/g, "")
  for (const m of attrMatches) {
    const val = el.getAttribute(m[1])
    if (m[2] !== undefined) {
      if (val !== m[2]) return false
    } else if (val === null) return false
  }
  const idMatch = s.match(/#([A-Za-z0-9_-]+)/)
  if (idMatch) {
    if (el.id !== idMatch[1]) return false
    s = s.replace(/#[A-Za-z0-9_-]+/, "")
  }
  const classes = [...s.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  s = s.replace(/\.[A-Za-z0-9_-]+/g, "")
  for (const cls of classes) {
    if (!el.classList.contains(cls)) return false
  }
  if (s && el.tagName.toLowerCase() !== s.toLowerCase()) return false
  return true
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector.split(",").some((s) => matchSimple(el, s))
}

export class FakeStyle {
  [key: string]: any
  setProperty(name: string, value: string) {
    this[name] = value
  }
  getPropertyValue(name: string): string {
    return String(this[name] ?? "")
  }
  removeProperty(name: string) {
    delete this[name]
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string
  readonly childNodes: FakeNode[] = []
  readonly dataset: Record<string, string> = {}
  readonly style: FakeStyle = new FakeStyle()
  private attrs = new Map<string, string>()
  private listeners = new Map<string, Array<(e: any) => void>>()
  private classSet = new Set<string>()
  private rect = { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }
  private html = ""
  private ce = "inherit"

  id = ""
  title = ""
  type = ""
  value = ""
  rows = 1
  min = ""
  max = ""
  step = ""
  checked = false
  disabled = false
  readOnly = false
  spellcheck = false
  autocomplete = ""
  placeholder = ""
  tabIndex = -1
  src = ""
  alt = ""
  loading = ""
  draggable = false
  scrollHeight = 120
  scrollTop = 0
  clientHeight = 100
  offsetWidth = 100
  onkeydown: ((e: any) => void) | null = null

  constructor(tag: string, readonly doc: FakeDocument) {
    super()
    this.tagName = tag.toUpperCase()
  }

  get className(): string {
    return [...this.classSet].join(" ")
  }

  set className(v: string) {
    this.classSet.clear()
    for (const c of v.split(/\s+/).filter(Boolean)) this.classSet.add(c)
  }

  readonly classList = {
    add: (...names: string[]) => {
      for (const n of names) if (n) this.classSet.add(n)
    },
    remove: (...names: string[]) => {
      for (const n of names) this.classSet.delete(n)
    },
    toggle: (name: string, force?: boolean) => {
      const has = this.classSet.has(name)
      const on = force === undefined ? !has : force
      if (on) this.classSet.add(name)
      else this.classSet.delete(name)
      return on
    },
    contains: (name: string) => this.classSet.has(name),
  }

  get hidden(): boolean {
    return this.attrs.has("hidden")
  }

  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "")
    else this.attrs.delete("hidden")
  }

  get contentEditable(): string {
    return this.ce
  }

  set contentEditable(v: string) {
    const prev = this.ce
    this.ce = v
    if (v === "false" && prev !== "false" && this.doc.activeElement === this) {
      // Mimic Chromium synchronously blurring when contentEditable is disabled on a focused node.
      this.blur()
    }
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement)
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const idx = siblings.indexOf(this)
    return idx >= 0 ? (siblings[idx + 1] ?? null) : null
  }

  get isConnected(): boolean {
    let cur: FakeNode | null = this
    while (cur) {
      if (cur === this.doc.documentElement || cur === this.doc.body) return true
      cur = cur.parentNode
    }
    return false
  }

  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof FakeElement ? n.textContent : n.textData)).join("")
  }

  set textContent(v: string) {
    this.html = ""
    for (const n of this.childNodes) n.parentNode = null
    this.childNodes.length = 0
    if (v) {
      const t = new FakeTextNode(v)
      t.parentNode = this
      this.childNodes.push(t)
    }
  }

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(v: string) {
    this.html = v
    for (const n of this.childNodes) n.parentNode = null
    this.childNodes.length = 0
    if (!v) return
    const stack: FakeElement[] = [this]
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
    const tokenRe = /<(\/?)([A-Za-z0-9:-]+)([^>]*)>|([^<]+)/g
    for (const m of v.matchAll(tokenRe)) {
      if (m[4] !== undefined) {
        stack[stack.length - 1].append(new FakeTextNode(m[4]))
        continue
      }
      const closing = m[1] === "/"
      const tag = m[2].toLowerCase()
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName.toLowerCase() === tag) {
            stack.length = i
            break
          }
        }
        continue
      }
      const rawAttrs = m[3] ?? ""
      const selfClosing = rawAttrs.trimEnd().endsWith("/") || voidTags.has(tag)
      const el = new FakeElement(tag, this.doc)
      this.doc.created.push(el)
      const attrSrc = rawAttrs.replace(/\/\s*$/, "")
      for (const a of attrSrc.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const name = a[1]
        const val = a[2] ?? a[3] ?? a[4] ?? ""
        if (name === "class") el.className = val
        else el.setAttribute(name, val)
      }
      stack[stack.length - 1].append(el)
      if (!selfClosing) stack.push(el)
    }
  }

  setRect(r: Partial<typeof this.rect>) {
    this.rect = { ...this.rect, ...r }
  }

  getBoundingClientRect() {
    return { ...this.rect }
  }

  setAttribute(name: string, val: string) {
    this.attrs.set(name, val)
    if (name === "id") this.id = val
  }

  getAttribute(name: string): string | null {
    if (name === "contenteditable") return this.ce
    return this.attrs.get(name) ?? null
  }

  removeAttribute(name: string) {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  append(...nodes: Array<FakeNode | string>) {
    for (const raw of nodes) {
      const n = typeof raw === "string" ? new FakeTextNode(raw) : raw
      if (n.parentNode) n.remove()
      n.parentNode = this
      this.childNodes.push(n)
    }
  }

  prepend(...nodes: Array<FakeNode | string>) {
    for (const raw of [...nodes].reverse()) {
      const n = typeof raw === "string" ? new FakeTextNode(raw) : raw
      if (n.parentNode) n.remove()
      n.parentNode = this
      this.childNodes.unshift(n)
    }
  }

  after(...nodes: Array<FakeNode | string>) {
    if (!this.parentNode) return
    const p = this.parentNode
    let idx = p.childNodes.indexOf(this) + 1
    for (const raw of nodes) {
      const n = typeof raw === "string" ? new FakeTextNode(raw) : raw
      if (n.parentNode) n.remove()
      n.parentNode = p
      p.childNodes.splice(idx++, 0, n)
    }
  }

  insertBefore(newNode: FakeNode, refNode: FakeNode | null) {
    if (newNode.parentNode) newNode.remove()
    newNode.parentNode = this
    if (!refNode) {
      this.childNodes.push(newNode)
      return newNode
    }
    const idx = this.childNodes.indexOf(refNode)
    if (idx < 0) this.childNodes.push(newNode)
    else this.childNodes.splice(idx, 0, newNode)
    return newNode
  }

  replaceChildren(...nodes: Array<FakeNode | string>) {
    this.html = ""
    for (const n of this.childNodes) n.parentNode = null
    this.childNodes.length = 0
    this.append(...nodes)
  }

  replaceWith(node: FakeNode) {
    if (!this.parentNode) return
    const p = this.parentNode
    if (node.parentNode) node.remove()
    const idx = p.childNodes.indexOf(this)
    node.parentNode = p
    if (idx >= 0) p.childNodes.splice(idx, 1, node)
    this.parentNode = null
  }

  closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this
    while (cur) {
      if (matchesSelector(cur, selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        if (matchesSelector(c, selector)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(type, list.filter((f) => f !== fn))
  }

  dispatchEvent(ev: FakeEvent | string, init?: Record<string, any>): boolean {
    const event = typeof ev === "string" ? new FakeEvent(ev, init) : ev
    event.target = this
    let cur: FakeElement | null = this
    while (cur) {
      event.currentTarget = cur
      const list = [...(cur.listeners.get(event.type) ?? [])]
      for (const fn of list) fn(event)
      if (event.type === "keydown" && cur.onkeydown) cur.onkeydown(event)
      if (event.propagationStopped) break
      cur = cur.parentElement
    }
    if (!event.propagationStopped) this.doc.dispatchEvent(event)
    return !event.defaultPrevented
  }

  click() {
    this.dispatchEvent("click")
  }

  focus() {
    if (this.doc.activeElement === this) return
    const prev = this.doc.activeElement
    this.doc.activeElement = this
    if (prev) prev.dispatchEvent("blur")
    this.dispatchEvent("focus")
  }

  blur() {
    if (this.doc.activeElement === this) {
      this.doc.activeElement = null
      this.dispatchEvent("blur")
    }
  }

  select() {}
  scrollIntoView() {}
  setPointerCapture() {}
}

export class FakeDocument {
  readonly documentElement: FakeElement
  readonly body: FakeElement
  readonly created: FakeElement[] = []
  activeElement: FakeElement | null = null
  hidden = false
  title = ""
  private listeners = new Map<string, Array<(e: any) => void>>()

  constructor() {
    this.documentElement = new FakeElement("html", this)
    this.body = new FakeElement("body", this)
    this.documentElement.append(this.body)
  }

  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag, this)
    this.created.push(el)
    return el
  }

  createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text)
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector)
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector)
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`)
  }

  getSelection() {
    return { selectAllChildren: () => {} }
  }

  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(type, list.filter((f) => f !== fn))
  }

  dispatchEvent(ev: FakeEvent | string, init?: Record<string, any>) {
    const event = typeof ev === "string" ? new FakeEvent(ev, init) : ev
    event.currentTarget = this
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event)
  }
}

export class FakeWindow {
  private listeners = new Map<string, Array<(e: any) => void>>()
  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(type, list.filter((f) => f !== fn))
  }
  dispatchEvent(ev: FakeEvent | string, init?: Record<string, any>) {
    const event = typeof ev === "string" ? new FakeEvent(ev, init) : ev
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event)
  }
}

export interface DomContext {
  document: FakeDocument
  window: FakeWindow
  flushRaf(): void
}

export async function withDom<T>(fn: (ctx: DomContext) => T | Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>
  const keys = [
    "document",
    "window",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLImageElement",
    "Node",
    "DOMRect",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "WheelEvent",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
    "innerWidth",
    "innerHeight",
    "navigator",
    "fetch",
    "EventSource",
    "localStorage",
  ] as const
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const k of keys) saved.set(k, Object.getOwnPropertyDescriptor(g, k))

  const document = new FakeDocument()
  const window = new FakeWindow()
  const rafQueue: Array<FrameRequestCallback> = []
  let rafId = 1

  const mem = new Map<string, string>()
  g.document = document
  g.window = window
  g.Element = FakeElement
  g.HTMLElement = FakeElement
  g.HTMLButtonElement = FakeElement
  g.HTMLTextAreaElement = FakeElement
  g.HTMLInputElement = FakeElement
  g.HTMLImageElement = FakeElement
  g.Node = FakeNode
  g.DOMRect = class DOMRect {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    get left() { return this.x }
    get top() { return this.y }
    get right() { return this.x + this.width }
    get bottom() { return this.y + this.height }
  }
  g.Event = FakeEvent
  g.KeyboardEvent = FakeEvent
  g.MouseEvent = FakeEvent
  g.PointerEvent = FakeEvent
  g.WheelEvent = FakeEvent
  g.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafId++
  }
  g.cancelAnimationFrame = () => {}
  g.matchMedia = () => ({ matches: false })
  g.innerWidth = 1440
  g.innerHeight = 900
  g.navigator = { clipboard: undefined }
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  }

  const flushRaf = () => {
    const batch = rafQueue.splice(0)
    for (const cb of batch) cb(Date.now())
  }

  try {
    return await fn({ document, window, flushRaf })
  } finally {
    for (const k of keys) {
      const desc = saved.get(k)
      if (desc) Object.defineProperty(g, k, desc)
      else delete g[k]
    }
  }
}
