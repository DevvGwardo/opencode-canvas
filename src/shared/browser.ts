export const BROWSER_WIDTH = 1280
export const BROWSER_HEIGHT = 800
export const PHONE_WIDTH = 390
export const PHONE_HEIGHT = 780

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" }
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; code: string; modifiers: number; text?: string }
  | { type: "dialog"; accept: boolean; text?: string }
  | { type: "switch" | "close-tab"; id: string }
  | { type: "new-tab" }
  | { type: "viewport"; mode: "desktop" | "phone" }

export type BrowserEvent =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "state"; url: string; title: string; tabs: Array<{ id: string; title: string }>; active: string; width: number; height: number }
  | { type: "dialog"; message: string; kind: string }
  | { type: "error"; message: string }

export function browserUrl(value: string): string {
  const input = value.trim()
  if (input === "about:blank") return input
  const normalized = /^https?:\/\//i.test(input) ? input
    : /^(?:localhost|127\.\d+\.\d+\.\d+|\[[\da-f:]+\])(?::|\/|$)/i.test(input) ? `http://${input}`
    : `https://${input}`
  const url = new URL(normalized)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error("Enter an HTTP(S) URL without embedded credentials.")
  }
  // Schemes such as file:, javascript: and chrome: must not become hostnames.
  if (/^[a-z][\w+.-]*:/i.test(input) && !/^https?:\/\//i.test(input) && !/^[^/:]+:\d+(?:\/|$)/.test(input)) {
    throw new Error("Only HTTP(S) pages are supported.")
  }
  return url.toString()
}

export function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object") throw new Error("Invalid browser action")
  const v = value as Record<string, any>
  const bounded = (n: unknown, min: number, max: number): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= min && n <= max
  switch (v.type) {
    case "navigate":
      if (typeof v.url === "string" && v.url.length <= 8192) return { type: "navigate", url: browserUrl(v.url) }
      break
    case "back": case "forward": case "reload": case "new-tab":
      return { type: v.type }
    case "viewport":
      if (v.mode === "desktop" || v.mode === "phone") return { type: "viewport", mode: v.mode }
      break
    case "click": case "scroll":
      if (!bounded(v.x, 0, BROWSER_WIDTH) || !bounded(v.y, 0, BROWSER_HEIGHT)) break
      if (v.type === "click") return { type: "click", x: v.x, y: v.y }
      if (bounded(v.deltaX, -4000, 4000) && bounded(v.deltaY, -4000, 4000)) {
        return { type: "scroll", x: v.x, y: v.y, deltaX: v.deltaX, deltaY: v.deltaY }
      }
      break
    case "text":
      if (typeof v.text === "string" && v.text.length <= 16_000) return { type: "text", text: v.text }
      break
    case "key":
      if (typeof v.key !== "string" || v.key.length > 40 || typeof v.code !== "string" || v.code.length > 40 || !bounded(v.modifiers, 0, 15) || !Number.isInteger(v.modifiers)) break
      if (v.text !== undefined && (typeof v.text !== "string" || v.text.length > 8)) break
      return { type: "key", key: v.key, code: v.code, modifiers: v.modifiers, ...(v.text !== undefined ? { text: v.text } : {}) }
    case "dialog":
      if (typeof v.accept === "boolean" && (v.text === undefined || typeof v.text === "string" && v.text.length <= 1000)) {
        return { type: "dialog", accept: v.accept, text: v.text }
      }
      break
    case "switch": case "close-tab":
      if (typeof v.id === "string" && /^[A-Fa-f0-9]{1,64}$/.test(v.id)) return { type: v.type, id: v.id }
  }
  throw new Error("Invalid browser action")
}
