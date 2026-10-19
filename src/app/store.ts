// Client-side model of every session, kept current from the event stream.

import type { Backend, ConnectionState } from "./backend"
import { basename, describeTool, lastAssistantText } from "./format"
import { previewBlocks } from "./markdown"
import type { FormInfo, Message, OcEvent, PermissionDecision, PermissionRequest, PermissionRule, Project, Session } from "./types"

/** The rule that tells OpenCode to allow everything in a session. */
export const ALLOW_ALL: PermissionRule = { action: "*", resource: "*", effect: "allow" }
const isAllowAll = (r: PermissionRule) => r.action === "*" && r.resource === "*" && r.effect === "allow"
const AUTO_KEY = "occ.autoApprove"

export interface Preview {
  text: string
  bullets: string[]
  /** Last user message, shown when the agent hasn't answered it yet. */
  pendingUser?: string
}

export interface Group {
  key: string
  label: string
  directory: string
  sessions: Session[]
  updated: number
}

type Listener = {
  structure?: () => void
  cards?: (ids: Set<string>) => void
  event?: (ev: OcEvent) => void
  connection?: (s: ConnectionState) => void
}

const MAX_SESSIONS = 600
const PREVIEW_CONCURRENCY = 4
/** Finished sessions you haven't opened count as "to review" for this long. */
export const REVIEW_WINDOW = 48 * 3600_000

/**
 * One visual state per session, most urgent first:
 * needs-you > working > failed (unseen) > review > stopped > failed > done
 */
export type Status = "needs-you" | "working" | "review" | "failed" | "stopped" | "done"

export const STATUS_LABEL: Record<Status, string> = {
  "needs-you": "Needs you",
  working: "Working",
  review: "To review",
  failed: "Failed",
  stopped: "Stopped",
  done: "Done",
}

export class Store {
  sessions = new Map<string, Session>()
  projects = new Map<string, Project>()
  children = new Map<string, Set<string>>()
  running = new Set<string>()
  activity = new Map<string, string>()
  previews = new Map<string, Preview>()
  liveText = new Map<string, string>()
  permissions = new Map<string, PermissionRequest[]>()
  forms = new Map<string, FormInfo[]>()
  connection: ConnectionState = "connecting"
  loaded = false
  /** Approve every permission request from every session while the canvas is open. */
  autoApproveAll = (() => {
    try {
      return localStorage.getItem(AUTO_KEY) === "1"
    } catch {
      return false
    }
  })()
  /** Called after the canvas approves something on your behalf. */
  onAutoApproved?: (req: PermissionRequest) => void
  private approving = new Map<string, Promise<void>>()
  private answeringForms = new Map<string, Promise<void>>()
  private askVersions = new Map<string, number>()
  private askSyncs = new Map<string, Promise<void>>()
  private deletedSessions = new Set<string>()
  private pendingAskSync?: Promise<void>
  private pendingFormDiscovery?: Promise<void>
  /** Last session `time.updated` seen per directory, to bound form discovery. */
  private formScanUpdated = new Map<string, number>()

  private listeners = new Set<Listener>()
  private dirtyCards = new Set<string>()
  private structureDirty = false
  /** Set by stop(): after teardown nothing may touch the DOM or fetch again. */
  private stopped = false
  private flushScheduled = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private previewQueue: string[] = []
  private previewQueued = new Set<string>()
  private previewInflight = 0
  private previewStale = new Set<string>()
  private previewRetry = new Map<string, number>()
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubscribe?: () => void
  private pollTimer?: ReturnType<typeof setInterval>

  constructor(public backend: Backend) {}

