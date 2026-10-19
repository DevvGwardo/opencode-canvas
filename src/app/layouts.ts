// Pure layout functions: groups of cards in, world-space placements out.

import type { Rect } from "./camera"

export type LayoutName = "satellites" | "fold" | "tabs" | "tree" | "agents"
export const LAYOUTS: LayoutName[] = ["satellites", "fold", "tabs", "tree", "agents"]

export const CARD_W = 300
export const NEW_CARD_H = 104
const GAP = 14
const GROUP_GAP_X = 64
const GROUP_GAP_Y = 72
const LABEL_H = 34

export interface LayoutItem {
  id: string
  kind: "session" | "new"
  h: number
  updated: number
  parent?: string // subagent sessions: the session that started it (agents layout only)
  cost?: number
}

export interface LayoutGroup {
  key: string
  label: string
  items: LayoutItem[] // sessions newest first; a trailing "new" item
}

export interface Placement {
  x: number // top-left of the unscaled card
  y: number
  w: number
  h: number
  scale: number
  rot: number
  z: number
  opacity: number
  interactive: boolean
}

export interface LabelPlacement {
  key: string
  text: string
  sub?: string
  x: number
  y: number
  w: number
  opacity: number
}

/** A connector from a parent agent to one child, as an SVG path. */
export interface LinkPlacement {
  from: string
  to: string
  d: string
  dot: [number, number] // anchor on the parent's edge
}

export interface LayoutResult {
  cards: Map<string, Placement>
  labels: LabelPlacement[]
  links: LinkPlacement[]
  groups: Map<string, Rect>
  bounds: Rect
}

export interface LayoutOptions {
  expanded?: string // fold: the opened stack
  query?: (id: string) => boolean // search filter; when set, results get a flat grid
  aspect?: number // viewport width / height; rows wrap so the whole map matches it
  resultLabel?: (count: number) => string // heading for the filtered grid
  collapsed?: Set<string> // agents: sessions whose subagents are folded away
}

interface Block {
  key: string
  w: number
  h: number
  place(ox: number, oy: number, out: LayoutResult): void
}

const card = (x: number, y: number, h: number, extra: Partial<Placement> = {}): Placement => ({
  x,
  y,
  w: CARD_W,
  h,
  scale: 1,
  rot: 0,
  z: 1,
  opacity: 1,
  interactive: true,
  ...extra,
})

function label(out: LayoutResult, key: string, text: string, x: number, y: number, w: number, sub?: string) {
  out.labels.push({ key, text, sub, x, y, w, opacity: 1 })
}

/** Row width that makes the packed map roughly match the screen's shape. */
function balancedWidth(blocks: Block[], aspect: number, min: number) {
  let area = 0
  let widest = 0
  for (const b of blocks) {
    area += (b.w + GROUP_GAP_X) * (b.h + GROUP_GAP_Y)
    widest = Math.max(widest, b.w)
  }
  return Math.max(widest, min, Math.sqrt(area * aspect) * 1.08)
}

/** Rows of blocks, wrapping at rowWidth; each row as tall as its tallest block. */
function shelf(blocks: Block[], aspect: number, min: number, out: LayoutResult) {
  const rowWidth = balancedWidth(blocks, aspect, min)
  let x = 0
  let y = 0
  let rowH = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0
      y += rowH + GROUP_GAP_Y
      rowH = 0
    }
    b.place(x, y, out)
    out.groups.set(b.key, { x, y, w: b.w, h: b.h })
    x += b.w + GROUP_GAP_X
    rowH = Math.max(rowH, b.h)
  }
}

