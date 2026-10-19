import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { authHeader, resolveUpstream } from "../src/server/upstream"

// resolveUpstream reads these from the environment when options are absent.
const KEYS = ["OPENCODE_SERVER_URL", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("upstream resolution", () => {
  test("explicit options win over the environment and normalize the URL", async () => {
    process.env.OPENCODE_SERVER_URL = "http://env-host:1234"
    process.env.OPENCODE_SERVER_USERNAME = "env-user"
    process.env.OPENCODE_SERVER_PASSWORD = "obviously-fake-env-pass"
    const up = await resolveUpstream({ server: "http://opt-host:9999/", username: "opt-user", password: "obviously-fake-opt-pass" })
    expect(up).toEqual({ url: "http://opt-host:9999", username: "opt-user", password: "obviously-fake-opt-pass", source: "explicit" })
  })

  test("falls back to the environment and defaults the username", async () => {
    process.env.OPENCODE_SERVER_URL = "http://env-host:1234/"
    process.env.OPENCODE_SERVER_PASSWORD = "obviously-fake-env-pass"
    const up = await resolveUpstream()
    expect(up).toEqual({ url: "http://env-host:1234", username: "opencode", password: "obviously-fake-env-pass", source: "explicit" })
  })

  test("an explicit server without credentials is allowed but yields no auth header", async () => {
    const up = await resolveUpstream({ server: "http://host:1234" })
    expect(up.password).toBeUndefined()
    expect(authHeader(up)).toBeUndefined()
  })

  test("rejects a server URL with embedded credentials", async () => {
    await expect(resolveUpstream({ server: "http://user:pass@host:1234" })).rejects.toThrow("without embedded credentials")
  })
})

describe("authHeader", () => {
  test("encodes basic auth only when a password is present", () => {
    expect(authHeader({ url: "http://h", username: "opencode", source: "explicit" })).toBeUndefined()
    expect(authHeader({ url: "http://h", username: "opencode", password: "pw", source: "explicit" }))
      .toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
  })
})
