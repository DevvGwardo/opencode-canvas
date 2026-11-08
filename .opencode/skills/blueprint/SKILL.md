---
name: blueprint
description: "Repo evidence report: test harness, screenshots, findings"
when_to_use: >-
  Use when the user says "blueprint", "run it/this through the blueprint", "make, update or
  refresh the blueprint" or "blueprint pass", or asks for a reproducible audit, evidence report,
  screenshot sweep, findings ledger, or before/after proof of what an app, repo, platform or
  mascot actually does. Not Hermes's built-in cron /blueprint automation templates.
version: 1.5.0
triggers:
  - blueprint
  - run it through the blueprint
  - run this through the blueprint
  - make a blueprint
  - update the blueprint
  - refresh the blueprint
  - blueprint pass
author: devgwardo
metadata:
  hermes:
    tags: [testing, evidence, screenshots, audit, report]
    category: software-development
    related_skills: [cua-driver]
---

# Blueprint

A blueprint is two things that ship together:

1. **The harness** (in the repo, `tools/blueprint/`): scripts that drive the real thing and write raw
   evidence (screenshots, recordings, exported files, JSON reports of pass/fail checks and
   measurements) to a gitignored `blueprint-out/`.
2. **The report** (`docs/blueprint/<project>-blueprint.html` + `media/`): a page where every number,
   image and claim comes from the latest harness run. Nothing is estimated or copied from memory.

The point is trust: a reader can see what the project does, how it's built, what was tested and
what failed, what got fixed, and what to do next, and the repo can regenerate all of it.

## When to use

- The user says "blueprint", "run it/this through the blueprint", "make / update / refresh the
  blueprint", or "blueprint pass".
- They want a reproducible audit, evidence report, screenshot sweep, findings ledger, or
  before/after proof of what an app, repo, platform or mascot does.
- Not for Hermes's built-in `/blueprint` (cron automation templates), and not for a quick one-off
  screenshot or a code walkthrough with no harness.

## Start here (Claude Code and Hermes alike)

