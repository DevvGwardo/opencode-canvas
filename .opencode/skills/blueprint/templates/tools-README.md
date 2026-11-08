# Blueprint harness

Browser sweeps that produce every screenshot, output file and number in the blueprint
(`docs/blueprint/<project>-blueprint.html`).

Published at <ARTIFACT URL> (version <N>, <DATE>). Local page ahead of the published one: <yes/no>.

They drive the real app in Chrome (Playwright) against the dev server and write raw evidence to
`blueprint-out/` (gitignored; override with `BP_OUT=/path`, the app with `APP_URL=...`, extra
allowed hosts with `BP_ALLOW_HOSTS`; every other host is blocked and listed in the report).

| Script | What it checks and captures |
|---|---|
| `sweep.mjs` | every UI state, the output matrix, performance, edge cases, phone width |
| `exports.mjs` | real outputs through the real UI, verified with an external tool |
| `<feature>.mjs` | one script per feature pass |
| `findings.json` | the findings ledger (`id, area, sev, eff, status, since, title, ev, why, fix, sha, now, files`) |

Run them one after another (never in parallel; perf numbers skew and logs clobber):

```sh
BP_SKILL=~/.agents/skills/blueprint
python3 "$BP_SKILL/scripts/doctor.py"            # what exists, what's stale, what's missing
python3 "$BP_SKILL/scripts/devserver.py" start --url http://localhost:5199/ --expect "<app title>" -- npx vite --port 5199
export APP_URL=http://localhost:5199/
for s in sweep <feature> exports; do node tools/blueprint/$s.mjs || echo "$s FAILED"; done
python3 "$BP_SKILL/scripts/devserver.py" stop --url http://localhost:5199/
```

Each script prints its fresh `blueprint-out/data/report-<script>-<run>.json` path
({checks, perf, errors, screenshots, blockedHosts}) and exits non-zero on any failed check.
Images live under `ui/<run>/`; repeat runs preserve the before report and images.
Read the printed report path instead of guessing or using a stale fixed-name report.

Then fill the page's counts from exactly those reports (never type a number by hand):

```sh
python3 "$BP_SKILL/scripts/tally.py" <printed report paths> \
  --findings tools/blueprint/findings.json --fill docs/blueprint/<project>-blueprint.html
```

Visual passes are not done after the tests: build contact sheets with
`python3 "$BP_SKILL/scripts/visual_evidence.py" <report.json>`, actually open the images, and
record image-bound findings. Fix only authorized product issues, then capture matched after
states and compare with `--baseline <before-report.json>`. `visualReview: pending` means the
visual review has not happened; it is not a green result.

View the page locally (diagrams render without a publisher):
`python3 -m http.server 8765 -d docs/blueprint`, then open `http://localhost:8765/<project>-blueprint.html`.
