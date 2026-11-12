import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { basename, compactionLabel, describeTool, matchesQuery, shellQuote, summarizeTools, timeAgo, toolOutput, toolRow, truncate } from "../src/app/format"
import { previewBlocks, renderMarkdown } from "../src/app/markdown"
import { buildPreview } from "../src/app/store"
import type { Message } from "../src/app/types"

function findSh(): string | undefined {
  const direct = Bun.which("sh")
  if (direct) return direct
  if (process.platform !== "win32") return undefined
  const roots = new Set<string>()
  const git = Bun.which("git")
  if (git) roots.add(dirname(dirname(git)))
  if (process.env.ProgramFiles) roots.add(join(process.env.ProgramFiles, "Git"))
  if (process.env["ProgramFiles(x86)"]) roots.add(join(process.env["ProgramFiles(x86)"], "Git"))
  if (process.env.LOCALAPPDATA) roots.add(join(process.env.LOCALAPPDATA, "Programs", "Git"))
  for (const root of roots) {
    for (const rel of ["bin\\sh.exe", "usr\\bin\\sh.exe"]) {
      const candidate = join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const sh = findSh()

test("shellQuote wraps POSIX shell metacharacters without single-quote leaks", () => {
  expect(shellQuote("/code/app with spaces")).toBe("'/code/app with spaces'")
  expect(shellQuote("/code/it's a project")).toBe("'/code/it'\\''s a project'")
  expect(shellQuote("/code/$HOME/$(printf expanded)")).toBe("'/code/$HOME/$(printf expanded)'")
  expect(shellQuote("/code/line\nbreak")).toBe("'/code/line\nbreak'")
  expect(shellQuote("")).toBe("''")
})

test.skipIf(!sh)("resume commands quote paths without expanding shell syntax", async () => {
  for (const value of ["/code/app with spaces", "/code/it's a project", "/code/$HOME/$(printf expanded)", "/code/line\nbreak"]) {
    const proc = Bun.spawn([sh!, "-c", `printf %s ${shellQuote(value)}`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    })
    expect(await new Response(proc.stdout).text()).toBe(value)
    expect(await proc.exited).toBe(0)
  }
})

describe("summarizeTools", () => {
  test("matches the transcript phrasing", () => {
    const tools = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: "edit", input: { path: `f${i}.ts` } })),
      ...Array.from({ length: 12 }, () => ({ name: "shell", input: { command: "ls" } })),
      { name: "read", input: { path: "a.ts" } },
      { name: "read", input: { path: "b.ts" } },
    ]
    expect(summarizeTools(tools)).toBe("Patched 7 files, ran 12 commands, read 2 files")
  })

  test("counts distinct files, singular forms", () => {
    expect(summarizeTools([{ name: "read", input: { path: "a" } }, { name: "read", input: { path: "a" } }])).toBe("Read 1 file")
    expect(summarizeTools([{ name: "grep", input: { pattern: "x" } }])).toBe("Searched 1 pattern")
    expect(summarizeTools([])).toBe("")
  })
})

describe("compactionLabel", () => {
  test("reflects the compaction lifecycle, not just its existence", () => {
    expect(compactionLabel({ status: "running" })).toBe("Compacting context…")
    expect(compactionLabel({ status: "completed" })).toBe("Context compacted")
    expect(compactionLabel({ status: "failed" })).toBe("Compaction failed")
    expect(compactionLabel({})).toBe("Context compacted")
  })
})

