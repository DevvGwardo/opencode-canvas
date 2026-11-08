# Visual Blueprint: capture → inspect → improve → compare

Use this for every UI, mascot, animation, chart, canvas, game, or rendered output. A blueprint
that cannot show what it tested is incomplete. Platform-only audits may omit visuals when the
system genuinely has no visual output.

## Choose the right target

In Hermes Desk, **Pip is the courier owl mascot**. **Computer PiP is a separate preview window.**
Do not route "capture Pip poses/animations" through `capture_pip.py`. The owl has a headless
lab, so absent desktop windows and screen-recording grants do not block owl screenshots.

Reuse the project's existing harness and production rendering engine. Don't draw a look-alike.
For general web/app work, extend `templates/sweep.mjs` / `templates/feature.mjs` to capture
the actual state/viewport combinations, index those images, and visually review them.

## Pip: executable capture workflow

Prerequisites: Hermes `terminal` can access the Hermes Desk repo and its installed Node
dependencies (`playwright-core`, Vite), Chrome or `CHROMIUM_PATH`, and Python with Pillow.
Use the host's working Python, not a Hermes interpreter that lacks Pillow. No native desktop
window, cua-driver, live agent conversation, account, or Screen Recording grant is required.

The skill helpers run against the project's installed tools, preserve product/source files,
bind their private lab to loopback, block nonlocal browser requests, use a clean headless
context, and tear down only their own server/browser. Run capture jobs sequentially.

### One command (preferred)

```sh
python3 "$BP_SKILL/scripts/visual_blueprint.py" \
  --repo /absolute/hermes-desk --label before --reviewer agy
```

`--reviewer agy` explicitly sends these approved, non-sensitive fixture images to the model
provider. Without it, capture and gallery still run, the review prompt is saved, and exit
**2** means **review pending**, not failure of the capture or a completed visual pass.
Exit 0 requires an imported complete review; denial/empty output/partial coverage stays blocked.
The existing individual helpers and native Computer PiP workflow are unchanged.
Model review runs sequential batches of at most ten sheets, preserves every raw response,
and requires exact assigned-sheet coverage before merging. Conflicting rechecks stay
unverified (or persistent when the issue is still reported), never optimistically resolved.

To resume a pending/blocked review without recapture:

```sh
python3 "$BP_SKILL/scripts/visual_blueprint.py" \
  --review-dir /absolute/after-review --reviewer agy \
  --baseline /absolute/before-report.json \
  --previous-review /absolute/before-review/visual-review.json
```

Omit baseline/history flags for a first-pass review. Attempts get unique response directories;
capture manifests and PNGs are never replaced. A malformed response stays blocked, even
when the CLI exits zero. Do not recapture merely because a model returned truncated JSON.

After an authorized product change:

```sh
python3 "$BP_SKILL/scripts/visual_blueprint.py" \
  --repo /absolute/hermes-desk --label after --reviewer agy \
  --baseline /absolute/before-report.json \
  --previous-review /absolute/before-review/visual-review.json
```

For general UI captures, replace `--repo` with `--report /absolute/fresh-report.json`.
The same validation, comparison, image review, and history apply; owl-only criteria are not
imposed on unrelated UIs. Each run preserves its own PNGs, raw review response, and manifests.
Every changed-image pair remains available. Review sheets group matched panels by sequence
so tiny raster differences do not create hundreds of separate model tool calls.

In `terminal` (or Bash), set `BP_SKILL=~/.agents/skills/blueprint` and use the actual repo path:

```sh
node "$BP_SKILL/scripts/capture_mascot.mjs" \
  --repo /absolute/hermes-desk --label before
```

Read the printed JSON to get the exact `report` path. Do not guess a UUID or read an old report.

```sh
python3 "$BP_SKILL/scripts/visual_evidence.py" \
  /absolute/hermes-desk/blueprint-out/data/report-mascot-before-<run>.json
```

This prints the fresh review directory. Open its `index.html` locally, or use `vision_analyze`
on its contact sheets. The gallery includes:

- Every discovered pose on dark/light backgrounds at **160 / 40 / 24 CSS px**, captured at DPR 2.
- The actual default/agent palettes and selected reduced-motion poses.
- **Every discovered clip**, including fly/glide/hover, and every reaction, with eight samples
  spaced over the actual JSON duration plus a tail/settle sample.
