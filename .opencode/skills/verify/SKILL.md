---
name: verify
description: Verification skill for opencode agents. Use when the user says verify, verification skill, prove it works, run the real app and show proof, feature map, or wants agent changes gated on empirical evidence instead of claims.
when_to_use: Use when the user says "verify", "verification skill", "prove it works", "run the real app", "show proof", "feature map", or wants a maintained verify CLI plus gates so agents verify their own work the same way every run.
version: 1.0.0
triggers:
  - verify
  - verification skill
  - prove it works
  - run the real app
  - show proof
  - feature map
  - control glass
author: devgwardo
metadata:
  opencode:
    tags: [verification, gates, evidence, ci, debugging]
    category: software-development
    related_skills: [hillclimb, blueprint]
---

# Verify

A verification skill makes the agent **prove its change works in the real app**,
not claim it. It ships two things (same shape as `blueprint` and `hillclimb`):

1. **The CLI** (in the repo, `tools/verify/`): a maintained `verify run` that
   executes the repo's gates (typecheck, lint, tests, build, smoke) the same way
   every run, captures the proof to `verify-out/`, and exits non-zero on failure.
   Agents never improvise their own harness.
2. **The feature map** (`tools/verify/feature-map.md`): a living doc of what
   features exist and **how to reach them** (routes, selectors, shortcuts,
   fixtures). It turns vague tasks ("screenshot + ???") into concrete repros.

Inspired by poteto's "verification skills" talk (Control Glass: drive the app
over CDP, take traces/heap snapshots, collect proof) and her 5-layer ladder —
see `references/ladder.md`.

## When to use

- The user says "verify", "prove it works", "run the real app and show proof".
- An agent change needs gates before it counts: green checks plus a proof report.
- A vague bug report needs grounding: look up the feature map, reproduce first.
- As the **gate inside a hillclimb**: `--gate "verify run"` so a faster score
  with a red gate is a revert, never a keep.

## Start here

```sh
V_SKILL=.opencode/skills/verify   # global installs use ~/.agents/skills/verify
python3 "$V_SKILL/scripts/doctor.py" --repo /path/to/repo
python3 "$V_SKILL/scripts/verify.py" init --repo /path/to/repo
python3 "$V_SKILL/scripts/verify.py" run --repo /path/to/repo
```

`doctor.py` is read-only: config present, feature map present, newest proof
reports, missing tools. `verify.py run` prints one line per gate plus the proof
report path, and exits 1 when anything fails.

| Need | Command |
|---|---|
| Preflight | `python3 "$V_SKILL/scripts/doctor.py" --repo . [--json]` |
| Scaffold gates + map | `python3 "$V_SKILL/scripts/verify.py" init --repo .` |
| Verify (the gate) | `python3 "$V_SKILL/scripts/verify.py" run --repo .` |
| Harness tests | `python3 -m pytest -q -p no:cacheprovider "$V_SKILL/scripts"` |

## The two artifacts (both committed, both living)

`verify.py init` writes:

```
tools/verify/
  config.json      # gates: [{name, cmd, timeout}] — the repo's real checks
  feature-map.md   # features × how to reach them (routes, selectors, fixtures)
```

- **config.json**: every gate the change must pass. Order matters: fast static
  gates first (typecheck, lint), then tests, then build, then smoke. Each gate
  is one command with a timeout; a timeout is a failure, not a skip.
- **feature-map.md**: one row per feature — what it is, how a user reaches it,
  what "working" looks like. Update it when the UI/routes change; a stale map
  sends agents down paths that no longer exist. Template in `templates/`.

Proof reports go to `verify-out/data/report-<timestamp>.json`
(`{gates: [{name, ok, exit, elapsed, tail}], passed, total}`) — gitignored raw
evidence, referenced from PRs and hillclimb ledgers. Add `verify-out` to
`.gitignore`. The config and feature map are evidence of *process* and stay
committed.

## Rules

- **Run the real thing.** Gates execute the repo's actual checks against the
  real app/build, never a mock of them. A green mock proves nothing.
- **Same CLI every run.** If two sessions verify differently, the skill is
  broken — fix `config.json`, don't hand-roll commands.
- **A failing gate is a finding, not a gate to delete.** Same ban as `/goal` and
  hillclimb: no weakening assertions, no skipping tests, no disabling
  linter/compiler flags unless the task explicitly is to change them.
- **Reproduce before fixing.** Vague report → feature map → concrete repro steps
  → then touch code. The repro becomes a gate so the bug can't return.
- **Push corrections down the ladder** (`references/ladder.md`): when you
  correct the agent twice for the same mistake, encode it — architecture first,
  then lint/compiler/CI, then rules, and only then prose.

## Files in this skill

Paths are relative to `$V_SKILL`:

- `scripts/verify.py`: `init` (scaffold config + map) / `run` (execute gates, write proof report).
- `scripts/doctor.py`: read-only preflight (config, map, newest reports, tools).
- `scripts/test_verify.py`: harness tests (`pytest -q scripts/`).
- `templates/config.json`, `templates/feature-map.md`: starting points copied by `init`.
- `references/ladder.md`: the 5-layer correction ladder.
