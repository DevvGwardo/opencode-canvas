# OpenCode Canvas — Review: improvements and gaps to fix

Scope: a full read of `src/` (app, server, shared), `test/`, `bin/`, `tsconfig.json`,
`.github/workflows/ci.yml`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, plus the
uncommitted working-tree changes.

Overall the project is in strong shape: ~14k LOC, no runtime dependencies, a clear
client/server split, pure layout/format/status logic with focused tests, and a genuinely
careful security posture (host/origin/Sec-Fetch-Site checks, timing-safe password compare,
login revocation that cuts live streams, credential stripping for model metadata, no automatic
retry of writes). `bun run typecheck` and `bun test` are green (126 pass / 1 skip).

## Fixed in this pass

1. **Demo backend reported interrupted runs as succeeded** — `src/app/demo.ts`
   `loop()` ended with `if (this.running.delete(id) || !forever)`. When a run was started by
   `prompt()` (so `forever === false`) and then interrupted, `interrupt()` had already removed
   the id from `running`, so `delete()` returned `false` but `!forever` was still true and the
   block overwrote `outcome` from `"interrupted"` to `"succeeded"`, emitting
   `session.execution.succeeded`. A stopped session showed "Done" in the demo UI. The tail now
   keys off whether the id was still present (natural completion vs. interrupt). Regression
   test in `test/demo.test.ts` (verified to fail against the old code).

2. **Unbounded proxy requests** — a hung OpenCode server left spinners pending forever.
   - `src/app/backend.ts`: every `LiveBackend` request now carries
     `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` (120s). Covered by a new
     `test/backend.test.ts` case asserting the signal is attached.
   - `src/server/server.ts`: non-stream proxy fetches use
     `AbortSignal.any([req.signal, AbortSignal.timeout(90_000)])`. SSE (`/api/event`) is
     deliberately left open. A timed-out upstream now returns the existing structured 502
     instead of hanging the connection.

3. **No regression test for proxy `content-encoding` handling** — added a gzip upstream case
   in `test/server.test.ts` that asserts the proxy strips `content-encoding`/`content-length`
   and the client receives valid JSON.

4. **Brittle UI-test assertion** — `test/ui.test.ts` asserted `passed === 13`; adding any
   fixture check broke it. Now `toBeGreaterThanOrEqual(13)`.

5. **CI used an unpinned Bun** — `.github/workflows/ci.yml` now pins `bun-version: 1.2.21`
   (matching local) instead of `latest`.

6. **`tsconfig.json` included a non-existent `server.ts`** — removed the dead entry
   (`"include": ["src", "bin", "test"]`).

7. **Redundant duplicate `touchParent()` call** in `Store.refreshRecent` (`src/app/store.ts`).

8. **README endpoint list was missing `info`** (`/api/info`, used by `/canvas/config`).

9. **Canvas cards were unreachable by keyboard.** Each card is `role="button"` but
   `tabindex="-1"`, so Tab skipped the whole canvas and screen readers could never land on a
   session. `src/app/canvas.ts` now maintains a roving tabindex (`applyTabStops`): exactly one
   reachable card carries `tabindex="0"` (the selection, or the first non-inert card when
   nothing is selected), and `doLayout`/`sync` keep it in step as piles fold and cards cull.
   Focusing a card selects it, arrow keys move focus with the selection, and Enter/Space
   activate the focused card like a real button. `src/app/styles.css` adds a `:focus-visible`
   ring; the help overlay and README keyboard table document the behaviour.

10. **`card.ts` and `canvas.ts` had no direct tests.** `test/ui-fixture.ts` now drives a real
    `CanvasView` (roving tabindex, focus selects, Enter/Space activate, the tab stop follows the
    selection) and `updateSessionCard` (live activity label, subagent count, `aria-label`, and
    the unseen-vs-viewed failure treatment). Verified to fail against the pre-fix code (a card
    with no tab stop trips `stops.length === 1`).

### Follow-up pass

11. **Canvas correctness.** `closeStack()` now collapses the piles with a synchronous layout
    before fitting the camera (the async `relayout()` previously framed the still-expanded
    columns). `applyTabStops()` never picks a card hidden by culling or the open panel as the
    roving tab stop, falling back to the first usable card; the frame loop only recomputes tab
    stops when the selected card's cull state flips. `setQuery("")` bumps the remote-search
    sequence so a late server result can't inject sessions after the box is cleared. Safari
    trackpad pinch — which fires both `gesture*` and synthetic ctrl-wheel events — is
    de-duplicated within a 250 ms window.

