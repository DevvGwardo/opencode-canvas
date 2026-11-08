---
name: hillclimb
description: Iterative hill-climbing loop for opencode goals. Use when the user says hillclimb, climb this, iterate to improve, keep improving until plateau, or wants repeated score-driven variants with keep-best and revert on regression.
when_to_use: Use when the user says "hillclimb", "climb", "hill climbing", "run a goal with hill climbing", "iterate to improve", "keep improving until it plateaus", or wants a scalar score maximized over repeated variants instead of a single pass/fail goal.
version: 1.0.0
triggers:
  - hillclimb
  - hill climbing
  - climb this
  - iterate to improve
  - keep improving
  - until plateau
author: devgwardo
metadata:
  opencode:
    tags: [iteration, optimization, goals, evals, hill-climbing]
    category: software-development
    related_skills: [goal]
---

# Hillclimb

A hillclimb wraps a `/goal` with a **score-driven keep-best loop**: propose one small
variant, measure it with a deterministic score command, keep it only if the score
strictly improves, otherwise revert. Repeat until the score plateaus or the budget
runs out.

Like `blueprint`, this skill ships two things:

1. **The harness** (in the repo, `tools/hillclimb/`): a score command, a contract,
   and a ledger that record every attempt and prove which variant won.
2. **The discipline**: one variant at a time, always measured, never estimated.

The point is trust: a reader can see every attempt, every score, what was kept,
what was reverted, and reproduce the winning score.

## When to use

- The user says "hillclimb", "climb this", "hill climbing", "run a goal with
  hill climbing", "iterate to improve", or "keep improving until it plateaus".
- They have (or want) a scalar objective to maximize: benchmark score, pass count,
  Lighthouse score, accuracy, win rate, throughput, coverage — anything a command
  can print as a number.
- Not for single pass/fail work: use `/goal` alone when the end state is just
  "tests exit 0". Use hillclimb when "passing" is not enough and higher is better.

## Start here

The skill lives beside this file. Every command below works from any shell with
`python3` (stdlib only, no dependencies):

```sh
HC_SKILL=.opencode/skills/hillclimb   # this repo; global installs use ~/.agents/skills/hillclimb
python3 "$HC_SKILL/scripts/doctor.py" --repo /path/to/repo
```

`doctor.py` is read-only. It reports whether a climb contract exists, whether the
score command runs and parses, how many attempts the ledger holds, what the best
score is, and what is missing. Read its notes before planning.

| Need | Command |
|---|---|
| Preflight | `python3 "$HC_SKILL/scripts/doctor.py" --repo . [--json]` |
| Start a climb | `python3 "$HC_SKILL/scripts/climb.py" init --repo . --task "..." --score-cmd "..." --budget 20` |
| Log an attempt | `python3 "$HC_SKILL/scripts/climb.py" record --repo . --score 81.5 --hypothesis "..." --files "src/a.ts" --verdict keep\|revert` |
| Winner / totals | `python3 "$HC_SKILL/scripts/climb.py" best --repo .` / `... tally --repo .` |
| Tests for the harness | `python3 -m pytest -q -p no:cacheprovider "$HC_SKILL/scripts"` |

Paths inside the skill are relative to the directory containing `SKILL.md`.
Global installs are identical copies: `~/.agents/skills/hillclimb/` (also readable
as `~/.config/opencode/skills/hillclimb/`).

## The two contracts (lock both before iterating)

`climb.py init` writes `tools/hillclimb/contract.json`:

1. **Goal contract** (same three elements as `/goal`): Task, Measurable End State
   (the gate that must stay green, e.g. `bun test` exits 0), Constraints (files
   that must not be touched, perf budgets, safety invariants).
2. **Score contract**: `scoreCmd` (the one command whose number decides),
   `direction` (`higher` is better; lower-is-better metrics must be negated at the
   harness level so the loop only ever maximizes), `epsilon` (minimum delta that
   counts as an improvement, default `1e-9`), `budget` (max attempts, default 20),
   `plateau` (stop after N consecutive non-improving attempts, default 3).

Rules for the score command:

- **One number wins.** It must print `SCORE=<float>` on stdout (a `score.sh`
  template is in `templates/`). Extra `KEY=value` lines are kept as metadata.
- **Deterministic.** Same tree + same seed = same score. Pin seeds, isolate caches,
  average only with a fixed sample count recorded in the ledger.
- **Independent of the code it measures.** The score script lives in
  `tools/hillclimb/` and is frozen after `init` (hash recorded). Changing the
  scorer mid-climb invalidates every prior score — re-baseline instead.
