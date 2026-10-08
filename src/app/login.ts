export async function ensureAccess(root: HTMLElement): Promise<boolean> {
  const res = await fetch("/canvas/auth")
  if (!res.ok) throw new Error(`Canvas access check failed (${res.status})`)
  const status = await res.json() as { required: boolean; authenticated: boolean }
  if (!status.required || status.authenticated) return status.required
  return new Promise((resolve) => {
    const box = document.createElement("form")
    box.className = "empty-state canvas-login"
    const title = document.createElement("h1")
    title.textContent = "Sign in to Canvas"
    const description = document.createElement("p")
    description.textContent = "Use the Canvas password set on your host computer, not your OpenCode provider credentials."
    const input = document.createElement("input")
    input.type = "password"
    input.autocomplete = "current-password"
    input.placeholder = "Canvas password"
    input.setAttribute("aria-label", "Canvas password")
    input.required = true
    const error = document.createElement("p")
    error.className = "login-error"
    error.setAttribute("role", "alert")
    const button = document.createElement("button")
    button.type = "submit"
    button.className = "btn primary"
    button.textContent = "Sign in"
    box.append(title, description, input, error, button)
    root.replaceChildren(box)
    box.addEventListener("submit", async (e) => {
      e.preventDefault()
      button.disabled = true
      error.textContent = ""
      try {
        const login = await fetch("/canvas/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: input.value }),
        })
        input.value = ""
        if (!login.ok) {
          const body = await login.json()
          throw new Error(body.message ?? `Sign in failed (${login.status})`)
        }
        box.remove()
        resolve(true)
      } catch (e) {
        error.textContent = (e as Error).message
        input.focus()
      } finally {
        button.disabled = false
      }
    })
    input.focus()
  })
}