function columnsBlock(g: LayoutGroup, cols: number, rowMajor: boolean): Block {
  const items = g.items
  const colH = new Array(cols).fill(0)
  const pos: Array<{ id: string; c: number; y: number; h: number }> = []
  if (rowMajor) {
    // Grid: rows share a top edge so the reading order stays left-to-right.
    let y = 0
    for (let r = 0; r * cols < items.length; r++) {
      const row = items.slice(r * cols, r * cols + cols)
      row.forEach((it, c) => pos.push({ id: it.id, c, y, h: it.h }))
      y += Math.max(...row.map((it) => it.h)) + GAP
    }
    colH.fill(y)
  } else {
    const per = Math.ceil(items.length / cols)
    items.forEach((it, i) => {
      const c = Math.floor(i / per)
      pos.push({ id: it.id, c, y: colH[c], h: it.h })
      colH[c] += it.h + GAP
    })
  }
  const w = cols * CARD_W + (cols - 1) * GAP
  const h = LABEL_H + Math.max(0, ...colH) - GAP
  return {
    key: g.key,
    w,
    h,
    place(ox, oy, out) {
      label(out, g.key, g.label, ox, oy, w, countLabel(g))
      for (const p of pos) out.cards.set(p.id, card(ox + p.c * (CARD_W + GAP), oy + LABEL_H + p.y, p.h))
    },
  }
}

function countLabel(g: LayoutGroup) {
  const n = g.items.filter((i) => i.kind === "session").length
  return `${n} session${n === 1 ? "" : "s"}`
}

// ---- layouts ----------------------------------------------------------------

function tree(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  // Each project is a column; long projects spill into extra columns of ~6.
  const blocks = groups.map((g) => columnsBlock(g, Math.max(1, Math.ceil(g.items.length / 6)), false))
  shelf(blocks, o.aspect ?? 1.6, 1600, out)
}

function tabs(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  const blocks = groups.map((g) => columnsBlock(g, Math.min(3, g.items.length), true))
  shelf(blocks, o.aspect ?? 1.6, 2000, out)
}

const PILE_DEPTH = 4

function pileBlock(g: LayoutGroup): Block {
  const sessions = g.items.filter((i) => i.kind === "session")
  const top = sessions[0] ?? g.items[0]
  const h = LABEL_H + top.h + PILE_DEPTH * 7 + 8
  return {
    key: g.key,
    w: CARD_W,
    h,
    place(ox, oy, out) {
      label(out, g.key, g.label, ox, oy, CARD_W, countLabel(g))
      const baseY = oy + LABEL_H + PILE_DEPTH * 7
      g.items.forEach((it, i) => {
        const isNew = it.kind === "new"
        const d = isNew ? PILE_DEPTH : Math.min(i, PILE_DEPTH)
        const sign = i % 2 ? 1 : -1
        out.cards.set(
          it.id,
          card(ox, baseY - d * 7, isNew ? top.h : it.h, {
            scale: 1 - d * 0.035,
            rot: i === 0 ? 0 : sign * Math.min(d, 3) * 0.9,
            z: 100 - i,
            opacity: isNew || i > PILE_DEPTH ? 0 : 1 - d * 0.17,
            // The whole pile opens as one target.
            interactive: i === 0,
          }),
        )
      })
    },
  }
}

function fold(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  const blocks = groups.map((g) =>
    g.key === o.expanded ? columnsBlock(g, Math.min(3, g.items.length), true) : pileBlock(g),
  )
  shelf(blocks, o.aspect ?? 1.6, 1600, out)
}

const SAT_SCALE = 0.56

