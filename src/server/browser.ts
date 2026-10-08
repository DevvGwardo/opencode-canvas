// A real, isolated Chromium browser. CDP stays on loopback; the client receives
// only viewport frames and an allowlisted set of input/navigation actions.

import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BROWSER_HEIGHT, BROWSER_WIDTH, PHONE_HEIGHT, PHONE_WIDTH, validateBrowserAction, type BrowserAction, type BrowserEvent } from "../shared/browser"

interface Target {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
}

class CDP {
  private seq = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private constructor(private socket: WebSocket, private onEvent: (method: string, params: any) => void) {}

  static async connect(url: string, onEvent: (method: string, params: any) => void) {
    const socket = new WebSocket(url)
    const cdp = new CDP(socket, onEvent)
    socket.addEventListener("message", (event) => {
      let message: any
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id) {
        const pending = cdp.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        cdp.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      } else if (message.method) {
        cdp.onEvent(message.method, message.params)
      }
    })
    socket.addEventListener("close", () => {
      for (const pending of cdp.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error("Browser connection closed"))
      }
      cdp.pending.clear()
      cdp.onEvent("Canvas.connectionClosed", {})
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Browser connection timed out")) }, 10_000)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Couldn't connect to Chromium")) }, { once: true })
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Browser tab closed before connecting")) }, { once: true })
    })
    return cdp
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser is not connected"))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser ${method} timed out`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

export function findBrowser(explicit?: string): string | undefined {
  const configured = explicit ?? process.env.CANVAS_BROWSER_BIN
  if (configured) {
    if (!existsSync(configured)) throw new Error("CANVAS_BROWSER_BIN must point to an installed Chrome/Chromium executable.")
    return configured
  }
  const candidates = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ] : process.platform === "win32" ? [
    join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ] : [
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome",
  ]
  return candidates.find((path) => existsSync(path))
}

export class BrowserHost {
  private proc?: Bun.Subprocess
  private profile?: string
  private endpoint?: string
  private cdp?: CDP
  private starting?: Promise<void>
  private targets: Target[] = []
  private active = ""
  private listeners = new Set<(event: BrowserEvent) => void>()
  private streaming = false
  private lastFrame = 0
  private width = BROWSER_WIDTH
  private height = BROWSER_HEIGHT
  private generation = 0
  private refreshTimer?: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private captureTimer?: ReturnType<typeof setTimeout>
  private actions: Promise<unknown> = Promise.resolve()
  private stopping?: Promise<void>
  private dialog?: { type: "dialog"; message: string; kind: string }

  constructor(readonly executable: string | undefined) {}

  get available() { return !!this.executable }
  get running() { return !!this.cdp }

  private emit(event: BrowserEvent) {
    for (const listener of this.listeners) listener(event)
  }

  async start() {
    if (this.stopping) await this.stopping
    if (this.cdp) return
    if (!this.starting && this.proc) await this.stop()
    this.starting ??= this.launch().catch(async (e) => {
      await this.stop()
      throw e
    }).finally(() => { this.starting = undefined })
    await this.starting
  }

