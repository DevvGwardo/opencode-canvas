import { describe, expect, test } from "bun:test"
import type { Backend, CommandInput, PromptInput } from "../src/app/backend"
import { CANVAS_COMMANDS, SlashCommands, commandMatches, parseCommand, runCanvasCommand, sendPrompt } from "../src/app/commands"
import { FakeEvent, withDom } from "./dom-harness"

describe("slash commands", () => {
  test("parses command arguments without treating file paths as commands", () => {
    expect(parseCommand("/review branch")).toEqual({ name: "review", text: "branch" })
    expect(parseCommand(" /custom-task\nfirst\nsecond ")).toEqual({ name: "custom-task", text: "first\nsecond" })
    expect(parseCommand("/review")).toEqual({ name: "review", text: "" })
    expect(parseCommand("/team:review.main branch")).toEqual({ name: "team:review.main", text: "branch" })
    expect(parseCommand("/Users/you/app.ts")).toBeUndefined()
    expect(parseCommand("Review /src")).toBeUndefined()
  })

  test("filters command names only while completing the command", () => {
    expect(commandMatches(CANVAS_COMMANDS, "/ef").map((c) => c.name)).toEqual(["effort"])
    expect(commandMatches(CANVAS_COMMANDS, "/EFF").map((c) => c.name)).toEqual(["effort"])
    expect(commandMatches(CANVAS_COMMANDS, "/effort high")).toEqual([])
    expect(commandMatches(CANVAS_COMMANDS, "hello")).toEqual([])
    expect(commandMatches([{ name: "team:review.main" }], "/team:r").map((c) => c.name)).toEqual(["team:review.main"])
  })

  test("sends native commands to the command endpoint with queue and attachments", async () => {
    let sent: CommandInput | undefined
    let prompt: PromptInput | undefined
    const backend = {
      command: async (_id: string, input: CommandInput) => { sent = input },
      prompt: async (_id: string, input: PromptInput) => { prompt = input },
    } as Backend
    const files = [{ uri: "data:image/png;base64,AA==", name: "image.png" }]
    await sendPrompt(backend, "ses_test", "/review main", "queue", files)
    expect(sent).toEqual({ name: "review", text: "main", delivery: "queue", files })
    expect(prompt).toBeUndefined()
    await sendPrompt(backend, "ses_test", "Check this", "steer")
    expect(prompt?.text).toBe("Check this")
  })

  test("routes Canvas controls locally and rejects ignored arguments", async () => {
    let effort: string | undefined
    let browser: string | undefined
    const handlers = {
      help: () => {}, model: () => {}, stop: () => {}, compact: () => {},
      effort: (variant?: string) => { effort = variant },
      browser: (url?: string) => { browser = url },
    }
    expect(await runCanvasCommand("/effort high", handlers)).toBe(true)
    expect(effort).toBe("high")
    expect(await runCanvasCommand("/browser http://localhost:3000", handlers)).toBe(true)
    expect(browser).toBe("http://localhost:3000")
    expect(await runCanvasCommand("/review", handlers)).toBe(false)
    await expect(runCanvasCommand("/stop ignored", handlers)).rejects.toThrow("doesn't take arguments")
  })

  test("routes /loop with or without arguments and reports unavailable loop handlers", async () => {
    let seenLoop: string | undefined = "sentinel"
    let stopped = false
    const handlers = {
      help: () => {}, model: () => {}, effort: () => {}, compact: () => {}, stop: () => {}, browser: () => {},
      loop: (args?: string) => { seenLoop = args },
      stoploop: () => { stopped = true },
    }
    expect(await runCanvasCommand("/loop", handlers)).toBe(true)
    expect(seenLoop).toBeUndefined()
    expect(await runCanvasCommand("/loop line1\nline2 --count 2", handlers)).toBe(true)
    expect(seenLoop).toBe("line1\nline2 --count 2")
    expect(await runCanvasCommand("/stoploop", handlers)).toBe(true)
    expect(stopped).toBe(true)

    const noLoopHandlers = {
      help: () => {}, model: () => {}, effort: () => {}, compact: () => {}, stop: () => {}, browser: () => {},
    }
    await expect(runCanvasCommand("/loop", noLoopHandlers)).rejects.toThrow("isn't available here")
  })

  test("SlashCommands UI completes options on Tab, lets exact commands execute on Enter, and guards empty choose()", async () => {
    await withDom(async ({ document }) => {
      const host = document.createElement("div")
      const input = document.createElement("textarea") as unknown as HTMLTextAreaElement
      document.body.append(host as any)
      const backend = {
        listCommands: async () => [{ name: "review", description: "Review diff" }],
      } as unknown as Backend
      const slash = new SlashCommands(input, host as unknown as HTMLElement, backend)
      slash.open(true)
      const menu = host.querySelector(".slash-menu")!
      expect(menu.hidden).toBe(false)
      expect(input.getAttribute("aria-expanded")).toBe("true")

      // Tab chooses active completion and adds trailing space.
      const tab = new FakeEvent("keydown", { key: "Tab" })
      expect(slash.onKey(tab as unknown as KeyboardEvent)).toBe(true)
      expect(input.value).toBe("/help ")
      expect(menu.hidden).toBe(true)

      // Exact "/stop" allows Enter to bubble back to composer rather than rewriting with space.
      input.value = "/sto"
      input.dispatchEvent(new FakeEvent("input") as unknown as Event)
      expect(menu.hidden).toBe(false)
      input.value = "/stop"
      input.dispatchEvent(new FakeEvent("input") as unknown as Event)
      const enter = new FakeEvent("keydown", { key: "Enter" })
      expect(slash.onKey(enter as unknown as KeyboardEvent)).toBe(false)

      // Defensive guard: out-of-bounds choose() does not throw.
      ;(slash as unknown as { choose(i: number): void }).choose(999)
      expect(input.value).toBe("/stop")
    })
  })
})
