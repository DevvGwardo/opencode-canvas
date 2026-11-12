let host: HTMLElement | undefined

export function toast(message: string, ms = 3200) {
  if (!host || !host.isConnected || host.parentElement !== document.body) {
    host = document.body.querySelector<HTMLElement>(".toasts") ?? document.createElement("div")
    host.className = "toasts"
    host.setAttribute("role", "status")
    host.setAttribute("aria-live", "polite")
    host.setAttribute("aria-atomic", "false")
    if (!host.isConnected) document.body.append(host)
  }
  const t = document.createElement("div")
  t.className = "toast"
  t.textContent = message
  host.append(t)
  let dismissed = false
  const show = () => {
    if (!dismissed && t.isConnected) t.classList.add("in")
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(show)
  else show()
  const delay = Number.isFinite(ms) ? Math.max(0, ms) : 3200
  setTimeout(() => {
    dismissed = true
    t.classList.remove("in")
    setTimeout(() => t.remove(), 300)
  }, delay)
}