The skill lives at `~/.agents/skills/blueprint` (Claude Code shows it as "Base directory for this
skill"; Hermes's `skill_view("blueprint")` returns it as `skill_dir`). Every command below works the
same from Claude Code's Bash and Hermes's `terminal`:

```sh
BP_SKILL=~/.agents/skills/blueprint
python3 "$BP_SKILL/scripts/doctor.py" --repo /path/to/repo
```

`doctor.py` is read-only. It reports the mode (bootstrap vs feature pass/refresh), the existing
harness and report pages, recorded published URLs, the newest run reports (pass counts, age,
whether screenshots were reviewed), and missing tools. Read its notes before planning.

| Need | Claude Code | Hermes Agent |
|---|---|---|
| Read repo files, skill files | `Read`, `Grep` | `read_file`, `search_files`; `skill_view("blueprint", "templates/sweep.mjs")` |
| Run harness and helpers | `Bash` | `terminal` (on the Mac that runs the app, not a remote backend) |
| Look at screenshots | `Read` on the PNG/JPG | `vision_analyze` on the image path (Surplus `gemma-4-26b-a4b-it`; if it errors, `visual_blueprint.py --reviewer agy`) |
| Parallel workers | subagents (disjoint files) | `delegate_task`, or the task queue |
| Publish the page | `Artifact` (only when the user asks) | No Artifact tool: deliver the local page (see Publishing) |

Hermes-specific notes:
- Hermes's own `/blueprint` (alias `/bp`) sets up **cron automations**. It is unrelated. Load this
  skill with `/skill blueprint` or `skill_view("blueprint")`.
- `skill_view`'s `linked_files` lists only some file types; the `.mjs` and `.html` files in
  `templates/` and `scripts/` exist anyway. Load them by path (see "Files in this skill").
- The older Hermes-only `ui-workbench-blueprint` skill is a single-component workbench pattern.
  Use this skill for blueprint reports.
- Hermes logs "skill file is outside the trusted skills directory" because the skill is a symlink
  into `~/.agents/skills`. That's a warning, not a failure.
- Installed in the default and `nub` profiles. To add one, never overwrite:
  `[ -e "$P/blueprint" ] || ln -sn ~/.agents/skills/blueprint "$P/blueprint"` (`$P` = the profile's
  `skills/`). A plain `ln -s` onto the existing link created a `blueprint/blueprint` loop once.

Never assume a tool exists. If a capability is missing (no image viewing, no publisher, no Chrome),
report that step as **blocked**, never as passed.

## Pick the mode

| The user says | Mode | What you do |
|---|---|---|
| "make a blueprint for X" (none exists) | **Bootstrap** | Inventory → build the harness → full run → write the report → publish if asked |
| "run <feature> through the blueprint" | **Feature pass** | Add a harness script for the feature → run it *and* the existing sweeps → fix what it finds → add a section → republish at the same URL if one exists |
| "update / refresh the blueprint" | **Refresh** | Re-run every script, re-tally every number, drop stale claims, republish |

A repo can have several reports (Hermes Desk has `nub-mobile` and `mascot`). Update the one that
owns this feature, not a duplicate. Some repos use `docs/blueprints/` (plural); keep whatever exists.

## Pick the flavour (or mix them)

- **Product** (anything with a UI or an output: web apps, editors, games, generators). Evidence comes
  from driving the real app with Playwright in real Chrome: UI states, a render/output matrix,
  exports checked by an independent tool (ffprobe, file parsers), perf, edge cases, phone width,
  a recorded walkthrough.
- **Platform audit** (services, monorepos, infra). Evidence comes from the repo and its history: LOC
  by area (excluding generated code), routes, tests, git growth, hot paths traced to file:line,
  security sweeps, flags. The core is a **findings ledger** (below). Re-verify the highest-severity
  claims by hand before publishing.

## Repo layout (create it if missing)

```
tools/blueprint/
  README.md          # what each script does, how to run it, the published URL (templates/tools-README.md)
  sweep.mjs          # UI states, output matrix, perf, edge cases     (templates/sweep.mjs)
  <feature>.mjs      # one script per feature pass                    (templates/feature.mjs)
  exports.mjs        # real outputs through the real UI, verified by an external tool
  findings.json      # the findings ledger (platform audits, and any pass that finds bugs)
  mobile.mjs, walk.mjs (optional: phone layout, walkthrough recording)
blueprint-out/       # GITIGNORED raw evidence: ui/ render/ mp4/ data/ review/
docs/blueprint/
  <project>-blueprint.html   # the report source (templates/blueprint.html)
  media/                     # curated, compressed evidence the page references
```

Add `blueprint-out` to `.gitignore`. Give the app a small **test hook** so scripts can read state
and set up fixtures without clicking through everything, e.g. `window.__app = { store, makeFixture }`
(Nubcat uses `window.__nubcat`), with a comment saying it's for automation.

Reports are `blueprint-out/data/report-<script>[-<label>].json` holding
`{checks: [{name, ok, detail}], perf, errors, screenshots, visualReview}`. Each script prints its
report path; use the printed path, never a guessed or stale one. Before/after runs get distinct
labels so a baseline is never overwritten, using whatever the repo's scripts already parse (read
the script header or README first: nubcat `--before`, hermes-deploy `BP_LABEL`, hermes-desk
`BP_NAME`; the skill templates make a fresh run id every time). Never pass a flag a script doesn't
read. Native-desktop evidence may use Python + cua-driver instead of a browser script.

## Harness rules (each one comes from a bug we actually hit)

- **One `check(name, ok, detail)` per promise.** Word the name as the behaviour a user relies on
  ("One drag = one undo step"); the detail holds the measured value. Exit non-zero if any fails.
- **Real browser, clean isolated state**: `chromium.launch({ channel: "chrome" })`, a disposable
  context, wait for an app-ready condition (never a bare sleep). Collect `console.error` and
  `pageerror`, and end with a "No console errors" check. Use a fresh context per viewport (reused
  contexts kept a stale 2× scale).