  on(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  // ---- loading ------------------------------------------------------------

  async start() {
    this.stopped = false
    this.unsubscribe = this.backend.subscribe(
      (ev) => this.onEvent(ev),
      (s) => {
        const wasReconnecting = this.connection === "reconnecting"
        this.connection = this.backend.kind === "demo" ? "demo" : s
        for (const l of this.listeners) l.connection?.(this.connection)
        // Events were missed while disconnected: resync everything. A failed
        // resync is retried by refreshRecent/syncActive.
        if (s === "live" && wasReconnecting) this.reload().catch(() => {})
      },
    )
    await this.reload()
    this.pollTimer = setInterval(() => void this.syncActive(), 15_000)
    // Views from other clients (TUI, desktop) and any missed events.
    this.recentTimer = setInterval(() => void this.refreshRecent(), 45_000)
  }

  private recentTimer?: ReturnType<typeof setInterval>

  private async refreshRecent() {
    try {
      const recent = await this.backend.listSessions(100)
      let structure = false
      for (const fresh of recent) {
        const cur = this.sessions.get(fresh.id)
        if (!cur) {
          if (!fresh.time.archived) {
            this.deletedSessions.delete(fresh.id)
            this.sessions.set(fresh.id, fresh)
            structure = true
          }
          continue
        }
        if (fresh.time.archived) {
          this.removeSession(fresh.id)
          structure = true
          continue
        }
        const changed =
          cur.time.viewed !== fresh.time.viewed ||
          cur.time.idle !== fresh.time.idle ||
          cur.outcome !== fresh.outcome ||
          cur.title !== fresh.title ||
          cur.model?.id !== fresh.model?.id ||
          cur.model?.providerID !== fresh.model?.providerID ||
          cur.model?.variant !== fresh.model?.variant ||
          cur.time.updated !== fresh.time.updated ||
          cur.parentID !== fresh.parentID ||
          cur.projectID !== fresh.projectID ||
          cur.location.directory !== fresh.location.directory ||
          JSON.stringify(cur.permissions) !== JSON.stringify(fresh.permissions)
        if (changed) {
          if (cur.title !== fresh.title || cur.parentID !== fresh.parentID || cur.projectID !== fresh.projectID || cur.location.directory !== fresh.location.directory) structure = true
          this.touchParent(fresh.id)
          this.sessions.set(fresh.id, { ...fresh, time: { ...fresh.time, viewed: Math.max(fresh.time.viewed ?? 0, cur.time.viewed ?? 0) || undefined } })
        }
      }
      if (structure) {
        this.rebuildChildren()
        this.markStructure()
      }
      void this.discoverPendingForms()
    } catch {
      /* transient */
    }
  }

  stop() {
    this.stopped = true
    this.unsubscribe?.()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.recentTimer) clearInterval(this.recentTimer)
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.flushScheduled = false
    // Give up any previews still waiting in the queue. In-flight ones finish,
    // but markStructure/touchCard can no longer schedule a flush (see below).
    this.previewQueue = []
    this.previewQueued.clear()
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
  }

  async reload() {
    const [projects, sessions, active] = await Promise.all([
      this.backend.listProjects().catch(() => [] as Project[]),
      this.backend.listSessions(MAX_SESSIONS),
      this.backend.active().catch(() => this.running),
    ])
    this.projects = new Map(projects.map((p) => [p.id, p]))
    for (const s of sessions) if (s.time.archived) this.removeSession(s.id)
    this.sessions = new Map(sessions.filter((s) => !s.time.archived).map((s) => {
      this.deletedSessions.delete(s.id)
      const viewed = Math.max(s.time.viewed ?? 0, this.sessions.get(s.id)?.time.viewed ?? 0)
      return [s.id, { ...s, time: { ...s.time, viewed: viewed || undefined } }]
    }))
    this.rebuildChildren()
    this.running = active
    // Asks answered elsewhere while we were disconnected would otherwise stay
    // pending here forever, so recheck those as well as running sessions.
    void this.syncPendingAsks()
    void this.discoverPendingForms(true)
    this.previewStale = new Set(this.previews.keys())
    this.loaded = true
    this.markStructure()
  }

  addSessions(list: Session[]) {
    for (const s of list) {
      if (s.time.archived) continue
      this.deletedSessions.delete(s.id)
      this.sessions.set(s.id, s)
    }
    this.rebuildChildren()
    this.markStructure()
  }

