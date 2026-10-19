import { describe, expect, test } from "bun:test"
import { formAnswer } from "../src/app/forms"
import type { FormField } from "../src/app/types"

describe("question answers", () => {
  test("requires an explicit choice and nonempty multiselect", () => {
    for (const type of ["string", "multiselect"] as const) {
      const field: FormField = { key: "choice", type, required: true, options: [{ value: "a", label: "A" }] }
      for (const value of [undefined, "", "   ", []]) {
        expect(() => formAnswer([field], { choice: value })).toThrow("an answer is required")
      }
    }
  })

  test("preserves false, zero, hidden defaults, and skips unanswered optional fields", () => {
    const fields: FormField[] = [
      { key: "enabled", type: "boolean", required: true },
      { key: "count", type: "integer", required: true },
      { key: "context", type: "string", hidden: true, default: "saved" },
      { key: "optional", type: "string" },
    ]
    expect(formAnswer(fields, { enabled: false, count: 0, optional: "" }))
      .toEqual({ enabled: false, count: 0, context: "saved" })
  })

  test("rejects unsupported choices but accepts custom answers", () => {
    const field: FormField = { key: "choice", type: "string", options: [{ value: "a", label: "A" }] }
    expect(() => formAnswer([field], { choice: "b" })).toThrow("invalid answer")
    expect(formAnswer([{ ...field, custom: true }], { choice: "b" })).toEqual({ choice: "b" })
  })

  test("validates and deduplicates multiple selections", () => {
    const field: FormField = { key: "choices", type: "multiselect", options: [{ value: "a", label: "A" }] }
    expect(formAnswer([field], { choices: ["a", "a"] })).toEqual({ choices: ["a"] })
    expect(formAnswer([field], { choices: [] })).toEqual({ choices: [] })
    for (const value of ["a", [1], ["b"]]) expect(() => formAnswer([field], { choices: value })).toThrow("invalid answer")
    expect(formAnswer([{ ...field, custom: true }], { choices: ["a", "b"] })).toEqual({ choices: ["a", "b"] })
  })

  test("accepts decimals for numbers, not integers or nonfinite values", () => {
    expect(formAnswer([{ key: "n", type: "number" }], { n: 1.5 })).toEqual({ n: 1.5 })
    for (const value of [1.5, NaN, Infinity, "2"]) {
      expect(() => formAnswer([{ key: "n", type: "integer" }], { n: value })).toThrow("invalid answer")
    }
  })

  test("does not pretend a required external question was answered", () => {
    expect(() => formAnswer([{ key: "login", type: "external", required: true }], {})).toThrow("answer this in OpenCode")
    expect(() => formAnswer([{ key: "login", type: "external" }], {})).toThrow("external link")
  })

  test("treats arbitrary field keys as data, not object prototype setters", () => {
    const answer = formAnswer([{ key: "__proto__", type: "string" }], JSON.parse('{"__proto__":"safe"}'))
    expect(Object.getPrototypeOf(answer)).toBeNull()
    expect(JSON.stringify(answer)).toBe('{"__proto__":"safe"}')
  })

  test("conditional fields use current answers and defaults, not stale hidden answers", () => {
    const fields: FormField[] = [
      { key: "enabled", type: "boolean", default: false },
      { key: "detail", type: "string", required: true, when: [{ key: "enabled", op: "eq", value: true }] },
      { key: "disabled", type: "string", when: [{ key: "enabled", op: "neq", value: true }], default: "inactive" },
    ]
    expect(formAnswer(fields, { detail: "stale" })).toEqual({ enabled: false, disabled: "inactive" })
    expect(() => formAnswer(fields, { enabled: true })).toThrow("an answer is required")
    expect(formAnswer(fields, { enabled: true, detail: "ready", disabled: "stale" })).toEqual({ enabled: true, detail: "ready" })
  })

  test("enforces advertised length, pattern, numeric, and selection limits", () => {
    const cases: Array<[FormField, unknown]> = [
      [{ key: "v", type: "string", minLength: 3 }, "ab"],
      [{ key: "v", type: "string", maxLength: 3 }, "abcd"],
      [{ key: "v", type: "string", pattern: "^yes$" }, "no"],
      [{ key: "v", type: "number", minimum: 0 }, -1],
      [{ key: "v", type: "number", maximum: 1 }, 2],
      [{ key: "v", type: "multiselect", custom: true, minItems: 2 }, ["one"]],
      [{ key: "v", type: "multiselect", custom: true, maxItems: 1 }, ["one", "two"]],
    ]
    for (const [field, value] of cases) expect(() => formAnswer([field], { v: value })).toThrow("invalid answer")
    expect(formAnswer([{ key: "v", type: "multiselect", custom: true, maxItems: 1 }], { v: ["one", "one"] })).toEqual({ v: ["one"] })
  })

  test("validates advertised string formats", () => {
    for (const [format, good, bad] of [
      ["email", "user@example.com", "invalid"],
      ["uri", "https://example.com/path", "not a URL"],
      ["date", "2024-02-29", "2024-02-30"],
      ["date-time", "2026-10-09T12:00:00Z", "2026-10-09"],
    ] as const) {
      const field: FormField = { key: "v", type: "string", format }
      expect(formAnswer([field], { v: good })).toEqual({ v: good })
      expect(() => formAnswer([field], { v: bad })).toThrow("invalid answer")
    }
    expect(formAnswer([{ key: "v", type: "string", format: "email" }], { v: "user@localhost" })).toEqual({ v: "user@localhost" })
    expect(() => formAnswer([{ key: "v", type: "string", format: "date-time" }], { v: "2024-02-30T12:00:00Z" })).toThrow("invalid answer")
  })
})
