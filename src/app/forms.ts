import type { FormField, FormInfo } from "./types"

function formValues(fields: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [
    f.key, f.hidden || !Object.hasOwn(values, f.key) ? f.default : values[f.key],
  ]))
}

export function formFieldActive(field: FormField, values: Record<string, unknown>): boolean {
  return (field.when ?? []).every((when) => when.op === "eq"
    ? values[when.key] === when.value
    : values[when.key] !== when.value,
  )
}

function validFormat(value: string, format?: FormField["format"]): boolean {
  if (!format) return true
  if (format === "email") return /^[^\s@]+@[^\s@]+$/.test(value)
  if (format === "uri") {
    try { new URL(value); return true } catch { return false }
  }
  if (format === "date") {
    const date = new Date(`${value}T00:00:00Z`)
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && validFormat(value.slice(0, 10), "date") && Number.isFinite(Date.parse(value))
}

/** Keep false/zero and hidden defaults; never submit an incomplete question. */
export function formAnswer(fields: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  const answer: Record<string, unknown> = Object.create(null)
  const candidates = formValues(fields, values)
  for (const f of fields) {
    if (!formFieldActive(f, candidates)) continue
    if (f.type === "external") {
      throw new Error(`${f.title ?? f.key}: answer this in OpenCode using the external link.`)
    }
    const value = candidates[f.key]
    const v = Array.isArray(value) ? [...new Set(value)] : value
    const missing = v === undefined || v === null || v === "" || (f.required && (
      typeof v === "string" && !v.trim() || Array.isArray(v) && !v.length
    ))
    if (missing) {
      if (f.required && !f.hidden) throw new Error(`${f.title ?? f.key}: an answer is required.`)
      continue
    }
    let valid = false
    switch (f.type) {
      case "string":
        valid = typeof v === "string" && (!f.options?.length || !!f.custom || f.options.some((o) => o.value === v))
        if (valid && typeof v === "string") {
          valid = (f.minLength === undefined || v.length >= f.minLength)
            && (f.maxLength === undefined || v.length <= f.maxLength)
            && validFormat(v, f.format)
          if (valid && f.pattern) {
            try { valid = new RegExp(f.pattern).test(v) } catch { valid = false }
          }
        }
        break
      case "number":
      case "integer":
        valid = typeof v === "number" && Number.isFinite(v) && (f.type !== "integer" || Number.isInteger(v))
          && (f.minimum === undefined || v >= f.minimum)
          && (f.maximum === undefined || v <= f.maximum)
        break
      case "boolean":
        valid = typeof v === "boolean"
        break
      case "multiselect":
        valid = Array.isArray(v) && v.every((value) =>
          typeof value === "string" && (!!f.custom || f.options?.some((o) => o.value === value)),
        )
          && (f.minItems === undefined || v.length >= f.minItems)
          && (f.maxItems === undefined || v.length <= f.maxItems)
        break
    }
    if (!valid) throw new Error(`${f.title ?? f.key}: invalid answer.`)
    answer[f.key] = v
  }
  return answer
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const el = document.createElement(tag)
  el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

let fieldID = 0

export function questionForm(
  form: FormInfo,
  reply: (answer: Record<string, unknown>) => Promise<void>,
  dismiss: () => Promise<void>,
): HTMLFormElement {
  const body = h("form", "body ask-form")
  body.append(h("div", "ask-title", form.title))
  const getters: Array<[string, () => unknown]> = []
  const fieldsets: Array<[FormField, HTMLFieldSetElement]> = []
  for (const f of form.fields) {
    if (f.hidden) continue
    const field = h("fieldset", "field")
    const title = f.title ?? f.key
    field.append(h("legend", "field-title", title + (f.required ? " (required)" : "")))
    if (f.description) field.append(h("div", "field-desc", f.description))
    if (f.type === "boolean") {
      const label = h("label", "opt")
      const cb = h("input")
      cb.type = "checkbox"
      cb.checked = f.default === true
      label.append(cb, document.createTextNode(title))
      field.append(label)
      getters.push([f.key, () => cb.checked])
    } else if (f.type === "multiselect" || f.type === "string" && f.options?.length) {
      const multiple = f.type === "multiselect"
      const name = `question-${++fieldID}`
      const boxes: HTMLInputElement[] = []
      for (const o of f.options ?? []) {
        const label = h("label", "opt")
        const cb = h("input")
        cb.type = multiple ? "checkbox" : "radio"
        cb.name = name
        cb.value = o.value
        cb.checked = multiple ? Array.isArray(f.default) && f.default.includes(o.value) : f.default === o.value
        const text = h("span", "option-text", o.label)
        if (o.description) text.append(h("span", "field-desc", o.description))
        label.append(cb, text)
        boxes.push(cb)
        field.append(label)
      }
      let custom: HTMLInputElement | HTMLTextAreaElement | undefined
      let customRadio: HTMLInputElement | undefined
      if (f.custom) {
        custom = multiple ? h("textarea") : h("input")
        if (custom instanceof HTMLInputElement) custom.type = "text"
        else custom.rows = 2
        custom.placeholder = f.placeholder ?? (multiple ? "One answer per line" : "Your answer")
        custom.setAttribute("aria-label", `${title}: other answer`)
        const label = h("label", "opt")
        if (!multiple) {
          customRadio = h("input")
          customRadio.type = "radio"
          customRadio.name = name
          customRadio.checked = typeof f.default === "string" && !f.options?.some((o) => o.value === f.default)
          custom.value = customRadio.checked ? f.default : ""
          const radio = customRadio
          custom.addEventListener("input", () => { radio.checked = true })
          label.append(customRadio)
        } else if (Array.isArray(f.default)) {
          custom.value = f.default.filter((v) => !f.options?.some((o) => o.value === v)).join("\n")
        }
        label.append(document.createTextNode(multiple ? "Other (one per line)" : "Other"))
        field.append(label, custom)
      }
      getters.push([f.key, () => multiple
        ? [...boxes.filter((b) => b.checked).map((b) => b.value), ...(custom?.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) ?? [])]
        : customRadio?.checked ? custom?.value : boxes.find((b) => b.checked)?.value,
      ])
    } else if (f.type === "external") {
      field.append(h("span", "dim", "Complete this external action, or answer in OpenCode."))
      try {
        const url = new URL(f.url ?? "")
        if (url.protocol === "http:" || url.protocol === "https:") {
          const link = h("a", "link", "Open external action")
          link.href = url.href
          link.target = "_blank"
          link.rel = "noopener noreferrer"
          field.append(link)
        }
      } catch { /* Never turn an invalid or unsafe external URL into a link. */ }
    } else {
      const numeric = f.type === "number" || f.type === "integer"
      const input = !numeric && !f.format ? h("textarea") : h("input")
      if (input instanceof HTMLInputElement) {
        input.type = numeric ? "number" : f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : "text"
        input.step = f.type === "integer" ? "1" : "any"
        if (Number.isFinite(f.minimum)) input.min = String(f.minimum)
        if (Number.isFinite(f.maximum)) input.max = String(f.maximum)
      } else input.rows = 2
      if (f.minLength !== undefined) input.minLength = f.minLength
      if (f.maxLength !== undefined) input.maxLength = f.maxLength
      input.placeholder = f.placeholder ?? ""
      input.setAttribute("aria-label", title)
      if (f.default !== undefined) input.value = String(f.default)
      input.required = !!f.required
      field.append(input)
      getters.push([f.key, () => numeric ? input.value === "" ? undefined : Number(input.value) : input.value])
    }
    fieldsets.push([f, field])
    body.append(field)
  }
  const error = h("div", "ask-error")
  error.setAttribute("role", "alert")
  error.hidden = true
  const actions = h("div", "ask-actions")
  const submit = h("button", "btn primary", "Answer")
  submit.type = "submit"
  const cancel = h("button", "btn ghost", "Dismiss")
  cancel.type = "button"
  actions.append(submit, cancel)
  body.append(error, actions)
  let busy = false
  let completed = false
  const values = () => Object.fromEntries(getters.map(([key, get]) => [key, get()]))
  const update = () => {
    const candidates = formValues(form.fields, values())
    for (const [field, element] of fieldsets) {
      const active = formFieldActive(field, candidates)
      element.hidden = !active
      element.disabled = busy || completed || !active
    }
    const external = form.fields.some((f) => f.type === "external" && formFieldActive(f, candidates))
    submit.disabled = busy || completed || external
  }
  const act = async (fn: () => Promise<void>) => {
    if (busy || completed) return
    busy = true
    error.hidden = true
    const controls = [...body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button")]
    for (const control of controls) control.disabled = true
    body.setAttribute("aria-busy", "true")
    try {
      await fn()
      completed = true
    } catch (e) {
      error.textContent = (e as Error).message
      error.hidden = false
    } finally {
      busy = false
      body.removeAttribute("aria-busy")
      for (const control of controls) control.disabled = completed
      update()
    }
  }
  body.addEventListener("keydown", (e) => e.stopPropagation())
  body.addEventListener("input", update)
  body.addEventListener("change", update)
  body.addEventListener("submit", (e) => {
    e.preventDefault()
    if (busy || completed || submit.disabled) return
    try {
      const answer = formAnswer(form.fields, values())
      void act(() => reply(answer))
    } catch (e) {
      error.textContent = (e as Error).message
      error.hidden = false
    }
  })
  cancel.addEventListener("click", () => void act(dismiss))
  update()
  return body
}