- Per-sequence contact sheets and sampled GIFs with measured sample timing.
- Idle→tool→talking→error→idle blended transition strips.
- Real production takeoff/cruise/landing/perch and home-return chains for all four flight
  paths, both normal and reduced motion; public clip calls and landing geometry are recorded.
- Dense 60Hz delivery geometry, native-size pose similarity, and subject-margin cues.
- Nearest-neighbor inspection zooms from the captured 40/24px pixels, clearly labeled as zooms.
- A real mascot-lab context screenshot, raw PNGs, hashes, source labels, and coverage checks.

The exact counts come from the current run's catalog, not a fixed promise in this document.
These are production-engine fixtures, not proof that the native sidebar or reply-delivery
integration works. `tools/mascot/stage.mjs` and `tests/e2e/mascot-stage.mjs` cover flight and
native app integration separately. Run them when a finding touches those boundaries.

Measurements are deliberately bounded: eye/prop bounding-box overlap is a conservative cue,
not exact pixel occlusion. Crop differences do not prove human-readable states, and flat
background margin checks are fixture-specific. Keep those measurements alongside visual review.

## Make agy look at the captured images

Capture uses fixed inputs first. Don't ask a model to figure out how to screenshot
before giving it any pixels. Give agy a bounded **analysis-only** handoff:

```sh
PROMPT="$(python3 "$BP_SKILL/scripts/visual_evidence.py" \
  --print-agy-prompt /absolute/hermes-desk/blueprint-out/review/mascot-before-<run>)"
cd /absolute/hermes-desk && agy --model gemini-3.8-flash-medium \
  --add-dir /absolute/hermes-desk/blueprint-out/review/mascot-before-<run> \
  --print-timeout 180s --output-format json -p "$PROMPT"
```

Use only the approved non-sensitive captures. The model receives those pixels at its provider.
This prompt needs image/file reading, not shell commands or writes. Do not add blanket
permissions or `--dangerously-skip-permissions`. If image reading is denied/unavailable,
mark the review blocked and use Hermes's configured `vision_analyze` only when authorized.

Save the raw agy response separately from the capture manifest. Read `denied_actions`,
empty output, and `reviewedSheets`, not just exit zero/`status: SUCCESS`.
Import it with the evidence helper to check that returned sheets and finding image IDs
actually belong to this run:

```sh
python3 "$BP_SKILL/scripts/visual_evidence.py" \
  --import-agy-review /absolute/agy-response.json \
  --review-dir /absolute/hermes-desk/blueprint-out/review/mascot-before-<run>
```

Only mark all sheets reviewed when every expected sheet is explicitly included. Keep raw
capture evidence immutable; write visual-review results separately. The importer creates a
readable `visual-review.html` with the exact cited source frames and links it from the gallery.

## Findings that guide an actual improvement

Each finding records:

```text
id, severity, imageIds + hashes, observed problem, user impact,
proposed fix, verification, status (candidate / confirmed / resolved / persistent)
```

Look for distinguishable expressions, face readability at native small sizes, cropped
wing/helmet/letter tips, swallowed outlines on light/dark backgrounds, misplaced attachments,
start/peak/settle pose jumps, and misleadingly frozen sequences. Frozen-frame detection is
a review cue, not an automatic failure: gliding and reduced motion can intentionally be quiet.
Don't claim sampled frames prove unsampled timing, smooth 60fps playback, or frame rate.
Cross-check the code/contract before changing the product: peek intentionally hides below a
mask, reduced motion may blink, and a standalone takeoff clip returning to idle is not proof
of a broken native takeoff→flight handoff. Keep model findings as candidates until verified.
The tool pose rummages in a satchel; do not invent a handheld magnifying glass from thumbnails.

### Finding history

Use stable semantic `key` values and pass `--previous-review`. Explicit rechecks cite current
image IDs/hashes and carry `resolved`, `persistent`, `dismissed`, or `unverified`; new findings
carry `new`. A previous finding absent from the next response remains **unverified**, never
automatically resolved. Resolution/dismissal requires a complete review with the actual
matched baseline. “Resolved” is a visual judgment, not proof of native integration or behavior.
Legacy reviews without keys remain readable using their existing IDs.

## Matched re-capture and comparison