- **Block the network**: abort every non-local request with `page.route`, and refuse to start if
  `APP_URL` isn't serving the expected app. Seeds and DB fixtures refuse non-localhost URLs.
- **Load explicit fixtures.** Don't depend on the app's default state. When Nubcat's default
  template changed, a sweep that clicked `.block.move.nth(2)` broke silently for weeks.
- **Paths**: use `fileURLToPath(new URL(…, import.meta.url))`, never `.pathname` (the repos live on
  `/Volumes/T7 Shield/…`, and `%20` breaks it). Don't name a const `URL`. Use `APP_URL` / `BP_OUT`.
  When Playwright lives in another checkout, resolve it with `createRequire` from
  `BP_PLAYWRIGHT_FROM` (hermes-deploy borrows `../maiavm-desktop`).
- **Start the app with `devserver.py`, never `&` plus sleep loops** (Claude Code blocks foreground
  `sleep`). It returns once the URL answers, refuses a port another session is already serving, and
  `stop` kills only what it started:
  `python3 "$BP_SKILL/scripts/devserver.py" start --url http://localhost:5199/ --expect "<app title>" -- npx vite --port 5199`
  Use a port of your own, not the one the user's dev server is on. One-off capture scripts belong in
  `tools/blueprint/` so `import "playwright"` resolves from the repo (scratchpad scripts can't find it).
- **Run scripts one after another** (`a && b && c`), never overlapping: parallel browsers skew perf
  and clobber logs. Don't edit `src/` or the running shell script while a chain runs (Vite reloads
  the page under test; the shell reads its script by offset).
- **Worktree baselines** need their own Vite `cacheDir` (a shared one mixed two three.js bundles
  and bloom silently stopped). Turbopack refuses a symlinked `node_modules`: use `cp -cR`.
- **Correctness and perf on different builds**: dev builds double-run effects (StrictMode); measure
  perf on the production build. Time things with the page's own clock, scroll with
  `behavior: "instant"`.
- **Verify outputs independently.** Probe exported files (ffprobe: codec, size, exact frame count)
  and compare a decoded frame against the app's own render (mean abs diff under a small threshold).
  When a diff fails, map *where* it differs before touching the threshold.
- **Measure what the feature promises, geometrically when you can.** "The can is at the mouth"
  became a distance check and caught a side-on pose that looked fine in thumbnails.
- **Visual matrix for anything that renders**: render every axis a user can combine (content ×
  camera/viewport × size × theme) and measure each frame (framed, unblocked, sensible size, not
  blank). Nubcat's `tools/blueprint/angles.mjs` is the reference: 176 frames in ~4 s.
- **Golden frames need deterministic inputs** (seeded randomness, a virtual clock). Prove it by
  running twice: the second run must diff 0/255. Re-bless goldens only with an explicit flag.
- **Canvas / 3D**: get screen coordinates from the engine's projection, confirm with a pick at that
  point before clicking, and refresh camera matrices after a mode switch.
- **Production probes** are read-only and rate-limited; a challenged probe is *skipped*, not failed.
- **Screenshots** at `deviceScaleFactor: 2` into `blueprint-out/ui/<run>/`, then downscale into
  `docs/blueprint/media/` with `scripts/media.py`. Native windows record their real pixel size and
  need an exact `(pid, window_id)` capture; a main-window screenshot can't prove a floating one.

## Visual loop (required for anything with a UI or visual output)

A source audit, green tests, or "screenshots saved" is not a visual blueprint. Capture, look,
write findings, fix (when authorized), re-capture with identical inputs, compare.

1. Capture meaningful states, error/empty states, real sizes, themes. For motion, sample the start,
   peak, handoff and settle, not one attractive frame.
2. Index images (id, source/fixture, size, time, hash). Missing screenshots are a failed capture.
3. **Actually look** at every contact sheet with an image-capable tool (`Read` / `vision_analyze`).
   File metadata or another model's prose without the pixels never counts as review.
