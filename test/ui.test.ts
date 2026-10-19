import { expect, test } from "bun:test"
import { BrowserHost, findBrowser } from "../src/server/browser"

const executable = findBrowser()

test.skipIf(!executable)("question and transcript regressions in real Chromium", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("./ui-fixture.ts", import.meta.url).pathname],
    target: "browser",
  })
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"))
  const script = await bundle.outputs[0].text()
  let report!: (value: { passed: number; errors: string[] }) => void
  const result = new Promise<{ passed: number; errors: string[] }>((resolve) => { report = resolve })
  const fixture = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/result" && req.method === "POST") {
        report(await req.json())
        return new Response(null, { status: 204 })
      }
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } })
      return new Response('<!doctype html><html><head><title>Canvas UI regression checks</title></head><body><script type="module" src="/fixture.js"></script></body></html>', {
        headers: { "content-type": "text/html" },
      })
    },
  })
  const browser = new BrowserHost(executable)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await browser.start()
    await browser.action({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` })
    const checks = await Promise.race([
      result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Chromium UI checks timed out")), 15_000) }),
    ])
    expect(checks.errors).toEqual([])
    expect(checks.passed).toBeGreaterThanOrEqual(18)
  } finally {
    clearTimeout(timer)
    await browser.stop()
    fixture.stop(true)
  }
}, 30_000)