12. **Store hygiene.** `stop()` clears the pending flush timer (resetting `flushScheduled`) so a
    torn-down store never fires listeners later. `removeSession()` drops the session's
    `askVersions` entry after bumping it, so a deleted session doesn't leak a version per id.
    `permission.asked` ignores payloads missing a string `id`/`action` or a `resources` array,
    which would otherwise never converge against the server snapshot.

13. **Bounded form discovery.** `discoverPendingForms()` now rescans a directory only when the
    newest `time.updated` among its sessions changes (tracked in `formScanUpdated`), instead of
    querying `/api/form` for every project on each 45 s refresh; `reload()` forces a full sweep so
    a reconnect misses nothing. (This addresses the performance gap noted below.)

14. **Panel robustness.** A drop of a non-image file no longer navigates the app away (the handler
    always `preventDefault()`s; `dragover` only claims `Files`), the panel geometry clamps to a
    minimum width, the dialog is labelled by its title (`aria-labelledby`), and the model filter
    input has an accessible label.

15. **Transcript / commands / proxy polish.** A transient empty page no longer wipes an
    already-loaded transcript (and older pages survive when the page boundary moves). The `/`
    command box keeps a typed draft unless `/help` explicitly resets it. `browserUrl()` reports a
    friendly error for unparseable input. `getUpstream(true)` bypasses a stale in-flight resolve
    via a token, so a reconnect doesn't reuse a dead upstream.

16. **Tests.** New `test/store.test.ts` (malformed permission rejected; `askVersions` pruned on
    delete; `stop()` cancels a flush; discovery only rescans changed directories), a malformed-URL
    case in `test/browser.test.ts`, and two Chromium fixture checks (an open/culled card is never
    the tab stop; an empty refetch keeps the transcript). Suite: 126 pass / 1 skip.

### Second follow-up pass

17. **`Store.stop()` teardown completeness.** `stop()` now also clears the pending preview queue
    (`previewQueue`/`previewQueued`) and sets a `stopped` flag that `start()` resets, so
    `wantPreview()` and `scheduleFlush()` become no-ops after teardown. Previously an in-flight
    `loadPreview` resolving *after* `stop()` called `touchCard` → re-armed the flush timer and
    fired `cards` listeners on a torn-down store. `pumpPreviews()` additionally skips a queued id
    that is in `deletedSessions`, avoiding a wasted fetch for a just-deleted session. Verified
    fail-first: pre-fix the new tests observed a post-`stop()` flush and a fetch for a deleted id.

18. **Type-safety cleanups (no behavior change).** `CardView` gained a typed `fresh: boolean`
    field and `CanvasView` a `fitAfterLayout` field, replacing the `(c as any)`/`(this as any)`
    write hacks in `canvas.ts` (the dynamic-key writes in `stepSpring` stay `any`). `agent-switched
    .agent` widened to `string | { name?: string }` in `types.ts` so `transcript.ts` reads
    `model`/`agent` without `as any`. `panel.ts` now writes the canonical `Status` vocabulary
    (`done`/`stopped`/`failed`) to its `data-status` — matching `card.ts`/`tiles.ts` — instead of
    the raw `succeeded`/`interrupted` outcome it alone emitted. Typecheck stays clean.

19. **Demo coverage.** `test/demo.test.ts` gained two checks — `createSession` registers the
    project and announces the session, and a message queued while running waits in the inbox for
    the next turn — plus a `drain()` helper (seeded runs re-arm their timers, so each test drains
    ~3 s before finishing). Suite: 130 pass / 1 skip.

### Third follow-up pass