- **Gated.** The goal's end-state checks run with every score. A higher score with
  a red gate is a revert, never a keep.

## The loop (executor <-> scorer, one variant per turn)

For each attempt until the budget or plateau stops the climb:

1. **Baseline once.** Run the score command on the clean tree, `record` it with
   verdict `baseline`. This is the score to beat.
2. **Hypothesize & act.** Propose exactly one minimal variant aimed at raising
   the score (see `references/operators.md` for the operator menu). Touch the
   fewest files that can test the hypothesis.
3. **Measure.** Run the score command plus the gate checks. Parse the full output.
4. **Keep or revert.** `keep` iff `score > best + epsilon` AND all gates pass AND
   no constraint broke. Otherwise `revert` the tree to the best-known state
   (`git stash` / `git checkout -- <files>` on exactly the files you touched —
   never `git reset --hard` without a clean `git status` check first).
5. **Log.** Every attempt is one `record` call: hypothesis, files changed, score
   before → after, delta, verdict. No silent attempts.

Stop when: `plateau` consecutive reverts, attempts hit `budget`, wall-clock hits
the contract's `maxMinutes`, or the same error signature repeats twice in a row
(duplicate-state halt — report the blocker instead of looping).

## Trace-driven performance (automatic hotspot climbs)

Hillclimb maximizes a number; traces tell it *where* to look. Full workflow:
`references/profiling.md`. Short version:

```sh
python3 "$HC_SKILL/scripts/hotspots.py" prof.folded --top 10        # or --format chrome prof.cpuprofile
```

Capture a baseline profile of the real workload, rank hotspots (self = optimize
the leaf, total = stop calling the subtree), freeze `templates/score-perf.sh` as
the scorer, attack the top frame one operator per attempt, re-profile after every
keep. A faster SCORE with the hotspot gone is real; a faster SCORE with the same
hotspot on top is timer noise — revert it.

## Anti-gaming gates (mandatory, same spirit as `/goal`)

- **Immutable yardstick.** You are STRICTLY FORBIDDEN from raising the score by
  editing `tools/hillclimb/score.*`, weakening test assertions, skipping tests,
  disabling linter/compiler flags, or hard-coding fixture answers — unless the
  user's explicit task was to change the scorer. `doctor.py` records the scorer
  hash at `init`; `tally` fails if it drifted.
- **No fixture memorization.** The variant must improve the mechanism, not the
  measurement. A score jump with no plausible causal link to the changed code is
  a revert pending a held-out check.
- **Oscillation breaker.** Maximum **4 autonomous variants per turn** without
  asking. Same error signature twice, or proposing a previously reverted diff,
  HALTs the loop.
- **Non-destructive workspace.** Never `git reset --hard`, `git clean -fd`, or
  `git checkout -- .` without checking `git status` first; never destroy
  pre-existing uncommitted user changes. Revert only files your attempt touched.
- **Timeouts on everything.** Wrap score commands with a timeout so hung
  benchmarks cannot deadlock the session.

## Repo layout (created by `init`)

```
tools/hillclimb/
  contract.json    # goal + score contract (frozen scorer hash)
  ledger.json      # every attempt + best pointer (append-only; never rewrite history)
  score.sh         # the score harness (prints SCORE=<float>)
```

Add nothing here to `.gitignore` — the ledger is evidence and must be committed.
Large raw outputs (profiles, traces) go to `hillclimb-out/` (gitignored) and are
referenced by path from the ledger's `detail` field.

## Templates and references

- `templates/score.sh`: minimal harness skeleton (prints `SCORE=`, exits non-zero
  when the gate fails).
- `templates/contract.json`: contract skeleton with budget/plateau/epsilon defaults.
- `references/operators.md`: the variant operator menu (shrink, widen, cache,
  reorder, specialize, remove), acceptance math, and plateau/budget guidance.

## Files in this skill

Paths are relative to `$HC_SKILL`:

- `scripts/doctor.py`: read-only preflight (contract, scorer hash, ledger state, tools).
- `scripts/climb.py`: `init` / `record` / `best` / `tally` for the ledger.
- `scripts/hotspots.py`: rank CPU-profile hotspots (`folded` stacks or `--format chrome` for `node --cpu-prof`).
- `scripts/test_climb.py`, `scripts/test_hotspots.py`: harness tests (`pytest -q scripts/`).
- `templates/score.sh`, `templates/contract.json`: starting points copied by `init`.
- `templates/score-perf.sh`: throughput scorer template for perf climbs (`WORKLOAD_CMD`, `SAMPLES`).
- `references/profiling.md`: trace → hotspot → attack workflow and honest-perf rules.
