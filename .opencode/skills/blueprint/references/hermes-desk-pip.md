# Hermes Agent → agy → Hermes Desk PiP

## What this captures

This workflow captures the **floating Computer PiP**, not the main chat window, mascot/HUD,
the remote agent's desktop, or cua-driver's own experimental PiP.

Hermes Desk creates a separate Electron window in `electron/local/computer-pip.cjs` and loads
`electron/local/pip.html`. Its native title can be `Hermes Desk · Computer` or
`Computer · Hermes Desk`. The helper requires that its PID also owns a `Hermes Desk` main window.
It accepts only the `Electron` development app or packaged `Hermes Desk`, not Chrome tabs.
Never pick the largest Electron window or the first window in a list.

The Computer PiP displays the **last completed capture**, not a live Mac feed. Its age label is
the source frame's age, not this blueprint screenshot's age. Browser mocks, a standalone
`pip.html`, or a synthetic frame can test layout, but cannot prove native IPC, a completed
computer-use capture, window placement, or live-session controls.

## Prerequisites

- Hermes `terminal` runs on the same desktop host as Hermes Desk. A container/VM/SSH backend
  on another machine cannot capture the client's windows. Stop and name the host mismatch.
- `agy`, Python with Pillow, and `cua-driver` are installed on that host.
- Use an available Gemini Flash model from `agy models`, respecting the owner's model policy.
  The examples use `gemini-3.8-flash-medium`; do not silently change provider/model.
- Hermes Desk and the floating Computer PiP are already visible on the current Space.
  Ask the user to show it if absent. Capture-only work never opens sessions, changes placement,
  takes control, presses Paste, sends chat messages, or activates apps.
- The driver is running with normal permissions. Load the `cua-driver` skill and its macOS
  instructions before operating it. Check `cua-driver status` and
  `cua-driver permissions status --json`. An unknown grant status is not a grant.
  The human runs `cua-driver permissions grant` if required. Never bypass permissions or
  silently use a full-desktop screenshot.
- Images contain only user-approved, non-sensitive content. `agy` visual review sends that
  image to its configured model provider. Keep raw evidence gitignored and out of published
  media until inspected for private content.

## Install for Hermes

The canonical skill is `~/.agents/skills/blueprint/`; Claude Code uses it through
`~/.claude/skills/blueprint`. Hermes profiles get a symlink to the whole directory so helpers and
templates stay attached. Today the default profile (`~/.hermes/skills/blueprint`) and `nub`
(`~/.hermes/profiles/nub/skills/blueprint`) have it. To add another profile, never overwrite:

```sh
P=~/.hermes/profiles/<name>/skills
[ -e "$P/blueprint" ] || ln -sn ~/.agents/skills/blueprint "$P/blueprint"
```

Plain `ln -s` onto a link that already exists follows it and creates `blueprint/blueprint` inside
the skill: a loop Hermes indexed 32 times (found and removed 2026-10-21).

Start a new Hermes conversation after installing. Confirm with `hermes skills list | grep blueprint`
(or `hermes -p <name> skills list`), then `skill_view("blueprint")` and
`skill_view("blueprint", "references/hermes-desk-pip.md")`.

## Capture using agy

1. Use `terminal` to inspect `cua-driver list_windows '{}'`. Select the PID whose main-window
   title is exactly `Hermes Desk`, then find its floating PiP title. IDs change when windows reopen.
   The helper refuses missing, off-screen, off-Space, wrong-owner, and ambiguous targets.
2. Set the absolute repo/skill paths and the observed PID. Pin `--window-id` too when that PID
   has multiple matching PiPs. Confirm `blueprint-out/` is gitignored before capture.
3. Generate the bounded handoff and run one `agy` call. Shell examples belong in `terminal`:

```sh
SKILL="$HOME/.agents/skills/blueprint"
REPO="$HOME/hermes-desk"
PIP_PID=12345  # replace with the PID observed in list_windows
PROMPT="$(python3 "$SKILL/scripts/capture_pip.py" \
  --repo "$REPO" --pid "$PIP_PID" --label watching --print-agy-prompt)"
cd "$REPO" && agy --model gemini-3.8-flash-medium \
  --print-timeout 120s --output-format json -p "$PROMPT"
```

Do not add `--dangerously-skip-permissions` to make a blocked run appear successful.
If the non-interactive call needs approval, stop and report it. Do not loop account switching,
launch parallel capture workers, change models, or retry a denied call.

