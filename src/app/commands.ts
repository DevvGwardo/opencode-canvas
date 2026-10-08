// Native OpenCode commands plus a few Canvas controls, shared by both composers.

import type { Backend, CommandOption } from "./backend"
import type { Delivery } from "./types"

export const CANVAS_COMMANDS: CommandOption[] = [
  { name: "help", description: "Show available slash commands" },
  { name: "model", description: "Choose the session model" },
  { name: "effort", description: "Choose model effort, or /effort high" },
  { name: "compact", description: "Compact the session context" },
  { name: "stop", description: "Interrupt this session" },
  { name: "browser", description: "Open the browser, optionally with a URL" },
]

let menuID = 0

export async function runCanvasCommand(
  text: string,
  handlers: {
    help(): unknown
    model(): unknown
    effort(variant?: string): unknown
    compact(): unknown
    stop(): unknown
    browser(url?: string): unknown
  },
): Promise<boolean> {
  const command = parseCommand(text)
  if (!command || !CANVAS_COMMANDS.some((c) => c.name === command.name)) return false
  const name = command.name as keyof typeof handlers
  if (command.text && name !== "effort" && name !== "browser") throw new Error(`/${name} doesn't take arguments`)
  await handlers[name](command.text || undefined)
  return true
}

export function parseCommand(text: string): { name: string; text: string } | undefined {
  const match = text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  return match ? { name: match[1], text: match[2] ?? "" } : undefined
}

export function commandMatches(commands: CommandOption[], value: string): CommandOption[] {
  const match = value.match(/^\/([^\s/]*)$/)
  if (!match) return []
  const query = match[1].toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 30)
}

export async function sendPrompt(
  backend: Backend,
  id: string,
  text: string,
  delivery?: Delivery,
  files?: Array<{ uri: string; name?: string }>,
) {
  const command = parseCommand(text)
  if (command) await backend.command(id, { ...command, delivery, files })
  else await backend.prompt(id, { text, delivery, files })
}

export class SlashCommands {
  private el: HTMLElement
  private options: CommandOption[] = []
  private commands = [...CANVAS_COMMANDS]
  private active = 0
  private directory?: string
  private seq = 0
  private dismissed = false

  constructor(private input: HTMLTextAreaElement, host: HTMLElement, private backend: Backend) {
    this.el = document.createElement("div")
    this.el.className = "slash-menu"
    this.el.hidden = true
    this.el.setAttribute("role", "listbox")
    this.el.setAttribute("aria-label", "Slash commands")
    this.el.id = `slash-${++menuID}`
    input.setAttribute("aria-controls", this.el.id)
    input.setAttribute("aria-expanded", "false")
    host.append(this.el)
    input.addEventListener("input", () => {
      this.dismissed = false
      this.update()
    })
    input.addEventListener("focus", () => void this.load())
    input.addEventListener("blur", () => this.close())
  }

  setDirectory(directory: string) {
    if (directory === this.directory) return
    this.directory = directory
    this.commands = [...CANVAS_COMMANDS]
    this.seq++
    this.close()
    void this.load()
  }

  private async load() {
    const seq = ++this.seq
    try {
      const native = await this.backend.listCommands(this.directory)
      if (seq !== this.seq) return
      const local = new Set(CANVAS_COMMANDS.map((c) => c.name))
      this.commands = [...CANVAS_COMMANDS, ...native.filter((c) => !local.has(c.name))]
      this.update()
    } catch {
      // Canvas controls remain available if the OpenCode registry is unavailable.
    }
  }

  open() {
    this.input.value = "/"
    this.dismissed = false
    this.input.focus()
    this.update()
  }

  close() {
    this.el.hidden = true
    this.input.setAttribute("aria-expanded", "false")
    this.input.removeAttribute("aria-activedescendant")
  }

  update() {
    this.options = commandMatches(this.commands, this.input.value)
    this.active = 0
    if (this.dismissed || !this.options.length || document.activeElement !== this.input) return this.close()
    this.draw()
  }

  private draw() {
    this.el.hidden = false
    this.input.setAttribute("aria-expanded", "true")
    this.el.replaceChildren(...this.options.map((command, i) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = `slash-option${i === this.active ? " active" : ""}`
      button.id = `${this.el.id}-${i}`
      button.setAttribute("role", "option")
      button.setAttribute("aria-selected", String(i === this.active))
      const label = document.createElement("strong")
      label.textContent = `/${command.name}`
      const description = document.createElement("span")
      description.textContent = command.description ?? "OpenCode command"
      button.append(label, description)
      button.addEventListener("pointerdown", (e) => e.preventDefault())
      button.addEventListener("click", () => this.choose(i))
      return button
    }))
    this.input.setAttribute("aria-activedescendant", `${this.el.id}-${this.active}`)
    this.el.children[this.active]?.scrollIntoView({ block: "nearest" })
  }

  private choose(index: number) {
    this.input.value = `/${this.options[index].name} `
    this.dismissed = true
    this.close()
    this.input.focus()
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.isComposing || this.el.hidden) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.options.length) % this.options.length
      this.draw()
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      this.dismissed = true
      this.close()
      return true
    }
    if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !this.commands.some((c) => this.input.value === `/${c.name}`))) {
      e.preventDefault()
      this.choose(this.active)
      return true
    }
    return false
  }
}