function satellitesBlock(g: LayoutGroup): Block {
  const sessions = g.items.filter((i) => i.kind === "session")
  const hub = sessions[0]
  const rest = sessions.slice(1)
  const rings: LayoutItem[][] = []
  let radius = 330
  const radii: number[] = []
  let i = 0
  while (i < rest.length) {
    const cap = Math.max(6, Math.floor((2 * Math.PI * radius) / (CARD_W * SAT_SCALE + 26)))
    rings.push(rest.slice(i, i + cap))
    radii.push(radius)
    i += cap
    radius += 250
  }
  const outer = radii.length ? radii[radii.length - 1] : 0
  const halfW = outer + (CARD_W * SAT_SCALE) / 2 + 20
  const halfH = outer * 0.86 + 130
  const size = { w: Math.max(CARD_W + 40, halfW * 2), h: Math.max((hub?.h ?? 200) + 60, halfH * 2) + LABEL_H }
  return {
    key: g.key,
    w: size.w,
    h: size.h,
    place(ox, oy, out) {
      const cx = ox + size.w / 2
      const cy = oy + LABEL_H + (size.h - LABEL_H) / 2
      if (hub) {
        out.cards.set(hub.id, card(cx - CARD_W / 2, cy - hub.h / 2, hub.h, { z: 50 }))
        label(out, g.key, g.label, cx - CARD_W / 2, cy - hub.h / 2 - LABEL_H, CARD_W, countLabel(g))
      }
      rings.forEach((ring, r) => {
        const R = radii[r]
        ring.forEach((it, k) => {
          // Ellipse a little flatter than a circle: screens are wide.
          const a = -Math.PI / 2 + (k / ring.length) * Math.PI * 2 + r * 0.35
          const x = cx + Math.cos(a) * R
          const y = cy + Math.sin(a) * R * 0.86
          out.cards.set(it.id, card(x - CARD_W / 2, y - it.h / 2, it.h, { scale: SAT_SCALE, z: 10 - r }))
        })
      })
      for (const it of g.items)
        if (it.kind === "new")
          out.cards.set(it.id, card(cx - CARD_W / 2, cy - NEW_CARD_H / 2, NEW_CARD_H, { opacity: 0, scale: 0.6, interactive: false, z: 0 }))
    },
  }
}

function satellites(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  shelf(groups.map(satellitesBlock), o.aspect ?? 1.6, 2400, out)
}

// ---- agents: who started whom --------------------------------------------------

const DROP = 52 // parent bottom to the children's top edge
const KID_GAP = 20
const INDENT = 28
const STACK_GAP = 12
const CORNER = 8
const ELBOW_Y = 24 // where a stacked child's connector meets its left edge