20. **A vanished session no longer holds its asks forever.** `syncAsks()` treats *both*
    session-scoped ask endpoints answering 404 as "this session is gone" and clears its local
    permissions/forms. Before, a 404 was indistinguishable from an outage: the entry was kept by
    design ("an unavailable endpoint must not erase a question"), so a session deleted on another
    client (or aged past `MAX_SESSIONS`) left a ghost permission that pinned the top bar's
    "Allow all" chip on, kept `approveAllPending()` retrying a dead request, and made the 15 s
    `syncPendingAsks()` poll it forever. A single 404 (a server without one endpoint) or any
    non-404 error is still treated as "keep" — the conservative rule is now pinned by a test.
    Verified fail-first: pre-fix the ghost asks were retained and `status("root")` stayed
    `needs-you`. (Assumes the API answers 404 on session-scoped routes for a missing session, which
    the live backend's `ApiError.status` already carries.)
21. **Sign-in failures always show a readable message.** `login.ts` read the failure body with
    `res.json()`, so a reverse-proxy HTML error page surfaced as *"Failed to execute 'json' on
    'Response': Unexpected token '<' …"* on the sign-in card. It now reads text and only uses a
    JSON `message` when the body actually parses, falling back to `Sign in failed (502)`. Verified
    fail-first in the Chromium fixture (pre-fix the check captured the parse error verbatim).
22. **Coverage for previously untested modules.** Three Chromium fixture checks: the auto-approve
    two-click confirm (one click only arms it, the second enables it, a click while on turns it
    off) and its batched "Auto-approved N requests" notice; `spinner()`'s pinned style,
    `aria-hidden`, square sizing, and a real painted frame; and the sign-in message above. The
    fixture floor moved 15 → 18. Suite: 132 pass / 1 skip.

## Remaining gaps (recommended, not yet done)

### Test coverage
`test/` covers the pure and server layers well, but these modules still lack direct tests:

| Module | Notes |
|---|---|
| `src/app/demo.ts` | Now has `test/demo.test.ts` (interrupt path, `createSession`, queue delivery); `loop()` rounds still indirect. |
| `src/app/canvas.ts` | Spring/culling/selection exercised via the Chromium fixture (`test/ui-fixture.ts`); spring physics itself still indirect. |
| `src/app/card.ts` | Covered by `test/ui-fixture.ts` (`updateSessionCard`). |
| `src/app/panel.ts`, `src/app/picker.ts` | Only via the Chromium fixture (`test/ui-fixture.ts`). |
| `src/app/approve.ts`, `login.ts`, `spinners.ts` | Covered by `test/ui-fixture.ts` since the third pass (confirm flow + batching, failed sign-in message, painted spinner frame). |
| `src/app/toast.ts` | Exercised indirectly through `approve.ts`; its own add/remove lifecycle is untested. |
| `src/app/browser.ts` (client) | No test; `src/server/browser.ts` is well covered. |
| `src/app/main.ts` | Entry point; wiring (hash routes, `updateStats`) untested. |

`src/server/upstream.ts` now has `test/upstream.test.ts` (option/env precedence, credential rejection, `authHeader`).

### Performance / scale
- **~~`Store.discoverPendingForms()` fans out to every directory.~~** Addressed in the
  follow-up pass (#13): steady-state refreshes now rescan only directories whose newest session
  `time.updated` changed; boot and `reload()` still do a full sweep. Reconciling pending
  questions purely from the `form.created` event stream remains an option if directory counts
  grow large.

### Consistency (minor, likely intentional)
- `Store.status()` returns `"failed"` for old, already-seen failures, while
  `Store.statusCounts()` folds those same sessions into `done`. This matches the README
  ("failures keep a quiet red label until seen"). A clarifying comment now records the
  divergence in `store.ts`; an explicit `"failed-seen"` status would remove it entirely.

### Robustness (minor, left alone)
- The browser panel reads its action-failure body with `res.json()` (`src/app/browser.ts`), the same
  shape as #21: a proxy HTML error page would put a JSON parse error in the panel's status line.
  Left for now because it is a transient status line, and the panel needs a live EventSource
  (`/canvas/browser/events`) to reach the failing branch in a test.

### Tooling / CI
- **No linter/formatter.** No `lint` script or config. Biome's defaults flag ~260
  style/formatting diagnostics against the codebase's deliberate 2-space/no-semicolon style, so
  adopting it means either reformatting everything or hand-picking a rule subset; left alone as
  a maintainer decision rather than a drive-by change.
- **`@types/bun`** is already pinned with a caret (`^1.4.2`), so typechecking is reproducible.

## Accessibility

Cards are now keyboard-reachable (roving tabindex; see "Fixed in this pass" #9): Tab enters the
canvas at the selected card, arrow keys move between cards, and Enter/Space open one. Chips,
dialogs, the login form, and the browser viewport already carry sensible roles/labels.

## Security

No critical gaps found. The guard order (host → origin → Sec-Fetch-Site → auth), the
`digest`+`timingSafeEqual` password check, the per-IP rate limit, session pruning/eviction,
the `--origin` reverse-proxy path, and the loopback-only CDP binding all look correct. The
shared-browser and auto-approve trade-offs are clearly documented in `SECURITY.md`/README.

## Method note

While verifying the demo data I hit a case where `read_file`/`sed` showed one thing and
`od -c` + an md5-after-`sed` substitution showed another for the same file (some string
literals appeared altered in the higher-level tool output). I cross-checked every data-level
claim against raw bytes, so the findings above are based on the actual file contents.
