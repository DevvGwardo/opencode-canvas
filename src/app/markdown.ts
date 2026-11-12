// Small, safe markdown renderer for assistant text. Escapes everything first,
// then re-introduces a fixed set of tags. Links are restricted to http(s).

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function emphasize(s: string): string {
  return s
    .replace(/\*\*(?!\s)((?:[^*\n]|\*(?!\*))+?)(?<!\s)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?!\s)((?:[^_\n]|_(?!_))+?)(?<!\s)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?!\s)((?:[^~\n]|~(?!~))+?)(?<!\s)~~/g, "<del>$1</del>")
}

function inline(src: string): string {
  const slots: string[] = []
  const stash = (html: string) => {
    slots.push(html)
    return `\u0000${slots.length - 1}\u0000`
  }
  let s = src.replace(/\u0000/g, "").replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_, __, c) => stash(`<code>${esc(c)}</code>`))
  s = esc(s)
  const expand = (text: string) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? "")
  // Stash complete <a> tags before emphasis/autolink so href attributes are never rewritten.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()<>]+|\([^\s()<>]*\))+)\)/gi,
    (_, t, u) => stash(`<a href="${u}" target="_blank" rel="noreferrer noopener">${expand(emphasize(t))}</a>`),
  )
  s = s.replace(
    /(^|[\s(]|&(?:quot|lt);)(https?:\/\/(?:(?:(?!&(?:quot|lt|gt);)[^\s()<>])+|\((?:(?!&(?:quot|lt|gt);)[^\s()<>])*\))+)/gi,
    (_, pre, u) => {
      const trimmed = u.replace(/[.,;:!?]+$/, "")
      const tail = u.slice(trimmed.length)
      return `${pre}${stash(`<a href="${trimmed}" target="_blank" rel="noreferrer noopener">${trimmed}</a>`)}${tail}`
    },
  )
  return expand(emphasize(s))
}

const matchFence = (line: string) => line.match(/^\s*(`{3,})([^`]*)$/) ?? line.match(/^\s*(~{3,})(.*)$/)
const isHr = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = matchFence(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2].trim().split(/\s+/)[0] ?? ""
      const closeRe = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !closeRe.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++
      out.push(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(body.join("\n"))}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = Math.min(h[1].length + 2, 6)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }

    if (isHr(line)) {
      out.push("<hr>")
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""))
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`)
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      const head = row(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]))
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      )
      continue
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (m) {
          if (/\d/.test(m[2]) !== ordered) break
          const nested = m[1].length >= 2
          const task = m[3].match(/^\[([ xX])\]\s+(.*)$/)
          const body = task
            ? `<span class="task ${task[1].trim() ? "done" : ""}"></span>${inline(task[2])}`
            : inline(m[3])
          items.push(`<li${nested ? ' class="nested"' : ""}>${body}</li>`)
          i++
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, () => ` ${inline(lines[i].trim())}</li>`)
          i++
        } else break
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !matchFence(lines[i]) &&
      !isHr(lines[i]) &&
      !/^\s*(#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !(/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))
    ) {
      para.push(lines[i++])
    }
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`)
    else {
      out.push(`<p>${inline(line)}</p>`)
      i++
    }
  }
  return out.join("")
}

/** Plain-text preview: markdown syntax stripped, list items kept as bullets. */
export function previewBlocks(src: string): { text: string; bullets: string[] } {
  const lines = src.replace(/\r\n/g, "\n").replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, "").split("\n")
  const text: string[] = []
  const bullets: string[] = []
  for (const raw of lines) {
    const l = raw
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s+/, "")
      .trim()
    if (!l) continue
    const li = l.match(/^([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/)
    if (li) bullets.push(li[2])
    else if (!bullets.length) text.push(l)
    else {
      // Text after a list: start over so the preview shows the latest prose.
      text.length = 0
      text.push(l)
      bullets.length = 0
    }
  }
  return { text: text.join(" "), bullets: bullets.slice(-3) }
}