4. Each finding: image id + hash, visible issue, impact, concrete fix, and the re-capture that
   would verify it. Label taste vs measured bugs; uncertain ones stay *candidates*.
5. After a fix, show BEFORE / AFTER / DIFF and look again. A pixel diff means "changed", not "better".

`scripts/visual_evidence.py` builds galleries, contact sheets, GIFs and matched comparisons from any
report with `screenshots`; `scripts/visual_blueprint.py` runs capture → gallery → review → finding
history in one command. Full workflow, review import and completion gates:
`references/visual-improvement-loop.md`. Model review sends pixels to that provider: review only
approved, non-sensitive fixtures.

Capture-only work never clears a user's real profile, pairs accounts, sends messages, uploads,
publishes, or takes over their mouse/keyboard.

## Feature pass, step by step

1. `doctor.py`, then read the feature's code and list every promise it makes: behaviours, limits,
   guard rails, persistence, undo, export/output, phone layout, perf.
2. Write `tools/blueprint/<feature>.mjs` from `templates/feature.mjs`, one check per promise,
   including unhappy paths: clamping, refusals, locked items, junk in saved files, cancel/undo.
3. Run it. **A failing check is a finding, not a test to delete.** Decide whether the bug is in the
   product or the test, fix it, and log it for "Fixed in this pass". Keep going until it's green.
4. Run the existing sweeps too (`sweep`, `exports`, `mobile`) to catch regressions; fix stale scripts
   and say so in the report.
5. Run the repo's own unit/e2e tests and the build. Their counts go on the status tiles.
6. Visual loop, media, then `tally.py --fill`, then the prose, then publish if asked.

## Findings ledger

`tools/blueprint/findings.json`, an array of
`{id, area, sev, eff, status, since, title, ev, why, fix, sha, now, files}`:
`sev` critical|high|med|low, `eff` S|M|L, `status` open|partial|fixed|dormant, `since` the pass
that found it, `ev` a file:line or image-id anchor, `sha` the fixing commit(s), `now` what's true
after the fix. Close a finding by setting `status` and `sha`, never by deleting it. The main
checkout's ledger is the source of truth; merge worktree passes back into it.

## The report