  private async launch() {
    if (!this.executable) throw new Error("Install Chrome or Chromium on the host, or set CANVAS_BROWSER_BIN.")
    const generation = this.generation
    const profile = await mkdtemp(join(tmpdir(), "opencode-canvas-browser-"))
    if (generation !== this.generation) {
      await rm(profile, { recursive: true, force: true })
      throw new Error("Browser startup cancelled")
    }
    this.profile = profile
    this.proc = Bun.spawn([
      this.executable,
      "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${this.profile}`, `--window-size=${BROWSER_WIDTH},${BROWSER_HEIGHT}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-extensions", "--mute-audio",
      "about:blank",
    ], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    let port: number | undefined
    for (let i = 0; i < 100; i++) {
      if (generation !== this.generation) throw new Error("Browser startup cancelled")
      if (this.proc.exitCode !== null) throw new Error("Chromium exited before starting. Check CANVAS_BROWSER_BIN and host browser support.")
      try {
        port = Number((await readFile(join(this.profile, "DevToolsActivePort"), "utf8")).split("\n")[0])
        if (Number.isInteger(port) && port > 0 && port <= 65535) break
      } catch { /* Chromium hasn't written the private debugging port yet. */ }
      await Bun.sleep(100)
    }
    if (!port) throw new Error("Chromium startup timed out")
    this.endpoint = `http://127.0.0.1:${port}`
    this.targets = await this.listTargets()
    if (generation !== this.generation) throw new Error("Browser startup cancelled")
    const page = this.targets[0] ?? await this.newTarget()
    await this.attach(page)
    // Downloads never touch the host filesystem.
    await this.cdp!.send("Browser.setDownloadBehavior", { behavior: "deny" })
  }

  private async listTargets(): Promise<Target[]> {
    const res = await fetch(this.endpoint + "/json/list", { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error("Couldn't list browser tabs")
    return (await res.json() as Target[]).filter((target) => target.type === "page")
  }

  private async newTarget(): Promise<Target> {
    const res = await fetch(this.endpoint + "/json/new?about:blank", { method: "PUT", signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error("Couldn't open a browser tab")
    return await res.json() as Target
  }

  private async attach(target: Target) {
    if (!target.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:")) throw new Error("Invalid private browser connection")
    if (this.cdp) {
      if (this.streaming) await this.cdp.send("Page.stopScreencast").catch(() => {})
      const previous = this.cdp
      this.cdp = undefined
      previous.close()
    }
    this.streaming = false
    this.dialog = undefined
    this.active = target.id
    let cdp: CDP | undefined
    cdp = await CDP.connect(target.webSocketDebuggerUrl, (method, params) => {
      if (!cdp) return
      if (method === "Page.screencastFrame") {
        void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {})
        if (this.listeners.size && Date.now() - this.lastFrame >= 125) {
          this.lastFrame = Date.now()
          this.emit({ type: "frame", data: params.data, width: this.width, height: this.height })
        }
      } else if (method === "Page.javascriptDialogOpening") {
        this.dialog = { type: "dialog", message: params.message, kind: params.type }
        this.emit(this.dialog)
      } else if (method === "Page.javascriptDialogClosed") {
        this.dialog = undefined
      } else if (method === "Canvas.connectionClosed" && this.cdp === cdp) {
        this.cdp = undefined
        this.streaming = false
        this.emit({ type: "error", message: "Browser tab disconnected. Close and reopen the browser panel." })
      } else if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Page.loadEventFired") {
        this.queueRefresh()
        this.queueCapture()
      }
    })
    this.cdp = cdp
    await cdp.send("Page.enable")
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false,
    })
    await cdp.send("Page.bringToFront")
    if (this.listeners.size) await this.startStream()
    await this.refresh()
  }

  private async refresh() {
    if (!this.cdp) return
    this.targets = await this.listTargets()
    const target = this.targets.find((target) => target.id === this.active)
    if (!target) {
      const next = this.targets[0] ?? await this.newTarget()
      await this.attach(next)
      return
    }
    this.emit({
      type: "state", url: target.url, title: target.title, active: this.active,
      width: this.width, height: this.height,
      tabs: this.targets.map((target) => ({ id: target.id, title: target.title || "New tab" })),
    })
  }

  private queueRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh().catch((e) => this.emit({ type: "error", message: e.message })), 150)
  }

