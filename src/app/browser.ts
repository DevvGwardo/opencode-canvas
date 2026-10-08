import { BROWSER_HEIGHT, BROWSER_WIDTH, browserUrl, type BrowserAction, type BrowserEvent } from "../shared/browser"

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const element = document.createElement(tag)
  element.className = cls
  if (text !== undefined) element.textContent = text
  return element
}

export class BrowserPanel {
  readonly el: HTMLElement
  private address: HTMLInputElement
  private viewport: HTMLElement
  private image: HTMLImageElement
  private status: HTMLElement
  private tabs: HTMLElement
  private dialog: HTMLElement
  private deviceBtn: HTMLButtonElement
  private width = BROWSER_WIDTH
  private height = BROWSER_HEIGHT
  private stream?: EventSource
  private active = ""
  private open_ = false
  private ready = false
  private pendingUrl?: string
  private wheel?: { x: number; y: number; deltaX: number; deltaY: number }
  private wheelTimer?: ReturnType<typeof setTimeout>
  private requests: Promise<void> = Promise.resolve()
  private generation = 0
  private previousFocus?: HTMLElement

  constructor(host: HTMLElement, private onChange: () => void) {
    this.el = h("section", "browser-panel")
    this.el.setAttribute("aria-label", "Host Chromium browser")
    const head = h("header", "browser-head")
    const close = this.button("Close", "Close browser panel", () => this.close())
    this.deviceBtn = this.button("Phone layout", "Switch browser between desktop and phone layouts", () =>
      this.send({ type: "viewport", mode: this.width === BROWSER_WIDTH ? "phone" : "desktop" }))
    const maximize = this.button("Expand", "Toggle full-size browser", () => {
      this.el.classList.toggle("expanded")
      this.onChange()
    })
    head.append(h("strong", "", "Browser"), h("span", "browser-note", "Isolated Chrome · shared on this host"), this.deviceBtn, maximize, close)
    const toolbar = h("form", "browser-toolbar")
    this.address = h("input") as HTMLInputElement
    this.address.type = "text"
    this.address.setAttribute("aria-label", "Browser address")
    this.address.placeholder = "URL or localhost:3000"
    this.address.autocomplete = "off"
    this.address.spellcheck = false
    toolbar.append(
      this.button("←", "Browser back", () => this.send({ type: "back" })),
      this.button("→", "Browser forward", () => this.send({ type: "forward" })),
      this.button("↻", "Reload browser page", () => this.send({ type: "reload" })),
      this.address,
      this.button("Go", "Navigate browser", () => this.navigate(this.address.value)),
    )
    toolbar.addEventListener("submit", (e) => { e.preventDefault(); this.navigate(this.address.value) })
    this.tabs = h("div", "browser-tabs")
    this.viewport = h("div", "browser-viewport")
    this.viewport.tabIndex = 0
    this.viewport.setAttribute("role", "group")
    this.viewport.setAttribute("aria-label", "Remote browser viewport. Click to interact, or use Type for touch keyboard input.")
    this.image = h("img", "browser-frame") as HTMLImageElement
    this.image.alt = "Live browser page"
    this.image.draggable = false
    this.image.hidden = true
    this.viewport.append(this.image)
    this.dialog = h("div", "browser-dialog")
    this.dialog.hidden = true
    this.dialog.setAttribute("role", "alertdialog")
    const footer = h("div", "browser-footer")
    this.status = h("span", "browser-status", "Chrome runs on the Canvas host")
    const typing = h("form", "browser-typing")
    const input = h("input") as HTMLInputElement
    input.setAttribute("aria-label", "Text to type in browser")
    input.placeholder = "Type into focused page field…"
    const type = this.button("Type", "Type text into browser page", () => {
      this.send({ type: "text", text: input.value })
      input.value = ""
    })
    typing.append(input, type)
    typing.addEventListener("submit", (e) => { e.preventDefault(); type.click() })
    footer.append(this.status, typing, this.button("Enter", "Press Enter in browser", () => this.send({ type: "key", key: "Enter", code: "Enter", modifiers: 0 })))
    this.el.append(head, toolbar, this.tabs, this.viewport, this.dialog, footer)
    host.append(this.el)
    this.bindInput()
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape" && e.target !== this.viewport) this.close()
    })
    document.addEventListener("visibilitychange", () => {
      if (!this.open_) return
      if (document.hidden) this.disconnect()
      else void this.connect()
    })
  }

  get isOpen() { return this.open_ }

  private button(label: string, title: string, run: () => unknown) {
    const button = h("button", "browser-btn", label) as HTMLButtonElement
    button.type = "button"
    button.title = title
    button.setAttribute("aria-label", title)
    button.addEventListener("click", () => run())
    return button
  }

  open(url?: string) {
    if (url) {
      try { this.pendingUrl = browserUrl(url) } catch (e) { this.status.textContent = (e as Error).message; return }
    }
    if (this.open_) {
      if (this.pendingUrl && this.ready) {
        this.navigate(this.pendingUrl)
        this.pendingUrl = undefined
      }
      return
    }
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.open_ = true
    this.el.classList.add("visible")
    document.documentElement.classList.add("browser-open")
    this.onChange()
    void this.connect()
    this.address.focus()
  }

  close() {
    this.open_ = false
    this.disconnect()
    this.el.classList.remove("visible", "expanded")
    document.documentElement.classList.remove("browser-open")
    this.dialog.hidden = true
    this.image.removeAttribute("src")
    this.image.hidden = true
    this.onChange()
    this.previousFocus?.focus()
  }

  private disconnect() {
    this.generation++
    this.ready = false
    this.stream?.close()
    this.stream = undefined
    clearTimeout(this.wheelTimer)
    this.wheel = undefined
  }

  private async connect() {
    this.disconnect()
    const generation = this.generation
    this.status.textContent = "Starting isolated Chromium…"
    try {
      const res = await fetch("/canvas/browser")
      if (!res.ok) throw new Error(res.status === 401 ? "Canvas login expired. Reload to sign in." : `Browser unavailable (${res.status})`)
      const state = await res.json()
      if (!state.available) throw new Error("Install Chrome/Chromium on the host, or set CANVAS_BROWSER_BIN.")
      if (!this.open_ || generation !== this.generation || document.hidden) return
      const stream = new EventSource("/canvas/browser/events")
      let phoneLayout = !state.running && innerWidth < 640
      this.stream = stream
      stream.onmessage = (message) => {
        if (this.stream !== stream) return
        let event: BrowserEvent
        try { event = JSON.parse(message.data) } catch { return }
        if (event.type === "frame") {
          this.width = event.width
          this.height = event.height
          this.image.style.aspectRatio = `${event.width} / ${event.height}`
          this.image.src = `data:image/jpeg;base64,${event.data}`
          this.image.hidden = false
        } else if (event.type === "state") {
          this.ready = true
          this.active = event.active
          this.width = event.width
          this.height = event.height
          this.deviceBtn.textContent = event.width === BROWSER_WIDTH ? "Phone layout" : "Desktop layout"
          if (document.activeElement !== this.address) this.address.value = event.url === "about:blank" ? "" : event.url
          this.status.textContent = event.title || "Ready. Enter a URL to browse."
          this.renderTabs(event)
          if (phoneLayout) {
            phoneLayout = false
            this.send({ type: "viewport", mode: "phone" })
          }
          if (this.pendingUrl) {
            this.navigate(this.pendingUrl)
            this.pendingUrl = undefined
          }
        } else if (event.type === "dialog") this.showDialog(event)
        else {
          this.status.textContent = event.message
          this.disconnect()
        }
      }
      stream.onerror = () => {
        if (this.stream !== stream) return
        this.ready = false
        this.status.textContent = "Browser disconnected. Close and reopen the panel to reconnect."
        this.disconnect()
      }
    } catch (e) {
      if (generation === this.generation) this.status.textContent = (e as Error).message
    }
  }

  private renderTabs(event: Extract<BrowserEvent, { type: "state" }>) {
    this.tabs.replaceChildren(...event.tabs.map((tab) => {
      const item = h("div", `browser-tab${tab.id === this.active ? " active" : ""}`)
      const select = this.button(tab.title, `Switch to ${tab.title}`, () => this.send({ type: "switch", id: tab.id }))
      const close = this.button("×", `Close ${tab.title}`, () => this.send({ type: "close-tab", id: tab.id }))
      item.append(select, close)
      return item
    }), this.button("+", "New browser tab", () => this.send({ type: "new-tab" })))
  }

  private navigate(value: string) {
    try {
      const url = browserUrl(value)
      this.address.value = url
      this.send({ type: "navigate", url })
    } catch (e) { this.status.textContent = (e as Error).message }
  }

  private send(action: BrowserAction) {
    if (!this.ready) { this.status.textContent = "Wait for the browser to connect first."; return }
    const generation = this.generation
    this.requests = this.requests.then(async () => {
      if (generation !== this.generation || !this.open_) return
      const res = await fetch("/canvas/browser/action", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action),
      })
      if (!res.ok) throw new Error((await res.json()).message ?? `Browser input failed (${res.status})`)
    }).catch((e) => { this.status.textContent = (e as Error).message })
  }

  private point(clientX: number, clientY: number) {
    const rect = this.image.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(this.width, (clientX - rect.left) / rect.width * this.width)),
      y: Math.max(0, Math.min(this.height, (clientY - rect.top) / rect.height * this.height)),
    }
  }

  private bindInput() {
    let touch: { x: number; y: number } | undefined
    let suppressClick = 0
    this.image.addEventListener("click", (e) => {
      if (Date.now() < suppressClick) return
      this.viewport.focus()
      this.send({ type: "click", ...this.point(e.clientX, e.clientY) })
    })
    this.image.addEventListener("wheel", (e) => {
      e.preventDefault()
      const point = this.point(e.clientX, e.clientY)
      const factor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? this.height : 1
      this.wheel = {
        ...point,
        deltaX: Math.max(-4000, Math.min(4000, (this.wheel?.deltaX ?? 0) + e.deltaX * factor)),
        deltaY: Math.max(-4000, Math.min(4000, (this.wheel?.deltaY ?? 0) + e.deltaY * factor)),
      }
      if (this.wheelTimer) return
      this.wheelTimer = setTimeout(() => {
        this.wheelTimer = undefined
        if (this.wheel) this.send({ type: "scroll", ...this.wheel })
        this.wheel = undefined
      }, 60)
    }, { passive: false })
    this.image.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return
      e.preventDefault()
      touch = { x: e.clientX, y: e.clientY }
      this.image.setPointerCapture(e.pointerId)
    })
    this.image.addEventListener("pointerup", (e) => {
      if (!touch) return
      suppressClick = Date.now() + 500
      const start = touch
      touch = undefined
      const dx = start.x - e.clientX
      const dy = start.y - e.clientY
      const rect = this.image.getBoundingClientRect()
      if (Math.abs(dx) + Math.abs(dy) > 10) {
        this.send({ type: "scroll", ...this.point(start.x, start.y), deltaX: Math.max(-4000, Math.min(4000, dx / rect.width * this.width)), deltaY: Math.max(-4000, Math.min(4000, dy / rect.height * this.height)) })
      } else this.send({ type: "click", ...this.point(e.clientX, e.clientY) })
    })
    this.image.addEventListener("pointercancel", () => { touch = undefined })
    this.viewport.addEventListener("keydown", (e) => {
      if (e.isComposing || (e.ctrlKey || e.metaKey) && ["v", "c", "x"].includes(e.key.toLowerCase())) return
      e.preventDefault()
      const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
      this.send({ type: "key", key: e.key, code: e.code, modifiers, ...(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? { text: e.key } : {}) })
    })
    this.viewport.addEventListener("paste", (e) => {
      e.preventDefault()
      this.send({ type: "text", text: e.clipboardData?.getData("text/plain") ?? "" })
    })
  }

  private showDialog(event: Extract<BrowserEvent, { type: "dialog" }>) {
    const label = h("p", "", event.message)
    const input = h("input") as HTMLInputElement
    input.setAttribute("aria-label", "Browser dialog answer")
    input.hidden = event.kind !== "prompt"
    const respond = (accept: boolean) => {
      this.send({ type: "dialog", accept, text: input.value })
      this.dialog.hidden = true
    }
    this.dialog.replaceChildren(label, input, this.button("Cancel", "Dismiss browser dialog", () => respond(false)), this.button("OK", "Accept browser dialog", () => respond(true)))
    this.dialog.hidden = false
  }
}