When the user asked for product improvements, pick the highest-impact **confirmed** finding,
fix it, and test that behaviour. Preserve the before report/images. Re-run the same capture
command with `--label after` and otherwise identical inputs:

```sh
node "$BP_SKILL/scripts/capture_mascot.mjs" \
  --repo /absolute/hermes-desk --label after
python3 "$BP_SKILL/scripts/visual_evidence.py" \
  /absolute/hermes-desk/blueprint-out/data/report-mascot-after-<run>.json \
  --baseline /absolute/hermes-desk/blueprint-out/data/report-mascot-before-<run>.json
```

The helper rejects changed settings, unmatched IDs/times, dimension mismatches, and tampered
images. It measures pixel differences and writes BEFORE / AFTER / DIFF panels for changed
images. Read these panels and re-review the affected sequence. A changed image does not
automatically mean an improvement. New/removed states need a deliberately updated baseline,
with the coverage change reported, not silently matched by file order.

## Completion gates

1. Capture completed with actual decoded, fresh images and explicit source/coverage.
2. All sheets inspected, with image-bound findings or an explicit "no issues found".
3. Any product fix has matched after-captures, relevant passing tests, and visual re-review.
4. The report includes the images/GIFs, actual findings/fixes, reproducible commands, and limits.

A skill-only request completes at gates 1–2 plus tested capture/comparison plumbing; product
changes require explicit authorization. Never claim "Pip improved" merely because the skill
now takes screenshots. "We captured and found candidate improvements" is the honest outcome.

## Historical smoke run (2026-10-08, v1.2)

On this machine, the production owl suite successfully wrote **191 PNGs**, then generated
**27 contact sheets**, **20 sampled GIFs**, and a gallery. Gemini Flash reviewed all 27 sheets;
five image-bound candidates were imported with current-run source hashes. Delivery-envelope
face occlusion and small-size pose distinction are candidate improvements, not shipped fixes.
The peek-disappearance claim conflicts with its intentional mask; standalone takeoff samples
do not prove a native flight-handoff bug.

Baseline run: `mascot-before-6362555e-d2aa-4784-a676-bd31e8d94167`.
Repeat run: `mascot-repeat-415f8feb-05ba-4c3e-a207-e6a05d5cee4f`.
All 191 IDs/dimensions/times matched. 184 images were pixel-identical; seven differed in
1–18 pixels each. Do not promote these captures to strict zero-diff goldens or claim perfect
pixel repeatability. The gallery is for visual inspection and measured comparison. Native
integration, continuous playback smoothness, and frame rate were not tested by this suite.

Both general browser templates were also exercised twice in real headless Chrome against an
isolated local fixture: four reports and six screenshots successfully built galleries and
matched comparisons. Before-images retained their hashes after recapture, including with a
relative `BP_OUT` override. Five Python test cases and Node syntax checks passed. Hermes loaded
the revised files in default and `nub` profiles; the existing shared-skill symlinks still emit
its outside-trusted-directory warning. No permission bypass was added.

## Verified additive improvement pass (v1.3)

The final production suite retained the original coverage and expanded it to **261 images**
per run: blended state transitions plus four normal/reduced-motion flight and home-return
chains. All **32 capture checks**, **130 mascot unit tests**, **9 isolated native integration
checks**, and **10 Python helper tests** passed, along with TypeScript and Node syntax checks.
The final review inspected **51 sheets**, including grouped before/after panels. All individual
changed-image panels remain saved. Provider responses that were empty/truncated stayed blocked;
the bounded, resumable batch review completed without replacing captures.

Preservation checks confirmed **443 existing PNG hashes**, unchanged rig/palettes/other clips,
and unchanged state/clip/reaction/palette catalogs. The skill's prior files were backed up.
Delivery eye/prop bounding-box cues fell **43.6–68.1%** across sizes and reactions; this is not
a claim of exact zero pixel occlusion. Browsing/talking/tool/error silhouettes were improved
without removing original performances or reduced motion.

The automatic ledger conservatively retains browsing when model batches conflict; the report
shows the actual silhouette improvement separately. Particle/sleep/style suggestions remain
candidates. Existing strict goldens and other app-wide Blueprint reports were not regenerated.
The updated local report is `docs/blueprint/mascot-blueprint.html`; it preserves the historical
report below an additive current-results section. Nothing was published.