Unattended execution needs a **human-approved narrow** `command(<prefix>)` entry under
`permissions.allow` in agy's settings (`~/.gemini/antigravity-cli/settings.json` here).
Use the exact Python executable + absolute `capture_pip.py` path + `--repo` path from the
generated prompt as the prefix. Preserve existing rules. Never allow all Python commands,
all shell commands, `command(*)`, or a permission-bypass flag. Permission rules are not an OS
sandbox; the prompt still limits the task to read-only app inspection and evidence writes.
The separate `antigravity-vision` skill may suggest blanket bypasses and different models;
this workflow's narrower permission and Gemini Flash requirements take precedence.

The prompt tells agy to invoke the deterministic helper, then actually open its PNG with an
image-capable tool. It grants no app mutation, source edit, screenshot upload beyond the
approved model review, publish, or full-screen fallback.

For deterministic capture without model review, use the same helper without
`--print-agy-prompt`. This is a separate mode, not an automatic fallback when agy fails.

## Evidence and verification

Every helper run writes fresh, private evidence, never reusing a previous screenshot:

```text
blueprint-out/ui/pip-<label>-<unique-run>/pip.png
blueprint-out/data/report-pip-<label>-<unique-run>.json
```

The JSON contains target identity, capture timestamps, dimensions, SHA-256, `checks`, and
`errors`. A missing PiP or refused driver call produces a failed report and a nonzero exit.
The structural checks prove exact targeting and a decoded, nonblank image, **not** working
computer-use controls. `visualReview` starts `not_reviewed` and `behavioralVerification`
starts `not_tested`.

Hermes must independently read the newly written JSON and PNG. Inspect agy's `denied_actions`
and empty response as well: this CLI can return `status: SUCCESS` and exit zero while its
command was denied and no evidence was produced. Compare the actual window
title, dimensions, timestamp, and hash to the current run. An agy exit code, JSON-shaped prose,
or “screenshot saved” is not evidence. Leave `not_reviewed` if agy cannot read images.
Keep agy's visual findings separate, tied to that screenshot's hash; do not turn observations
into automated behavioural passes.

Review the entire PiP: header and agent identity, image/empty-state readability, rounded edges,
footer and source age, clipping, pointer placement, and enabled/disabled controls. Do not claim
that a screenshot of “No completed capture yet” proves a successful computer-use capture.

## State coverage for a feature pass

Capture only already authorized states or use an isolated test profile and non-sensitive fixture.
Label evidence `native-window`, `browser-fixture`, or `test-suite` in the report.

| State | What to verify | Boundary |
|---|---|---|
| No completed capture | Honest empty state, no invented frame/age | Native or fixture, label which |
| Watching with a completed capture | Readable frame, source age, current agent identity | Native completed-capture evidence needed |
| Small/resized PiP | No clipped header/footer, controls reachable | Resize only in an authorized test session |
| Action pointer | Correct placement against source-frame dimensions | Coordinate assertions + visual review |
| Unavailable permissions/driver | Honest status, no misleading live-feed claim | Test fixture, do not revoke real grants |
| User-control mode | Correct text and disabled controls | Never press Take control merely for a screenshot |
| Dock/close/reopen | Correct lifecycle and source retention | Isolated integration test, not capture-only work |

Run relevant repo tests for behaviour independently: `electron/local/computer-pip.test.mjs`,
`electron/local/pip-preload.test.mjs`, and `src/components/ComputerPip.test.tsx`, using the repo's
current test commands. Browser state tests do not replace a native floating-window capture.

## Failure handling

- **PiP missing/off-Space:** write a failed report, ask the user to show the floating Computer PiP.
  Do not capture the main window, HUD, a Chrome tab, or a stale file as a substitute.
- **Permissions unknown/denied or no daemon:** stop. Report the setup command for the human;
  do not auto-grant, change authorization mode, or silently switch capture methods.
- **Multiple matching PiPs:** require an explicit current window ID.
- **Blank/corrupt capture or target closes:** preserve the failed report; rediscover before any
  approved retry. Never reuse the old PNG.
- **agy unavailable/quota/approval/image-tool failure:** report the agy path as blocked. A direct
  capture may be offered, but does not count as an agy-verified run.
- **No Artifact tools:** deliver local report HTML + media. Publish only when requested.

## Verified setup, 2026-10-08

- Shared skill loads, including this reference and its helper, in default and `nub` Hermes profiles.
- Helper selection/image/provenance tests pass. The approved agy command prefix executes the
  helper without permission bypasses; the first denied preflight correctly produced no evidence.
- The actual agy→helper→driver preflight wrote a fresh failed report because no floating Computer
  PiP was present. **A real PiP PNG and agy visual review have not been verified yet.**
- The temporary driver service used for discovery was stopped after the preflight. Start the
  signed driver normally and verify its grants before the next live run; the direct CLI service
  reported the signed application's grant status as unknown.