  private async syncActive() {
    try {
      const active = await this.backend.active()
      const changed = new Set<string>()
      for (const id of active) if (!this.running.has(id)) changed.add(id)
      for (const id of this.running) if (!active.has(id)) changed.add(id)
      this.running = active
      for (const id of changed) {
        if (!active.has(id)) this.activity.delete(id)
        this.touchParent(id)
      }
    } catch {
      /* transient */
    }
    // A stable running set doesn't mean asks are unchanged. This also retries
    // failed auto-approvals and catches replies missed by the event stream.
    await this.syncPendingAsks()
  }

  private syncPendingAsks(): Promise<void> {
    if (this.pendingAskSync) return this.pendingAskSync
    this.pendingAskSync = (async () => {
      const ids = [...new Set([...this.running, ...this.permissions.keys(), ...this.forms.keys()])]
      // Bound background traffic when many agents are active.
      for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map((id) => this.syncAsks(id)))
    })().finally(() => { this.pendingAskSync = undefined })
    return this.pendingAskSync
  }

  /** Idle sessions can already have questions before this client subscribes. */
  private discoverPendingForms(force = false): Promise<void> {
    if (this.pendingFormDiscovery) return this.pendingFormDiscovery
    this.pendingFormDiscovery = (async () => {
      // Rescan a directory only once per change to its sessions. Without this,
      // every 45s refresh issues one /api/form request per project directory.
      // reload() forces a full sweep so nothing is missed after a reconnect.
      const updatedByDirectory = new Map<string, number>()
      for (const s of this.sessions.values()) {
        const d = s.location.directory
        if (d) updatedByDirectory.set(d, Math.max(updatedByDirectory.get(d) ?? 0, s.time.updated ?? 0))
      }
      const directories = [...new Set([
        ...updatedByDirectory.keys(),
        ...[...this.projects.values()].map((p) => p.canonical),
      ].filter(Boolean))].filter((d) => force || this.formScanUpdated.get(d) !== (updatedByDirectory.get(d) ?? 0))
      for (let i = 0; i < directories.length; i += 4) {
        await Promise.all(directories.slice(i, i + 4).map(async (directory) => {
          const versions = new Map(this.askVersions)
          let forms: FormInfo[]
          try {
            forms = await this.backend.pendingForms(directory)
          } catch {
            // Leave the directory unscanned so a transient failure is retried.
            return
          }
          this.formScanUpdated.set(directory, updatedByDirectory.get(directory) ?? 0)
          for (const form of forms) {
            const id = form.sessionID
            if (this.deletedSessions.has(id) || (versions.get(id) ?? 0) !== (this.askVersions.get(id) ?? 0)) continue
            if (!this.sessions.has(id)) {
              const session = await this.backend.getSession(id).catch(() => undefined)
              if (!session || session.time.archived || this.deletedSessions.has(id)) continue
              this.addSessions([session])
            }
            if ((versions.get(id) ?? 0) !== (this.askVersions.get(id) ?? 0)) continue
            const list = this.forms.get(id) ?? []
            const next = [...list]
            const index = next.findIndex((f) => f.id === form.id)
            if (index < 0) next.push(form)
            else next[index] = form
            if (JSON.stringify(next) === JSON.stringify(list)) continue
            // Merge only. Authoritative per-session reads clear answered forms.
            this.forms.set(id, next)
            this.asksChanged(id)
            versions.set(id, this.askVersions.get(id)!)
          }
        }))
      }
    })().finally(() => { this.pendingFormDiscovery = undefined })
    return this.pendingFormDiscovery
  }

  /** Coalesce readers and never replace newer events with an older snapshot. */
  syncAsks(id: string): Promise<void> {
    if (this.deletedSessions.has(id)) return Promise.resolve()
    const current = this.askSyncs.get(id)
    if (current) return current
    const sync = (async () => {
      while (true) {
        const version = this.askVersions.get(id) ?? 0
        let gone = 0
        const ask = <T>(p: Promise<T[]>): Promise<T[] | undefined> =>
          p.catch((e: unknown) => {
            if ((e as { status?: number } | null)?.status === 404) gone++
            return undefined
          })
        const [perms, forms] = await Promise.all([ask(this.backend.permissions(id)), ask(this.backend.forms(id))])
        if (this.deletedSessions.has(id)) return
        if (version !== (this.askVersions.get(id) ?? 0)) continue
        // Both session-scoped endpoints 404 only when the session itself is
        // gone. Drop its asks: a vanished session must not keep the "Allow
        // all" chip up or re-poll the server every 15s forever.
        if (gone === 2) {
          this.setList(this.permissions, id, [])
          this.setList(this.forms, id, [])
          this.asksChanged(id)
          return
        }
        const changed = perms !== undefined && JSON.stringify(perms) !== JSON.stringify(this.permissions.get(id) ?? [])
          || forms !== undefined && JSON.stringify(forms) !== JSON.stringify(this.forms.get(id) ?? [])
        // An unavailable endpoint must not erase a question or permission.
        if (perms !== undefined) this.setList(this.permissions, id, perms)
        if (forms !== undefined) this.setList(this.forms, id, forms)
        if (changed) this.asksChanged(id)
        this.touchParent(id)
        for (const p of perms ?? []) this.maybeAutoApprove(p)
        return
      }
    })().finally(() => { this.askSyncs.delete(id) })
    this.askSyncs.set(id, sync)
    return sync
  }

  private asksChanged(id: string) {
    this.askVersions.set(id, (this.askVersions.get(id) ?? 0) + 1)
    this.touchParent(id)
  }

  replyForm(form: FormInfo, answer: Record<string, unknown>) {
    return this.resolveForm(form, () => this.backend.replyForm(form.sessionID, form.id, answer))
  }

  cancelForm(form: FormInfo) {
    return this.resolveForm(form, () => this.backend.cancelForm(form.sessionID, form.id))
  }

  private resolveForm(form: FormInfo, fn: () => Promise<void>): Promise<void> {
    const key = `${form.sessionID}/${form.id}`
    const current = this.answeringForms.get(key)
    if (current) return current
    const reply = (async () => {
      await fn()
      this.clearForm(form.sessionID, form.id)
    })().finally(() => { this.answeringForms.delete(key) })
    this.answeringForms.set(key, reply)
    return reply
  }

  private clearForm(id: string, formID: string) {
    this.setList(this.forms, id, (this.forms.get(id) ?? []).filter((f) => f.id !== formID))
    this.asksChanged(id)
  }

  private setList<T>(map: Map<string, T[]>, id: string, list: T[]) {
    if (list.length) map.set(id, list)
    else map.delete(id)
  }

  private rebuildChildren() {
    this.children.clear()
    for (const s of this.sessions.values()) {
      if (!s.parentID) continue
      if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
      this.children.get(s.parentID)!.add(s.id)
    }
  }

  // ---- derived ------------------------------------------------------------

  roots(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.parentID || !this.sessions.has(s.parentID))
  }

  groupKey(s: Session) {
    return s.projectID || s.location.directory
  }

  projectLabel(s: Session): string {
    const p = this.projects.get(s.projectID)
    return p?.name || basename(p?.canonical) || basename(s.location.directory) || "Sessions"
  }

  groups(): Group[] {
    const map = new Map<string, Group>()
    for (const s of this.roots()) {
      const key = this.groupKey(s)
      let g = map.get(key)
      if (!g) {
        g = { key, label: this.projectLabel(s), directory: s.location.directory, sessions: [], updated: 0 }
        map.set(key, g)
      }
      g.sessions.push(s)
      const t = this.isWorking(s.id) ? Date.now() : s.time.updated
      if (t > g.updated) {
        g.updated = t
        g.directory = s.location.directory
      }
    }
    // Things that want you float to the top of each project, then newest first.
    const now = Date.now()
    const rank = (id: string) => {
      const st = this.status(id, now)
      return st === "needs-you" ? 0 : st === "working" ? 1 : st === "review" || (st === "failed" && this.unseen(id)) ? 2 : 3
    }
    for (const g of map.values()) {
      const r = new Map(g.sessions.map((s) => [s.id, rank(s.id)]))
      g.sessions.sort((a, b) => r.get(a.id)! - r.get(b.id)! || b.time.updated - a.time.updated)
    }
    return [...map.values()].sort((a, b) => b.updated - a.updated)
  }

  subagentCount(id: string): number {
    return this.children.get(id)?.size ?? 0
  }

  isWorking(id: string): boolean {
    for (const c of this.family(id)) if (this.running.has(c)) return true
    return false
  }

  needsInput(id: string): "permission" | "question" | undefined {
    for (const c of this.family(id)) {
      if (this.permissions.get(c)?.length) return "permission"
      if (this.forms.get(c)?.length) return "question"
    }
    return undefined
  }

  pendingInputSessions(id: string): string[] {
    return [...this.family(id)].filter((sid) => this.permissions.get(sid)?.length || this.forms.get(sid)?.length)
  }

  /** Short label for the card footer while the session works. */
  activityLabel(id: string): string {
    const own = this.activity.get(id)
    for (const c of this.family(id)) {
      const a = this.activity.get(c)
      if (a && this.running.has(c)) return a
    }
    return own ?? "Working…"
  }

  private *family(id: string): Generator<string> {
    const pending = [id]
    const seen = new Set<string>()
    while (pending.length) {
      const next = pending.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      yield next
      pending.push(...(this.children.get(next) ?? []))
    }
  }

  /** Finished, and not looked at since it finished. */
  unseen(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.time.idle) return false
    return (s.time.viewed ?? 0) < s.time.idle
  }

  status(id: string, now = Date.now()): Status {
    const s = this.sessions.get(id)
    if (!s) return "done"
    if (this.needsInput(id)) return "needs-you"
    if (this.isWorking(id)) return "working"
    const fresh = this.unseen(id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW
    if (s.outcome === "failed") return "failed"
    if (fresh && s.outcome !== "interrupted") return "review"
    if (s.outcome === "interrupted") return "stopped"
    return "done"
  }

  /** Root sessions by status, for the top bar and tab title. */
  statusCounts(now = Date.now()): Record<Status, number> {
    const counts: Record<Status, number> = { "needs-you": 0, working: 0, review: 0, failed: 0, stopped: 0, done: 0 }
    for (const s of this.roots()) {
      const st = this.status(s.id, now)
      // Old failures you've already seen aren't news: they count as done here
      // even though status() still reports "failed" for their quiet red label.
      if (st === "failed" && !(this.unseen(s.id) && now - (s.time.idle ?? 0) < REVIEW_WINDOW)) counts.done++
      else counts[st]++
    }
    return counts
  }

  /** Statuses that count toward a filter chip (failed-and-unseen counts as review). */
  inFilter(id: string, filter: Status, now = Date.now()): boolean {
    const st = this.status(id, now)
    if (filter === "review") {
      const s = this.sessions.get(id)
      return st === "review" || (st === "failed" && this.unseen(id) && now - (s?.time.idle ?? 0) < REVIEW_WINDOW)
    }
    return st === filter
  }

  // ---- permissions -----------------------------------------------------------

  /** This session (or its parent) carries the allow-everything rule. */
  sessionAutoApproves(id: string): boolean {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      seen.add(current)
      const session = this.sessions.get(current)
      if (session?.permissions?.some(isAllowAll)) return true
      current = session?.parentID
    }
    return false
  }

  pendingPermissionCount(): number {
    let n = 0
    for (const list of this.permissions.values()) n += list.length
    return n
  }

  /** Reply "once" (no lasting rule) and drop it from the pending list. */
  async approve(req: PermissionRequest, auto = false) {
    const approved = await this.replyPermission(req, "once")
    if (auto && approved) this.onAutoApproved?.(req)
    return approved
  }

  async replyPermission(req: PermissionRequest, decision: PermissionDecision): Promise<boolean> {
    const key = `${req.sessionID}/${req.id}`
    const current = this.approving.get(key)
    if (current) {
      await current
      return false
    }
    const reply = (async () => {
      await this.backend.replyPermission(req.sessionID, req.id, decision)
      this.setList(this.permissions, req.sessionID, (this.permissions.get(req.sessionID) ?? []).filter((p) => p.id !== req.id))
      this.asksChanged(req.sessionID)
    })().finally(() => { this.approving.delete(key) })
    this.approving.set(key, reply)
    await reply
    return true
  }

  async approveAllPending(sessionID?: string): Promise<number> {
    const reqs = sessionID
      ? [...this.family(sessionID)].flatMap((id) => this.permissions.get(id) ?? [])
      : [...this.permissions.values()].flat()
    const results = await Promise.allSettled(reqs.map((r) => this.approve(r)))
    return results.filter((r) => r.status === "fulfilled" && r.value).length
  }

  setAutoApproveAll(on: boolean) {
    this.autoApproveAll = on
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0")
    } catch {
      /* private mode */
    }
    if (on) void this.approveAllPending()
    for (const id of this.permissions.keys()) this.touchParent(id)
  }

  /** Add or remove the allow-everything rule on the server for one session. */
  async setSessionAutoApprove(id: string, on: boolean) {
    const s = this.sessions.get(id)
    if (!s) return
    if (!on && s.parentID && this.sessionAutoApproves(s.parentID)) {
      throw new Error("Auto-approve is inherited from a parent session. Turn it off there.")
    }
    const rest = (s.permissions ?? []).filter((r) => !isAllowAll(r))
    const rules = on ? [...rest, ALLOW_ALL] : rest
    await this.backend.setSessionPermissions(id, rules.length ? rules : null)
    s.permissions = rules.length ? rules : null
    this.touchParent(id)
    if (on) await this.approveAllPending(id)
  }

  private maybeAutoApprove(req: PermissionRequest) {
    if (this.autoApproveAll || this.sessionAutoApproves(req.sessionID)) void this.approve(req, true).catch(() => {})
  }

  /** Tell OpenCode you've seen this session's latest result (syncs to other clients). */
  markViewed(id: string) {
    const s = this.sessions.get(id)
    if (!s || !this.unseen(id)) return
    // The server stores exactly what we send; "now" always covers the finish.
    const at = Math.max(s.time.idle!, Date.now())
    s.time.viewed = at
    this.touchParent(id)
    this.backend.markViewed(id, at).catch(() => {})
  }

  title(s: Session): string {
    return s.title?.trim() || this.previews.get(s.id)?.pendingUser?.slice(0, 80) || "New session"
  }

  // ---- previews -----------------------------------------------------------

  /** Ask for a card's preview; cheap to call every frame for visible cards. */
  wantPreview(id: string) {
    if (this.stopped) return
    if (this.previews.has(id) && !this.previewStale.has(id)) return
    if ((this.previewRetry.get(id) ?? 0) > Date.now()) return
    if (this.previewQueued.has(id)) return
    this.previewQueued.add(id)
    this.previewQueue.push(id)
    this.pumpPreviews()
  }

  private pumpPreviews() {
    while (this.previewInflight < PREVIEW_CONCURRENCY && this.previewQueue.length) {
      // Newest requests first: those are the cards on screen right now.
      const id = this.previewQueue.pop()!
      // A session deleted while its preview waited needs no fetch.
      if (this.deletedSessions.has(id)) {
        this.previewQueued.delete(id)
        continue
      }
      this.previewInflight++
      this.loadPreview(id).finally(() => {
        this.previewInflight--
        this.previewQueued.delete(id)
        this.pumpPreviews()
      })
    }
  }

  private async loadPreview(id: string) {
    try {
      const page = await this.backend.messages(id, 16)
      if (this.deletedSessions.has(id)) return
      this.previewRetry.delete(id)
      this.previewStale.delete(id)
      this.previews.set(id, buildPreview(page.data))
      this.touchCard(id)
    } catch {
      if (this.deletedSessions.has(id)) return
      this.previewStale.add(id)
      this.previewRetry.set(id, Date.now() + 5_000)
    }
  }

  private refreshPreviewSoon(id: string, delay = 900) {
    if (this.refreshTimers.has(id)) return
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id)
        this.previewStale.add(id)
        this.wantPreview(id)
      }, delay),
    )
  }

  // ---- events -------------------------------------------------------------

  private onEvent(ev: OcEvent) {
    const d = ev.data ?? {}
    const id: string | undefined = d.sessionID
    switch (ev.type) {
      case "session.created": {
        this.deletedSessions.delete(d.sessionID)
        const s: Session = {
          id: d.sessionID,
          parentID: d.parentID,
          projectID: d.projectID,
          agent: d.agent,
          model: d.model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: ev.created ?? Date.now(), updated: ev.created ?? Date.now() },
          title: d.title,
          location: d.location ?? ev.location ?? { directory: "" },
        }
        this.sessions.set(s.id, s)
        if (s.parentID) {
          if (!this.children.has(s.parentID)) this.children.set(s.parentID, new Set())
          this.children.get(s.parentID)!.add(s.id)
          this.touchCard(s.parentID)
        }
        // The event lacks some fields (parentID on forks); fetch the real record.
        this.backend
          .getSession(s.id)
          .then((full) => {
            if (!this.sessions.has(s.id)) return
            this.sessions.set(s.id, full)
            this.rebuildChildren()
            this.markStructure()
          })
          .catch(() => {})
        this.markStructure()
        break
      }
      case "session.deleted":
        if (id) {
          this.removeSession(id)
          this.rebuildChildren()
          this.markStructure()
        }
        break
      case "session.renamed":
        this.patch(id, (s) => (s.title = d.title), true)
        break
      case "session.moved":
      case "session.forked":
        if (id)
          this.backend
            .getSession(id)
            .then((s) => {
              if (!this.sessions.has(id)) return
              this.sessions.set(id, s)
              this.rebuildChildren()
              this.markStructure()
            })
            .catch(() => {})
        break
      case "session.execution.started":
        if (!id) break
        this.running.add(id)
        this.activity.set(id, "Working…")
        this.liveText.delete(id)
        this.patch(id, (s) => (s.time.updated = ev.created ?? Date.now()), false)
        this.markStructure()
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (!id) break
        this.running.delete(id)
        this.activity.delete(id)
        this.patch(
          id,
          (s) => {
            s.outcome = ev.type.endsWith("succeeded") ? "succeeded" : ev.type.endsWith("failed") ? "failed" : "interrupted"
            s.time.updated = ev.created ?? Date.now()
            s.time.idle = ev.created ?? Date.now()
          },
          false,
        )
        this.refreshPreviewSoon(id, 250)
        break
      case "session.reasoning.started":
        this.setActivity(id, "Thinking…")
        break
      case "session.text.started":
        this.setActivity(id, "Writing…")
        if (id) this.liveText.set(id, "")
        break
      case "session.text.delta":
        if (!id) break
        this.liveText.set(id, ((this.liveText.get(id) ?? "") + (d.delta ?? "")).slice(-600))
        this.touchParent(id)
        break
      case "session.text.ended":
        if (id) this.refreshPreviewSoon(id, 300)
        break
      case "session.tool.input.started":
        this.setActivity(id, describeTool(d.name ?? "tool"))
        if (id) this.toolNames.set(d.id, d.name)
        break
      case "session.tool.called":
        this.setActivity(id, describeTool(this.toolNames.get(d.id) ?? "tool", d.input))
        break
      case "session.tool.success":
      case "session.tool.failed":
        this.toolNames.delete(d.id)
        this.setActivity(id, "Working…")
        break
      case "session.compaction.started":
        this.setActivity(id, "Compacting context…")
        break
      case "session.retry.scheduled":
        this.setActivity(id, "Retrying…")
        break
      case "session.inbox.enqueued":
        if (id && d.item?.type === "user") {
          const p = this.previews.get(id)
          this.previews.set(id, { ...(p ?? { text: "", bullets: [] }), pendingUser: d.item.payload?.text })
          this.touchCard(id)
        }
        break
      case "session.model.selected":
        this.patch(id, (s) => (s.model = d.model ?? s.model), false)
        break
      case "session.usage.updated":
        this.patch(
          id,
          (s) => {
            s.cost = d.cost ?? s.cost
            s.tokens = d.tokens ?? s.tokens
          },
          false,
        )
        break
      case "permission.asked":
        // A malformed payload must never enter the pending list: syncAsks
        // compares against the server snapshot and would never converge.
        if (id && typeof d.id === "string" && typeof d.action === "string" && Array.isArray(d.resources)) {
          const req = { ...(d as PermissionRequest), sessionID: id }
          const list = (this.permissions.get(id) ?? []).filter((p) => p.id !== req.id)
          list.push(req)
          this.permissions.set(id, list)
          this.asksChanged(id)
          this.maybeAutoApprove(req)
        }
        break
      case "permission.replied":
        if (id) {
          this.setList(
            this.permissions,
            id,
            (this.permissions.get(id) ?? []).filter((p) => p.id !== (d.requestID ?? d.id)),
          )
          this.asksChanged(id)
          // Payloads differ by version; confirm against the server.
          void this.syncAsks(id)
        }
        break
      case "form.created":
      case "question.asked":
        if (id) {
          const form = d.form ?? d
          if (typeof form.id === "string" && Array.isArray(form.fields)) {
            this.forms.set(id, [...(this.forms.get(id) ?? []).filter((f) => f.id !== form.id), { ...form, sessionID: id }])
          }
          this.asksChanged(id)
          void this.syncAsks(id)
        }
        break
      case "form.replied":
      case "form.cancelled":
      case "question.replied":
      case "question.rejected":
        if (id) {
          this.clearForm(id, d.formID ?? d.requestID ?? d.id)
          void this.syncAsks(id)
        }
        break
    }
    for (const l of this.listeners) l.event?.(ev)
  }

  private toolNames = new Map<string, string>()

  private setActivity(id: string | undefined, label: string) {
    if (!id) return
    if (!this.running.has(id)) this.running.add(id)
    if (this.activity.get(id) === label) return
    this.activity.set(id, label)
    this.touchParent(id)
  }

  private touchParent(id: string) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      seen.add(current)
      this.touchCard(current)
      current = this.sessions.get(current)?.parentID
    }
  }

  private removeSession(id: string) {
    this.touchParent(id)
    this.deletedSessions.add(id)
    this.sessions.delete(id)
    this.running.delete(id)
    this.activity.delete(id)
    this.previews.delete(id)
    this.liveText.delete(id)
    this.permissions.delete(id)
    this.forms.delete(id)
    this.previewStale.delete(id)
    this.previewRetry.delete(id)
    clearTimeout(this.refreshTimers.get(id))
    this.refreshTimers.delete(id)
    this.asksChanged(id)
    // Bump first (to invalidate any in-flight ask sync), then drop the version
    // entry so a deleted session doesn't accumulate one per id for the tab's life.
    this.askVersions.delete(id)
  }

  private patch(id: string | undefined, fn: (s: Session) => void, structural: boolean) {
    if (!id) return
    const s = this.sessions.get(id)
    if (!s) return
    fn(s)
    if (structural) this.markStructure()
    this.touchParent(id)
  }

  // ---- change batching ----------------------------------------------------

  touchCard(id: string) {
    this.dirtyCards.add(id)
    this.scheduleFlush()
  }

  markStructure() {
    this.structureDirty = true
    this.scheduleFlush()
  }

  private scheduleFlush() {
    // After stop() a late event (or an in-flight preview) must not re-arm the
    // timer and notify listeners on a torn-down store.
    if (this.stopped || this.flushScheduled) return
    this.flushScheduled = true
    // Next frame when visible; the timer covers background tabs, where frames
    // don't run but the tab title and counts must keep updating.
    const run = () => {
      if (!this.flushScheduled) return
      this.flushScheduled = false
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      if (this.structureDirty) {
        this.structureDirty = false
        for (const l of this.listeners) l.structure?.()
      }
      if (this.dirtyCards.size) {
        const ids = this.dirtyCards
        this.dirtyCards = new Set()
        for (const l of this.listeners) l.cards?.(ids)
      }
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
    this.flushTimer = setTimeout(run, 300)
  }
}

export function buildPreview(desc: Message[]): Preview {
  // desc = newest first
  let pendingUser: string | undefined
  let answered = false
  for (const m of desc) {
    if (m.type === "assistant") {
      answered = true
      const text = lastAssistantText(m.content)
      if (text) return { ...previewBlocks(text), pendingUser }
    } else if (m.type === "user" && !answered && pendingUser === undefined) {
      pendingUser = m.text
    }
  }
  return { text: "", bullets: [], pendingUser }
}
