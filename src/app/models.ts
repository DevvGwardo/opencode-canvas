// Model choice: the canvas remembers the last model you picked and uses it
// for sessions it creates. Unset means OpenCode's own configured default.

import type { Backend, ModelOption } from "./backend"
import type { ModelRef, Session } from "./types"

const KEY = "occ.model"

export function defaultModel(): ModelRef | undefined {
  try {
    const v = localStorage.getItem(KEY)
    if (!v) return undefined
    // Read the old provider/model string as well as the variant-aware format.
    if (!v.startsWith("{")) {
      const i = v.indexOf("/")
      return i > 0 ? { providerID: v.slice(0, i), id: v.slice(i + 1) } : undefined
    }
    const m = JSON.parse(v)
    if (typeof m?.providerID !== "string" || !m.providerID || typeof m.id !== "string" || !m.id) return undefined
    return { providerID: m.providerID, id: m.id, ...(typeof m.variant === "string" && m.variant ? { variant: m.variant } : {}) }
  } catch {
    return undefined
  }
}

export function setDefaultModel(m: ModelRef | undefined) {
  try {
    if (m) localStorage.setItem(KEY, JSON.stringify(m))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}

export const modelLabel = (m?: ModelRef | null) => (m?.id ? m.id : "Default model")

export const effortLabel = (variant?: string) => variant ? variant.replace(/[-_]/g, " ") : "Default effort"
export const modelKey = (m?: ModelRef | null) => m ? `${m.providerID}/${m.id}` : ""

export function modelRef(m: ModelOption, previous?: ModelRef | null): ModelRef {
  const variant = previous?.variant && m.variants?.includes(previous.variant) ? previous.variant : undefined
  return { id: m.id, providerID: m.providerID, ...(variant ? { variant } : {}) }
}

// Separate live/demo backends and project-specific provider configurations.
const cache = new WeakMap<Backend, Map<string, { value: Promise<ModelOption[]>; expires: number }>>()

export function models(backend: Backend, directory?: string): Promise<ModelOption[]> {
  let entries = cache.get(backend)
  if (!entries) cache.set(backend, entries = new Map())
  const key = directory ?? ""
  const cached = entries.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const value = backend.listModels(directory).then((all) => {
    // OpenCode can briefly return an empty snapshot while plugins settle.
    if (!all.length) entries!.delete(key)
    return all
  }).catch((e) => {
    entries!.delete(key)
    throw e
  })
  entries.set(key, { value, expires: Date.now() + 60_000 })
  return value
}

export function serverDefault(backend: Backend, directory?: string): Promise<ModelOption | undefined> {
  return backend.serverDefaultModel(directory).catch(() => undefined)
}

export async function sessionModelOption(backend: Backend, session: Session): Promise<ModelOption | undefined> {
  if (!session.model) return serverDefault(backend, session.location.directory)
  return (await models(backend, session.location.directory)).find((m) => modelKey(m) === modelKey(session.model))
}

export async function setSessionEffort(backend: Backend, session: Session, variant: string) {
  const option = await sessionModelOption(backend, session)
  if (!option) throw new Error("The session model is unavailable. Choose a model first.")
  if (variant !== "default" && !option.variants?.includes(variant)) {
    throw new Error(`Unsupported effort "${variant}". Available: default${option.variants?.length ? ", " + option.variants.join(", ") : ""}`)
  }
  const model: ModelRef = { id: option.id, providerID: option.providerID, ...(variant === "default" ? {} : { variant }) }
  await backend.switchModel(session.id, model)
  session.model = model
  setDefaultModel(model)
}