describe("tool labels", () => {
  test("present tense for cards", () => {
    expect(describeTool("read", { path: "/x/web/sessions.ts" })).toBe("Reading sessions.ts…")
    expect(describeTool("grep", { pattern: "labelState" })).toBe("Searching for labelState…")
    expect(describeTool("shell", { command: "git status\nls" })).toBe("Running git status…")
    expect(describeTool("subagent", { description: "Running Chrome for Testing" })).toBe("Running Chrome for Testing…")
    expect(describeTool("mcp.some_tool")).toBe("Calling some_tool…")
  })

  test("past tense rows", () => {
    expect(toolRow("read", { path: "web/a.ts" })).toEqual(["Read", "web/a.ts"])
    expect(toolRow("shell", { command: "bun test" })).toEqual(["Ran", "bun test"])
  })

  test("handles non-string inputs, CRLF commands, and non-array tool output safely", () => {
    expect(basename(123 as unknown as string)).toBe("123")
    expect(describeTool("read", { path: 42 as unknown as string })).toBe("Reading 42…")
    expect(describeTool("shell", { command: "\r\ngit status\r\necho ok" })).toBe("Running git status…")
    expect(toolRow("shell", { command: "bun test\r\necho ok" })).toEqual(["Ran", "bun test"])
    expect(describeTool("webfetch", { url: 99 as unknown as string })).toBe("Fetching a page…")
    expect(truncate("abcdef", 0)).toBe("")
    expect(truncate("abcdef", 1)).toBe("…")
    expect(toolOutput({ status: "completed", content: "unexpected" as unknown as [] })).toBe("")
  })
})

describe("basename", () => {
  test("handles unix and windows separators", () => {
    expect(basename("/code/app")).toBe("app")
    expect(basename("/code/app/")).toBe("app")
    expect(basename("C:\\Users\\torre\\clones\\hermesworld")).toBe("hermesworld")
    expect(basename("C:\\Users\\torre\\clones\\hermesworld\\")).toBe("hermesworld")
    expect(basename("/")).toBe("/")
    expect(basename(undefined)).toBe("")
  })
})

describe("timeAgo", () => {
  const now = 1_800_000_000_000
  test("buckets", () => {
    expect(timeAgo(now - 10_000, now)).toBe("Just now")
    expect(timeAgo(now - 10 * 60_000, now)).toBe("10 min ago")
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 hr ago")
    expect(timeAgo(now - 30 * 3600_000, now)).toBe("Yesterday")
  })
})

describe("matchesQuery", () => {
  test("all terms, any field, case-insensitive", () => {
    expect(matchesQuery("open canvas", "OpenCode sessions as an infinite canvas")).toBe(true)
    expect(matchesQuery("open slack", "OpenCode", "canvas")).toBe(false)
    expect(matchesQuery("  ", "anything")).toBe(true)
  })
})

describe("markdown", () => {
  test("escapes HTML", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img")
  })

  test("only http(s) links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href")
    expect(renderMarkdown("[docs](https://opencode.ai)")).toContain('href="https://opencode.ai"')
  })

  test("blocks", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n```ts\nconst a = 1 < 2\n```\n\nSome **bold** and `code`.")
    expect(html).toContain("<h3>Title</h3>")
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>")
    expect(html).toContain("const a = 1 &lt; 2")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
  })

  test("tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")
    expect(html).toContain("<th>a</th>")
    expect(html).toContain("<td>2</td>")
  })

  test("preview keeps the latest prose and bullets", () => {
    expect(previewBlocks("Intro\n\n- a\n- b")).toEqual({ text: "Intro", bullets: ["a", "b"] })
    expect(previewBlocks("- old\n\nNew **prose** here")).toEqual({ text: "New prose here", bullets: [] })
  })
})

describe("buildPreview", () => {
  const user = (id: string, text: string): Message => ({ type: "user", id, time: { created: 0 }, text })
  const assistant = (id: string, text: string): Message => ({
    type: "assistant",
    id,
    time: { created: 0 },
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: text ? [{ type: "text", text }] : [{ type: "tool", id: "c", name: "read", state: { status: "completed" }, time: { created: 0 } }],
  })

  test("newest assistant text wins; unanswered user message is pending", () => {
    const p = buildPreview([user("u2", "why zero growth?"), assistant("a1", "Done.")])
    expect(p.text).toBe("Done.")
    expect(p.pendingUser).toBe("why zero growth?")
  })

  test("a tool-only reply still counts as an answer", () => {
    const p = buildPreview([assistant("a2", ""), user("u1", "old"), assistant("a1", "Earlier text")])
    expect(p.pendingUser).toBeUndefined()
    expect(p.text).toBe("Earlier text")
  })
})
