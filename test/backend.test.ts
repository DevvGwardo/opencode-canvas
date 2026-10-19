import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { LiveBackend } from "../src/app/backend"

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchSpy?.mockRestore())

function stubFetch(fn: (input: any, init?: RequestInit) => Promise<Response>) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(fn, { preconnect: globalThis.fetch.preconnect }))
}

describe("OpenCode backend", () => {
  test("scopes model and command discovery to the session project", async () => {
    const paths: string[] = []
    stubFetch(async (input: any) => {
      paths.push(String(input))
      return Response.json({ data: [] })
    })
    const backend = new LiveBackend()
    await backend.listModels("/code/a b")
    await backend.listCommands("/code/a b")
    await backend.serverDefaultModel("/code/a b")
    await backend.pendingForms("/code/a b")
    for (const path of paths) {
      const url = new URL(path, "http://localhost")
      expect(url.searchParams.get("location[directory]")).toBe("/code/a b")
    }
  })

  test("normalizes folder paths from the OpenCode location", async () => {
    stubFetch(async () => Response.json({
      data: [
        { type: "directory", path: "opencode-canvas/src/" },
        { type: "directory", path: "/code/empty/" },
        { type: "file", path: "opencode-canvas/README.md" },
      ],
    }))
    expect(await new LiveBackend().listFolders("/code")).toEqual(["src", "empty"])
  })

  test("preserves native command arguments, attachments, and delivery", async () => {
    let body: any
    let path: string | undefined
    stubFetch(async (input: any, init?: RequestInit) => {
      path = String(input)
      body = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    })
    await new LiveBackend().command("ses_test", { name: "review", text: "main", delivery: "queue", files: [{ uri: "data:image/png;base64,AA==" }] })
    expect(path).toBe("/api/session/ses_test/command")
    expect(body).toEqual({ name: "review", text: "main", delivery: "queue", files: [{ uri: "data:image/png;base64,AA==" }] })
  })

  test("stops pagination when an upstream repeats its cursor", async () => {
    let count = 0
    stubFetch(async () => {
      count++
      return Response.json({ data: Array.from({ length: 200 }, (_, i) => ({ id: `ses_${i}` })), cursor: { next: "same" } })
    })
    await new LiveBackend().listSessions(600)
    expect(count).toBe(2)
  })

  test("bounds every proxy request with a timeout so a hung server can't hang the UI", async () => {
    let signal: AbortSignal | undefined
    stubFetch(async (_input: any, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return Response.json({ data: [] })
    })
    await new LiveBackend().listProjects()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })
})