  private queueCapture() {
    clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => void this.capture().catch(() => {}), 140)
  }

  private async capture() {
    if (!this.cdp || !this.listeners.size || this.dialog) return
    const frame = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 65 })
    this.emit({ type: "frame", data: frame.data, width: this.width, height: this.height })
  }

  private async startStream() {
    if (!this.cdp || this.streaming || !this.listeners.size) return
    this.streaming = true
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 65, maxWidth: BROWSER_WIDTH, maxHeight: BROWSER_HEIGHT, everyNthFrame: 2,
    })
    await this.capture()
  }

  async subscribe(listener: (event: BrowserEvent) => void) {
    clearTimeout(this.idleTimer)
    this.listeners.add(listener)
    const unsubscribe = () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        void this.cdp?.send("Page.stopScreencast").catch(() => {})
        this.streaming = false
        this.idleTimer = setTimeout(() => void this.stop(), 5 * 60_000)
      }
    }
    try {
      await this.start()
      await this.startStream()
      await this.refresh()
      if (this.dialog) listener(this.dialog)
      await this.capture()
      return unsubscribe
    } catch (e) {
      unsubscribe()
      throw e
    }
  }

  action(value: unknown): Promise<void> {
    const action = validateBrowserAction(value)
    const next = this.actions.then(() => this.perform(action))
    this.actions = next.catch(() => {})
    return next
  }

  private async perform(action: BrowserAction) {
    if (!this.cdp) throw new Error("Open the browser panel first")
    const cdp = this.cdp
    if ((action.type === "click" || action.type === "scroll") && (action.x > this.width || action.y > this.height)) {
      throw new Error("Browser coordinates are outside the current viewport")
    }
    switch (action.type) {
      case "viewport":
        if (this.streaming) await cdp.send("Page.stopScreencast")
        this.streaming = false
        this.width = action.mode === "phone" ? PHONE_WIDTH : BROWSER_WIDTH
        this.height = action.mode === "phone" ? PHONE_HEIGHT : BROWSER_HEIGHT
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false })
        await this.startStream()
        break
      case "navigate": {
        const result = await cdp.send("Page.navigate", { url: action.url })
        if (result.errorText) throw new Error(result.errorText)
        break
      }
      case "reload":
        await cdp.send("Page.reload")
        break
      case "back": case "forward": {
        const history = await cdp.send("Page.getNavigationHistory")
        const entry = history.entries[history.currentIndex + (action.type === "back" ? -1 : 1)]
        if (entry) await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id })
        break
      }
      case "click":
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 })
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1 })
        break
      case "scroll":
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY })
        break
      case "text":
        await cdp.send("Input.insertText", { text: action.text })
        break
      case "key": {
        const text = action.text ?? (action.key === "Enter" ? "\r" : undefined)
        await cdp.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown", key: action.key, code: action.code,
          modifiers: action.modifiers, ...(text ? { text, unmodifiedText: text } : {}),
          windowsVirtualKeyCode: keyCode(action.key),
        })
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: action.key, code: action.code, modifiers: action.modifiers, windowsVirtualKeyCode: keyCode(action.key) })
        break
      }
      case "dialog":
        await cdp.send("Page.handleJavaScriptDialog", { accept: action.accept, promptText: action.text })
        this.dialog = undefined
        break
      case "new-tab":
        await this.attach(await this.newTarget())
        break
      case "switch": case "close-tab": {
        this.targets = await this.listTargets()
        const target = this.targets.find((target) => target.id === action.id)
        if (!target) throw new Error("Browser tab is no longer available")
        if (action.type === "switch") await this.attach(target)
        else {
          const active = target.id === this.active
          // Closing the active tab intentionally closes its CDP socket. Detach
          // first so it doesn't look like a browser crash to every viewer.
          if (active) {
            const previous = this.cdp
            this.cdp = undefined
            this.streaming = false
            previous?.close()
          }
          const res = await fetch(this.endpoint + `/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) })
          if (!res.ok) throw new Error("Couldn't close browser tab")
          if (active) {
            const next = (await this.listTargets()).find((page) => page.id !== target.id) ?? await this.newTarget()
            await this.attach(next)
          }
        }
        break
      }
    }
    this.queueRefresh()
    this.queueCapture()
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  private async shutdown() {
    this.generation++
    clearTimeout(this.idleTimer)
    clearTimeout(this.captureTimer)
    clearTimeout(this.refreshTimer)
    const cdp = this.cdp
    this.cdp = undefined
    cdp?.close()
    this.streaming = false
    this.active = ""
    this.targets = []
    this.width = BROWSER_WIDTH
    this.height = BROWSER_HEIGHT
    this.dialog = undefined
    const proc = this.proc
    this.proc = undefined
    if (proc && proc.exitCode === null) {
      proc.kill()
      await Promise.race([proc.exited, Bun.sleep(3000)])
      if (proc.exitCode === null) {
        proc.kill("SIGKILL")
        await proc.exited
      }
    }
    const profile = this.profile
    this.profile = undefined
    this.endpoint = undefined
    // This directory was created by this host, never a user's Chrome profile.
    if (profile) await rm(profile, { recursive: true, force: true })
  }
}

function keyCode(key: string) {
  const codes: Record<string, number> = {
    Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37,
    ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
  }
  return codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
}
