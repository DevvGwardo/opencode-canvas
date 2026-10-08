import { describe, expect, test } from "bun:test"
import { BrowserHost, findBrowser } from "../src/server/browser"
import { browserUrl, validateBrowserAction, type BrowserEvent } from "../src/shared/browser"

describe("browser input", () => {
  test("normalizes web and local development URLs", () => {
    expect(browserUrl("example.com")).toBe("https://example.com/")
    expect(browserUrl("localhost:3000")).toBe("http://localhost:3000/")
    expect(browserUrl("http://192.168.1.2:5173/app")).toBe("http://192.168.1.2:5173/app")
    expect(browserUrl("about:blank")).toBe("about:blank")
    expect(() => browserUrl("file:///etc/passwd")).toThrow()
    expect(() => browserUrl("javascript:alert(1)")).toThrow()
    expect(() => browserUrl("http://user:password@example.com")).toThrow("without embedded credentials")
  })

  test("accepts bounded inputs and rejects arbitrary CDP or invalid coordinates", () => {
    expect(validateBrowserAction({ type: "click", x: 100, y: 20 })).toEqual({ type: "click", x: 100, y: 20 })
    expect(validateBrowserAction({ type: "navigate", url: "localhost:3000", extra: "ignored" })).toEqual({ type: "navigate", url: "http://localhost:3000/" })
    expect(() => validateBrowserAction({ type: "click", x: -1, y: 20 })).toThrow()
    expect(() => validateBrowserAction({ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: Infinity })).toThrow()
    expect(() => validateBrowserAction({ type: "Runtime.evaluate", expression: "dangerous()" })).toThrow()
    expect(() => validateBrowserAction({ type: "text", text: "x".repeat(16001) })).toThrow()
    expect(() => validateBrowserAction({ type: "key", key: "a", code: "KeyA", modifiers: 1.5 })).toThrow()
    expect(() => validateBrowserAction({ type: "switch", id: "../version" })).toThrow()
  })

  test("missing browser produces an actionable error", async () => {
    const host = new BrowserHost(undefined)
    await expect(host.start()).rejects.toThrow("Install Chrome or Chromium")
    await host.stop()
  })
})

const executable = findBrowser()

test.skipIf(!executable)("real Chromium streams an isolated viewport, accepts input, and manages tabs", async () => {
  let typed = ""
  let submitted = ""
  const fixture = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/typed") {
        typed = url.searchParams.get("text") ?? ""
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/submitted") {
        submitted = url.searchParams.get("text") ?? ""
        return new Response(null, { status: 204 })
      }
      return new Response(`<!doctype html><title>Browser fixture</title>
        <form onsubmit="event.preventDefault();fetch('/submitted?text='+encodeURIComponent(document.querySelector('input').value))">
          <input aria-label="Fixture input" style="position:absolute;left:20px;top:20px;width:300px;height:30px" oninput="fetch('/typed?text='+encodeURIComponent(this.value))">
        </form><p style="margin-top:100px">A real browser, no iframe.</p>`, {
        headers: { "content-type": "text/html", "x-frame-options": "DENY" },
      })
    },
  })
  const host = new BrowserHost(executable)
  const events: BrowserEvent[] = []
  let off: (() => void) | undefined
  const until = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 10_000
    while (!condition() && Date.now() < deadline) await Bun.sleep(40)
    if (!condition()) throw new Error(`Timed out waiting for ${label}. Typed: ${typed}; submitted: ${submitted}; latest state: ${JSON.stringify(events.filter((event) => event.type === "state").at(-1))}`)
    expect(condition()).toBe(true)
  }
  try {
    off = await host.subscribe((event) => events.push(event))
    await until(() => events.some((event) => event.type === "frame" && event.data.length > 100), "initial frame")
    const url = `http://127.0.0.1:${fixture.port}/`
    await host.action({ type: "navigate", url })
    await until(() => events.some((event) => event.type === "state" && event.url === url && event.title === "Browser fixture"), "navigation")
    await host.action({ type: "click", x: 50, y: 40 })
    await host.action({ type: "text", text: "canvas browser input" })
    await until(() => typed === "canvas browser input", "text input")
    await host.action({ type: "key", key: "Enter", code: "Enter", modifiers: 0 })
    await until(() => submitted === "canvas browser input", "Enter submission")
    const original = events.filter((event) => event.type === "state").at(-1)!
    if (original.type !== "state") throw new Error("Missing browser state")
    await host.action({ type: "new-tab" })
    await until(() => events.some((event) => event.type === "state" && event.tabs.length === 2), "new tab")
    await host.action({ type: "switch", id: original.active })
    await until(() => events.filter((event) => event.type === "state").at(-1)?.active === original.active, "tab switching")
    await host.action({ type: "back" })
    await until(() => events.filter((event) => event.type === "state").at(-1)?.url === "about:blank", "back navigation")
    await host.action({ type: "forward" })
    await until(() => events.filter((event) => event.type === "state").at(-1)?.url === url, "forward navigation")
    await host.action({ type: "viewport", mode: "phone" })
    await until(() => events.some((event) => event.type === "frame" && event.width === 390 && event.height === 780), "phone viewport")
    await host.action({ type: "close-tab", id: original.active })
    await until(() => events.filter((event) => event.type === "state").at(-1)?.tabs.length === 1, "active tab closing")
    const last = events.filter((event) => event.type === "state").at(-1)!
    await host.action({ type: "close-tab", id: last.active })
    await until(() => events.filter((event) => event.type === "state").at(-1)?.active !== last.active, "closing the last tab")
    expect(events.filter((event) => event.type === "error")).toEqual([])
  } finally {
    off?.()
    await host.stop()
    fixture.stop(true)
  }
  expect(host.running).toBe(false)
}, 40_000)
