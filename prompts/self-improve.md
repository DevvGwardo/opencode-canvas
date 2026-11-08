# Self-improvement loop prompt

Paste the block below (everything inside the `<prompt>` fence) into the session's
Loop field, or run it as:

```
/loop <paste> --count 40 --delay 5s --stop LOOP-IDLE
```

Use `--stop LOOP-IDLE` so the loop ends by itself once there is nothing left
worth doing. Leave `--continue-on-error` off: a failed run should stop the loop
so broken work is noticed instead of compounded.

---

<prompt>

You are running inside an unattended improvement loop on the **OpenCode Canvas**
repository in this working directory. This exact prompt is re-sent every time the
previous run goes idle. Treat each delivery as **one self-contained improvement
cycle**: do exactly one meaningful change, verify it, commit it, and stop. Do not
batch multiple unrelated changes into one cycle — the loop is your iteration
budget, not one turn.

## Ground rules (apply to every cycle)

- Keep the project **dependency-free**: no new runtime dependencies.
- Follow `CONTRIBUTING.md`: keep layouts, formatting and status logic as **pure
  functions** with tests in `test/`.
- Never break existing public behavior without replacing it with something better.
- Never run destructive or irreversible commands: no `git push`, no history
  rewrite, no `git checkout .`, no mass deletes, no touching `.git` config or
  credentials. Do not "fix" the working tree by discarding changes.
- The working tree may already contain uncommitted work from earlier cycles or
  from the human. **Never revert or reformat files you did not touch this cycle.**
  Stage only the specific files your change needs.
- Prefer small, reversible, well-tested edits over broad refactors. If a change
  can't be verified automatically, it must be justified in the log.

## Step 0 — Orient (cheap, do it every cycle)

1. Read `CONTRIBUTING.md` and the "How it works" section of `README.md`.
2. Run `git status --short` and `git log --oneline -15`.
3. Read `LOOP_LOG.md` if it exists. It is your memory across cycles: it lists
   what previous cycles already did and any queued candidates. **Never redo a
   logged change.**
4. Run `bun run typecheck` and `bun test`.

If the baseline is already red, this cycle's only job is to make it green again;
log that and stop. If the baseline is green, continue.

## Step 1 — Choose exactly ONE improvement

Pick the single highest-value, self-contained improvement you can fully verify
this cycle. Prefer candidates already queued in `LOOP_LOG.md`. Otherwise draw from
this priority order and sweep it left to right across cycles rather than always
tuning the same area:

1. **Correctness** — real bugs, edge cases, race conditions, off-by-one, unhandled
   empty/undefined states in `src/app/*` and `src/server/*`.
2. **Test coverage** — pure functions and parsers with no tests yet (camera math,
   layout geometry, `format.ts`, status logic, `loops.ts` arg parsing, `commands.ts`,
   `models.ts`). New tests must assert real behavior, not just that code runs.
3. **Robustness** — error handling, reconnect/resync paths, input validation,
   backpressure, cleanup on teardown.
4. **Accessibility** — keyboard reachability, focus management, ARIA roles/labels,
   contrast, motion-reduction.
5. **Performance** — viewport culling, lazy preview loading, render thrash,
   redundant work in hot paths. Measure or reason explicitly; do not guess.
6. **Docs drift** — README/CONTRIBUTING statements that no longer match the code
   (or code that should be documented). If you add an OpenCode endpoint, list it
   in the README's "How it works" section.
7. **Code health** — remove genuine dead code, collapse duplication, sharpen names
   and types. Only when it is safe and covered by tests.

**Reject** the candidate and pick another if it requires a large refactor, changes
public behavior speculatively, or cannot be verified. Keep the whole cycle's diff
roughly under ~150 changed lines. Add or update a test whenever you change logic.

## Step 2 — Implement and verify

- Make the change, matching the style, naming and structure of surrounding code.
- `bun run typecheck` — must pass.
- `bun test` — must pass, with no new skipped/failing tests.
- If the change is only observable in the UI, reason through it via `bun run demo`
  (`?demo=1`) or note precisely how you validated it. Do not claim a UI change
  works if you did not check it.
- If verification fails and you cannot fix it cleanly within this cycle, revert
  just your own edits and log the attempt as blocked — leave the tree green.

## Step 3 — Record and commit

- Append one short entry to `LOOP_LOG.md` (create it on first use), newest at the
  bottom, in this shape:

  ```
  ## <date> — <area>
  - Changed: <one line>
  - Files: <paths>
  - Verified: typecheck ✓, tests ✓ (<n> passing)
  - Candidates: <optional short queued ideas for future cycles>
  ```

- Commit only the files this cycle touched, with a conventional message
  (`feat:`, `fix:`, `test:`, `docs:`, `perf:`, `refactor:`, `a11y:`, `chore:`).
  Do not `git add -A`.

## Step 4 — Report and signal

Reply with a short summary (roughly five lines): chosen area, what changed, files,
verification result, and the next candidate you queued.

Then decide:

- If you completed a cycle, **end your reply without the word `LOOP-IDLE`** so the
  loop runs again.
- If there is genuinely no remaining improvement that is meaningful *and*
  verifiable without large refactors — or the baseline is unfixable and needs a
  human decision — reply with exactly this as the final line:

  ```
  LOOP-IDLE
  ```

  (`LOOP-IDLE` is the configured stop phrase. Only emit it when you truly want the
  loop to end. Never include it in a normal cycle summary, and never write it into
  `LOOP_LOG.md`.)

## Anti-oscillation

If a previous cycle already changed an area, do not undo or re-tune it unless you
have concrete evidence it is wrong (a failing test, a clear bug) — in that case,
explain the evidence in the log entry.

</prompt>
