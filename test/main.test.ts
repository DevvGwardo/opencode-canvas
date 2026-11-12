import { describe, expect, test } from "bun:test"
import { documentTitle, isInteractiveControlTarget, isTextInputTarget, parseHashRoute } from "../src/app/main"

const fakeTarget = (matchSelector: string | null) =>
  ({
    closest: (selector: string) =>
      matchSelector && selector.split(",").map((s) => s.trim()).includes(matchSelector) ? ({} as Element) : null,
  }) as unknown as Element

describe("main pure helpers", () => {
  test("parseHashRoute separates empty, tiles, and session IDs", () => {
    expect(parseHashRoute("")).toEqual({ kind: "none" })
    expect(parseHashRoute("#")).toEqual({ kind: "none" })
    expect(parseHashRoute("#tiles")).toEqual({ kind: "tiles" })
    expect(parseHashRoute("tiles")).toEqual({ kind: "tiles" })
    expect(parseHashRoute("#ses_123")).toEqual({ kind: "session", id: "ses_123" })
  })

  test("documentTitle formats pluralization and combines review + failed counts", () => {
    expect(documentTitle({ "needs-you": 0, working: 0, review: 0, failed: 0 })).toBe("OpenCode Canvas")
    expect(documentTitle({ "needs-you": 1, working: 0, review: 0, failed: 0 })).toBe("1 needs you — OpenCode Canvas")
    expect(documentTitle({ "needs-you": 2, working: 3, review: 1, failed: 2 })).toBe(
      "2 need you · 3 working · 3 to review — OpenCode Canvas",
    )
  })

  test("target classification separates text inputs from interactive buttons and checkboxes", () => {
    expect(isTextInputTarget(null)).toBe(false)
    expect(isTextInputTarget(fakeTarget("textarea"))).toBe(true)
    expect(isTextInputTarget(fakeTarget("select"))).toBe(true)
    expect(isTextInputTarget(fakeTarget("[contenteditable='']"))).toBe(true)
    expect(isTextInputTarget(fakeTarget("button"))).toBe(false)

    expect(isInteractiveControlTarget(null)).toBe(false)
    expect(isInteractiveControlTarget(fakeTarget("button"))).toBe(true)
    expect(isInteractiveControlTarget(fakeTarget("[role='radio']"))).toBe(true)
    expect(isInteractiveControlTarget(fakeTarget("input[type='checkbox']"))).toBe(true)
    expect(isInteractiveControlTarget(fakeTarget("textarea"))).toBe(false)
  })
})
