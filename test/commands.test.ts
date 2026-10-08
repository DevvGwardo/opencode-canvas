import { describe, expect, test } from "bun:test"
import type { Backend, CommandInput, PromptInput } from "../src/app/backend"
import { CANVAS_COMMANDS, commandMatches, parseCommand, runCanvasCommand, sendPrompt } from "../src/app/commands"

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
})