function agentsBlock(g: LayoutGroup, collapsed?: Set<string>): Block {
  const kids = new Map<string, LayoutItem[]>()
  for (const it of g.items)
    if (it.parent) {
      if (!kids.has(it.parent)) kids.set(it.parent, [])
      kids.get(it.parent)!.push(it)
    }
  const open = (id: string) => !collapsed?.has(id) && !!kids.get(id)?.length
  const roots = g.items.filter((i) => !i.parent && i.kind === "session")
  const trees = roots.filter((r) => kids.has(r.id))
  // Sessions that never started a subagent pack into columns, like the Tree layout.
  const loose = g.items.filter((i) => !i.parent && !kids.has(i.id))

  const stackSize = (it: LayoutItem): { w: number; h: number } => {
    let w = CARD_W
    let h = it.h
    if (open(it.id))
      for (const k of kids.get(it.id)!) {
        const s = stackSize(k)
        w = Math.max(w, INDENT + s.w)
        h += STACK_GAP + s.h
      }
    return { w, h }
  }
  const treeSize = (r: LayoutItem) => {
    if (!open(r.id)) return { w: CARD_W, h: r.h }
    const sizes = kids.get(r.id)!.map(stackSize)
    const row = sizes.reduce((a, s) => a + s.w, 0) + (sizes.length - 1) * KID_GAP
    return { w: Math.max(CARD_W, row), h: r.h + DROP + Math.max(...sizes.map((s) => s.h)) }
  }

  const units: Array<{ w: number; h: number; place(x: number, y: number, out: LayoutResult): void }> = []
  for (const r of trees) {
    const size = treeSize(r)
    units.push({ ...size, place: (x, y, out) => placeTree(r, x, y, size.w, out) })
  }
  const per = 6
  const cols = Math.max(1, Math.ceil(loose.length / per))
  if (loose.length) {
    const colH = new Array(cols).fill(0)
    const pos = loose.map((it, i) => {
      const c = Math.floor(i / per)
      const p = { it, c, y: colH[c] }
      colH[c] += it.h + GAP
      return p
    })
    units.push({
      w: cols * CARD_W + (cols - 1) * GAP,
      h: Math.max(...colH) - GAP,
      place: (x, y, out) => {
        for (const p of pos) out.cards.set(p.it.id, card(x + p.c * (CARD_W + GAP), y + p.y, p.it.h))
      },
    })
  }

  function hide(it: LayoutItem, at: Placement, out: LayoutResult) {
    out.cards.set(it.id, { ...at, h: it.h, scale: 0.9, opacity: 0, interactive: false, z: 0 })
    for (const k of kids.get(it.id) ?? []) hide(k, at, out)
  }

  function placeKids(it: LayoutItem, at: Placement, out: LayoutResult, place: (k: LayoutItem) => void) {
    if (open(it.id)) for (const k of kids.get(it.id)!) place(k)
    else for (const k of kids.get(it.id) ?? []) hide(k, at, out)
  }

  /** A child with its own descendants stacked underneath, indented. */
  function placeStack(it: LayoutItem, x: number, y: number, out: LayoutResult): number {
    const me = card(x, y, it.h)
    out.cards.set(it.id, me)
    let cy = y + it.h
    const lx = x + INDENT / 2
    placeKids(it, me, out, (k) => {
      cy += STACK_GAP
      const ky = cy + Math.min(ELBOW_Y, k.h / 2)
      out.links.push({
        from: it.id,
        to: k.id,
        dot: [lx, y + it.h],
        d: `M${lx} ${y + it.h}V${ky - CORNER}Q${lx} ${ky} ${lx + CORNER} ${ky}H${x + INDENT}`,
      })
      cy = placeStack(k, x + INDENT, cy, out)
    })
    return cy
  }

  function placeTree(r: LayoutItem, x: number, y: number, w: number, out: LayoutResult) {
    const rx = x + (w - CARD_W) / 2
    const root = card(rx, y, r.h)
    out.cards.set(r.id, root)
    const px = rx + CARD_W / 2
    const py = y + r.h
    const bus = py + DROP / 2
    const ky = py + DROP
    const sizes = open(r.id) ? kids.get(r.id)!.map(stackSize) : []
    let kx = x + (w - (sizes.reduce((a, s) => a + s.w, 0) + Math.max(0, sizes.length - 1) * KID_GAP)) / 2
    let i = 0
    placeKids(r, root, out, (k) => {
      const cx = kx + CARD_W / 2
      const dx = Math.sign(cx - px)
      const c = Math.min(CORNER, Math.abs(cx - px))
      out.links.push({
        from: r.id,
        to: k.id,
        dot: [px, py],
        d: dx
          ? `M${px} ${py}V${bus - c}Q${px} ${bus} ${px + dx * c} ${bus}H${cx - dx * c}Q${cx} ${bus} ${cx} ${bus + c}V${ky}`
          : `M${px} ${py}V${ky}`,
      })
      placeStack(k, kx, ky, out)
      kx += sizes[i++].w + KID_GAP
    })
  }

  // Wrap units into rows so a busy project doesn't become one endless strip.
  const rowWidth = Math.max(2400, ...units.map((u) => u.w))
  const spots: Array<{ x: number; y: number }> = []
  let ux = 0
  let uy = LABEL_H
  let rowH = 0
  let w = 0
  for (const u of units) {
    if (ux > 0 && ux + u.w > rowWidth) {
      ux = 0
      uy += rowH + GROUP_GAP_Y
      rowH = 0
    }
    spots.push({ x: ux, y: uy })
    w = Math.max(w, ux + u.w)
    ux += u.w + GROUP_GAP_X
    rowH = Math.max(rowH, u.h)
  }
  const h = uy + rowH
  const agents = g.items.filter((i) => i.kind === "session")
  const cost = agents.reduce((a, i) => a + (i.cost ?? 0), 0)
  const sub = `${agents.length} agent${agents.length === 1 ? "" : "s"}${cost > 0 ? ` · ${formatCost(cost)}` : ""}`
  return {
    key: g.key,
    w,
    h,
    place(ox, oy, out) {
      label(out, g.key, g.label, ox, oy, Math.max(w, CARD_W), sub)
      units.forEach((u, i) => u.place(ox + spots[i].x, oy + spots[i].y, out))
    },
  }
}