**Before writing HTML, load `artifact-design` if your agent has it**, then start from
`templates/blueprint.html` (tokens, light/dark, TOC, KPI tiles, tables, roadmap, video grid). Give
each project its own identity (Nubcat's KPI tiles are LED counters).

**Counts are generated, never typed.** The template marks them with paired comments
(`<!--bp:checks-->…<!--/bp:checks-->`, `checks-rows`, `perf-rows`, `console-errors`, `shots`,
`findings-open|fixed|total|rows`, `generated`). Fill them from this run's reports:

```sh
python3 "$BP_SKILL/scripts/tally.py" <report paths printed this run> \
  --findings tools/blueprint/findings.json --fill docs/blueprint/<project>-blueprint.html
```

Drop `--findings` when the repo has no ledger. It prints totals, every failed check, ledger counts and lint (open with no fix, fixed with no sha,
no evidence anchor, duplicate ids), and exits 1 when something needs attention. Repos with their
own renderer (hermes-deploy `render.mjs`, hermes-desk `build-report.mjs`) keep using it.

Product-flavour sections, in order (drop any that don't apply): **Status** (eyebrow, headline, lede,
KPI tiles) · **Watch it** (hero output + walkthrough) · **New in this pass** (demo, before/after,
how it works, honest limits) · reference gap table · **Architecture** (mermaid + module cards) ·
product tour · output matrix · **Outputs** (every exported file with probe numbers) · **Test
results** (area · check · measured · result, then perf with how it was measured) · **Fixed in this
pass** (issue · cause · fix) · **Roadmap** (P1/P2/P3 with evidence · approach · size; `done` pills;
a "Not yet tested" callout) · **Run & reproduce** (exact commands, every script).

Platform-audit flavour: at a glance (KPIs, severity bar, fix-first list), severity × effort matrix,
system map, growth, codebase shape, one section per risky subsystem with hot-path flows, security
ledger, flags to decide, roadmap lanes (Now / Next / Later), a filterable findings explorer, and
corrections to older blueprints.

Content rules: every number is from this run · show failures and limits plainly (a blueprint that
only shows green is an advert) · fix or remove stale claims · captions say what to notice ·
name files and functions in `code`.

## Publishing (optional; only when the user asks)

- **Claude Code**: first publish with `Artifact` (`file_path` = the HTML, `files` = every media
  file, an `icon`, a one-sentence `description`), then write the URL into `tools/blueprint/README.md`.
  To update, `Artifact read` the URL first (the published page can be newer than the repo copy),
  sync that source back into the repo, then publish with the same `url` and only new/changed media.
- **Hermes** (no Artifact tool): deliver the page locally. The template renders its own mermaid
  diagrams when opened as a file. Give the user the exact command:
  `python3 -m http.server 8765 -d docs/blueprint` → `http://localhost:8765/<project>-blueprint.html`.
  Never fabricate an artifact URL or deploy somewhere unrequested. If a published URL exists,
  note in the README that the local page is ahead of it, so a Claude Code session can republish.
- Either way, tell the user: the link or path, checks passed/total, what the pass found and fixed.

## Project references

- **Hermes Desk Pip** (the courier owl mascot): poses, clips, flights, review →
  `references/visual-improvement-loop.md` (`scripts/capture_mascot.mjs`, headless, no window needed).
- **Hermes Desk Computer PiP** (the floating preview window, not the owl): native capture through
  `agy` + `cua-driver` → `references/hermes-desk-pip.md` (`scripts/capture_pip.py`).
- Prior blueprints to read before writing a new page:
  - Product: Nubcat Studio, `~/nubcat-studio/docs/blueprint/` + `tools/blueprint/`,
    https://claude.ai/artifact/Wm9e7N1avcqDV12Xg5tXeZ
  - Platform audit: Hermes Deploy, `~/hermes-deploy/docs/blueprints/` + `tools/blueprint/`
    (`findings.json`, `ledger.mjs`, `render.mjs`), https://claude.ai/artifact/WmvW53JR4Kr4wkuPqTHG5A
  - Template-rendered reports: Hermes Desk, `~/hermes-desk/tools/blueprint/build-report.mjs`

## Files in this skill

Paths are relative to `$BP_SKILL`. In Hermes, load any of them with `skill_view("blueprint", "<path>")`.

- `scripts/doctor.py`: read-only preflight (mode, existing harness/pages/URLs, newest runs, tools).
- `scripts/tally.py`: totals + ledger lint from this run's reports; `--fill` writes the page's counts.
- `scripts/devserver.py`: `start` / `wait` / `status` / `stop` the app server the harness drives.
- `scripts/media.py`: `sheet` (labelled contact sheet), `pair` (before/after), `strip` (video frames),
  `web` (screenshot → compressed jpg), `mp4` (540-wide faststart copy). Accepts quoted globs and a
  zsh-joined file list; use it instead of raw ffmpeg/sips. Needs Pillow; ffmpeg for video.
- `scripts/visual_evidence.py`, `scripts/visual_blueprint.py`: image validation, galleries,
  comparisons, opt-in model review, finding history.
- `scripts/capture_mascot.mjs`: Hermes Desk owl capture suite. `scripts/capture_pip.py`: native
  Computer PiP capture.
- `scripts/test_*.py`: helper tests (`python3 -m pytest -q -p no:cacheprovider "$BP_SKILL/scripts"`).
- `templates/sweep.mjs`, `templates/feature.mjs`: harness skeletons. `templates/blueprint.html`:
  the report skeleton with tally regions. `templates/tools-README.md`: the harness README.
- `references/visual-improvement-loop.md`, `references/hermes-desk-pip.md`: see above.
