import { afterEach, describe, expect, test } from "bun:test"
import { modelOption, type Backend } from "../src/app/backend"
import { defaultModel, modelRef, models, setDefaultModel, setSessionEffort } from "../src/app/models"
import type { ModelRef, Session } from "../src/app/types"

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

function storage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  })
  return values
}

describe("model choices", () => {
  test("persists effort and model IDs containing slashes", () => {
    storage()
    const model = { providerID: "openrouter", id: "vendor/model", variant: "high" }
    setDefaultModel(model)
    expect(defaultModel()).toEqual(model)
    setDefaultModel(undefined)
    expect(defaultModel()).toBeUndefined()
  })

  test("reads legacy preferences and ignores malformed preferences", () => {
    const values = storage()
    values.set("occ.model", "openrouter/vendor/model")
    expect(defaultModel()).toEqual({ providerID: "openrouter", id: "vendor/model" })
    values.set("occ.model", '{"providerID":"p","id":42}')
    expect(defaultModel()).toBeUndefined()
    values.set("occ.model", "{bad")
    expect(defaultModel()).toBeUndefined()
  })

  test("uses variant IDs without forwarding provider settings", () => {
    const option = modelOption({
      id: "m", providerID: "p", name: "Model",
      variants: [{ id: "low", settings: { secret: "hidden" } }, { id: "high" }, { id: "high" }],
      headers: { authorization: "hidden" },
    })
    expect(option).toEqual({ id: "m", providerID: "p", name: "Model", variants: ["low", "high"] })
    expect(modelRef(option, { id: "old", providerID: "p", variant: "high" }).variant).toBe("high")
    expect(modelRef(option, { id: "old", providerID: "p", variant: "max" }).variant).toBeUndefined()
  })

  test("keeps model caches separate by backend and project", async () => {
    const calls: Array<string | undefined> = []
    const a = { listModels: async (directory?: string) => {
      calls.push(directory)
      return [{ id: directory ?? "a", providerID: "a", name: "A" }]
    } } as Backend
    const b = { listModels: async () => [{ id: "b", providerID: "b", name: "B" }] } as Backend
    expect((await models(a, "/one"))[0].id).toBe("/one")
    await models(a, "/one")
    expect((await models(a, "/two"))[0].id).toBe("/two")
    expect((await models(b))[0].id).toBe("b")
    expect(calls).toEqual(["/one", "/two"])
  })

  test("does not cache empty plugin snapshots", async () => {
    let count = 0
    const backend = { listModels: async () => ++count === 1 ? [] : [{ id: "m", providerID: "p", name: "M" }] } as Backend
    expect(await models(backend)).toEqual([])
    expect((await models(backend))[0].id).toBe("m")
  })

  test("switches effort only after the server accepts it", async () => {
    storage()
    const session = { id: "ses_test", location: { directory: "/project" }, model: { id: "m", providerID: "p" } } as Session
    let sent: ModelRef | undefined
    let fail = true
    const backend = {
      listModels: async () => [{ id: "m", providerID: "p", name: "M", variants: ["low", "high"] }],
      switchModel: async (_id: string, model: ModelRef) => {
        if (fail) throw new Error("offline")
        sent = model
      },
    } as Backend
    await expect(setSessionEffort(backend, session, "high")).rejects.toThrow("offline")
    expect(session.model?.variant).toBeUndefined()
    await expect(setSessionEffort(backend, session, "max")).rejects.toThrow("Unsupported effort")
    fail = false
    await setSessionEffort(backend, session, "high")
    expect(sent?.variant).toBe("high")
    expect(defaultModel()?.variant).toBe("high")
    await setSessionEffort(backend, session, "default")
    expect(session.model?.variant).toBeUndefined()
  })
})