export function formatCost(usd: number) {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function agents(groups: LayoutGroup[], o: LayoutOptions, out: LayoutResult) {
  shelf(groups.map((g) => agentsBlock(g, o.collapsed)), o.aspect ?? 1.6, 2400, out)
}

function searchGrid(groups: LayoutGroup[], previous: LayoutResult | undefined, o: LayoutOptions, out: LayoutResult) {
  const all = groups.flatMap((g) => g.items.filter((i) => i.kind === "session"))
  const hits = all.filter((i) => o.query!(i.id)).sort((a, b) => b.updated - a.updated)
  const cols = Math.max(1, Math.min(4, hits.length))
  const colH = new Array(cols).fill(LABEL_H)
  const heading = o.resultLabel
    ? o.resultLabel(hits.length)
    : hits.length
      ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
      : "No matches"
  label(out, "__search", heading, 0, 0, CARD_W * 2)
  for (const it of hits) {
    let c = 0
    for (let k = 1; k < cols; k++) if (colH[k] < colH[c] - 1) c = k
    out.cards.set(it.id, card(c * (CARD_W + GAP), colH[c], it.h, { z: 5 }))
    colH[c] += it.h + GAP
  }
  // Everything else fades out where it stood.
  for (const g of groups)
    for (const it of g.items) {
      if (out.cards.has(it.id)) continue
      const prev = previous?.cards.get(it.id)
      out.cards.set(
        it.id,
        prev
          ? { ...prev, opacity: 0, scale: prev.scale * 0.92, interactive: false, z: 0 }
          : card(0, 0, it.h, { opacity: 0, scale: 0.9, interactive: false, z: 0 }),
      )
    }
  out.groups.set("__search", { x: 0, y: 0, w: cols * (CARD_W + GAP) - GAP, h: Math.max(...colH) })
}

export function layout(
  name: LayoutName,
  groups: LayoutGroup[],
  opts: LayoutOptions = {},
  previous?: LayoutResult,
): LayoutResult {
  const out: LayoutResult = { cards: new Map(), labels: [], links: [], groups: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } }
  // Only the agents layout shows subagents; everywhere else they tuck in behind their root.
  const tops = name === "agents" && !opts.query ? groups : groups.map((g) => ({ ...g, items: g.items.filter((i) => !i.parent) }))
  if (opts.query) searchGrid(tops, previous, opts, out)
  else if (name === "tree") tree(tops, opts, out)
  else if (name === "tabs") tabs(tops, opts, out)
  else if (name === "fold") fold(tops, opts, out)
  else if (name === "agents") agents(tops, opts, out)
  else satellites(tops, opts, out)
  for (const g of groups) {
    const byId = new Map(g.items.map((i) => [i.id, i]))
    for (const it of g.items) {
      if (out.cards.has(it.id)) continue
      let top = it
      const seen = new Set<string>()
      while (top.parent && byId.has(top.parent) && !seen.has(top.id)) {
        seen.add(top.id)
        top = byId.get(top.parent)!
      }
      const at = out.cards.get(top.id) ?? previous?.cards.get(it.id) ?? card(0, 0, it.h)
      out.cards.set(it.id, { ...at, h: it.h, scale: at.scale * 0.9, opacity: 0, interactive: false, z: 0 })
    }
  }

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const take = (r: Rect) => {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  if (opts.query) out.groups.forEach(take)
  else for (const p of out.cards.values()) if (p.opacity > 0) take(p)
  if (!opts.query) for (const l of out.labels) take({ x: l.x, y: l.y, w: l.w, h: LABEL_H })
  out.bounds = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: CARD_W, h: 200 }
  return out
}
