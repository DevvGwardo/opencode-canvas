#!/usr/bin/env python3
"""Blueprint tally: every count on the report page, computed from this run's report JSONs.

  tally.py REPORT.json [REPORT.json ...] [--findings findings.json] [--fill PAGE.html] [--json]

Pass the report paths the harness printed in this run (never a stale glob). Prints totals and,
with --findings, ledger counts plus lint (open items with no fix, fixed items with no sha,
duplicate ids). --fill rewrites marked regions of the page in place:

  <!--bp:checks-->412 / 415<!--/bp:checks-->      also: checks-failed, checks-rows, perf-rows,
  <!--bp:checks-rows--> … <!--/bp:checks-rows-->  shots, console-errors, findings-open,
  findings-fixed, findings-total, findings-rows, generated

Unknown or missing regions are reported, never invented. Exit 1 when a check failed, the
ledger has lint errors, or --fill found no regions; 0 otherwise.
"""
import argparse
import html
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import date
from pathlib import Path

REGION = re.compile(r"(<!--bp:([a-z-]+)-->)(.*?)(<!--/bp:\2-->)", re.S)
SEV_ORDER = ["critical", "high", "medium", "med", "low", "info"]


def pick(item, *keys, default=""):
    """Ledgers name the same field differently (sev/severity, ev/anchor/evidence…)."""
    for k in keys:
        if item.get(k) not in (None, ""):
            return item[k]
    return default


def load_reports(paths):
    reports = []
    for p in paths:
        rep = json.loads(Path(p).read_text())
        if not isinstance(rep.get("checks"), list):
            raise SystemExit(f"{p}: no checks[]; is this a harness report?")
        name = rep.get("script") or rep.get("name") or re.sub(r"^report-", "", Path(p).stem)
        name = re.sub(r"-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})$", "", str(name))
        reports.append((str(p), name, rep))
    return reports


def ledger(path):
    if not Path(path).is_file():
        raise SystemExit(f"tally.py: no ledger at {path}; drop --findings if this repo has none")
    items = json.loads(Path(path).read_text())
    items = items.get("findings", items) if isinstance(items, dict) else items
    lint, seen = [], Counter(str(pick(f, "id")) for f in items)
    lint += [f"duplicate id {i}" for i, n in seen.items() if n > 1]
    for f in items:
        fid, status = pick(f, "id", default="?"), str(pick(f, "status", default="open")).lower()
        if status in ("open", "partial") and not pick(f, "fix", "proposedFix"):
            lint.append(f"{fid}: {status} with no fix")
        if status == "fixed" and not pick(f, "sha", "commit"):
            lint.append(f"{fid}: fixed with no sha")
        if not pick(f, "ev", "anchor", "evidence", "imageIds"):
            lint.append(f"{fid}: no evidence anchor")
    return items, lint


def tally(reports, findings):
    checks = [(name, c) for _, name, rep in reports for c in rep["checks"] if isinstance(c, dict)]
    out = {
        "reports": [{"path": p, "name": n, "passed": sum(bool(c.get("ok")) for c in r["checks"]),
                     "total": len(r["checks"])} for p, n, r in reports],
        "passed": sum(bool(c.get("ok")) for _, c in checks), "total": len(checks),
        "failed": [{"report": n, "name": c.get("name"), "detail": text(c.get("detail", ""))} for n, c in checks if not c.get("ok")],
        "screenshots": sum(len(r.get("screenshots") or []) for _, _, r in reports),
        "consoleErrors": sum(len(r.get("errors") or []) for _, _, r in reports),
        "perf": {f"{n}.{k}": v for _, n, r in reports for k, v in (r.get("perf") or {}).items()},
    }
    if findings is not None:
        items, lint = findings
        status = Counter(str(pick(f, "status", default="open")).lower() for f in items)
        open_items = [f for f in items if str(pick(f, "status", default="open")).lower() in ("open", "partial")]
        out["findings"] = {
            "total": len(items), "byStatus": dict(status),
            "openBySeverity": dict(Counter(str(pick(f, "sev", "severity", default="?")).lower() for f in open_items)),
            "lint": lint,
        }
        out["_items"] = items
    return out, checks


def text(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def regions(t, checks, where="."):
    e = html.escape
    rows = "\n".join(
        f'<tr><td>{e(str(n))}</td><td>{e(str(c.get("name", "")))}</td><td>{e(text(c.get("detail", "")))}</td>'
        f'<td><span class="pill {"ok" if c.get("ok") else "bad"}">{"pass" if c.get("ok") else "FAIL"}</span></td></tr>'
        for n, c in checks)
    perf = "\n".join(f"<tr><td><code>{e(k)}</code></td><td>{e(text(v))}</td></tr>" for k, v in t["perf"].items())
    head = subprocess.run(["git", "-C", str(where), "log", "-1", "--format=%h"], capture_output=True, text=True).stdout.strip()
    r = {
        "checks": f"{t['passed']} / {t['total']}", "checks-failed": str(t["total"] - t["passed"]),
        "checks-rows": rows, "perf-rows": perf, "shots": str(t["screenshots"]),
        "console-errors": str(t["consoleErrors"]),
        "generated": f"{date.today().isoformat()}" + (f" · {head}" if re.fullmatch(r"[0-9a-f]{7,}", head or "") else ""),
    }
    if "findings" in t:
        f, items = t["findings"], t["_items"]
        by = f["byStatus"]
        r["findings-total"] = str(f["total"])
        r["findings-fixed"] = str(by.get("fixed", 0))
        r["findings-open"] = str(by.get("open", 0) + by.get("partial", 0))
        key = lambda i: (SEV_ORDER.index(str(pick(i, "sev", "severity")).lower()) if str(pick(i, "sev", "severity")).lower() in SEV_ORDER else 9, str(pick(i, "id")))
        r["findings-rows"] = "\n".join(
            f'<tr><td>{e(str(pick(i, "id")))}</td><td>{e(str(pick(i, "sev", "severity")))}</td><td>{e(str(pick(i, "eff", "effort")))}</td>'
            f'<td>{e(str(pick(i, "title", "issue")))}</td><td><code>{e(str(pick(i, "ev", "anchor", "evidence")))}</code></td>'
            f'<td>{e(str(pick(i, "fix", "proposedFix")))}</td><td>{e(str(pick(i, "status", default="open")))}</td></tr>'
            for i in sorted(items, key=key))
    return r


def fill(page, values):
    src = Path(page).read_text()
    found, unknown = [], []

    def sub(m):
        name = m.group(2)
        if name not in values:
            unknown.append(name)
            return m.group(0)
        found.append(name)
        v = values[name]
        return m.group(1) + (f"\n{v}\n" if "\n" in v or v.startswith("<tr") else v) + m.group(4)

    new = REGION.sub(sub, src)
    if new != src:
        Path(page).write_text(new)
    return found, unknown


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("reports", nargs="+", type=Path)
    ap.add_argument("--findings", type=Path)
    ap.add_argument("--fill", type=Path)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    t, checks = tally(load_reports(a.reports), ledger(a.findings) if a.findings else None)
    status = 1 if t["failed"] or t.get("findings", {}).get("lint") else 0
    if a.fill:
        found, unknown = fill(a.fill, regions(t, checks, a.fill.resolve().parent))
        t["filled"], t["unknownRegions"] = found, unknown
        if not found:
            status = 1
    if a.json:
        print(json.dumps({k: v for k, v in t.items() if k != "_items"}, indent=2))
        return status
    for r in t["reports"]:
        print(f"{r['passed']:>4}/{r['total']:<4} {r['name']}  ({r['path']})")
    print(f"checks    {t['passed']}/{t['total']} passed, {len(t['failed'])} failed")
    for f in t["failed"]:
        print(f"  FAIL {f['report']}: {f['name']} {f['detail']}")
    print(f"evidence  {t['screenshots']} screenshots, {t['consoleErrors']} console errors")
    if "findings" in t:
        f = t["findings"]
        print(f"findings  {f['total']} total {f['byStatus']}; open by severity {f['openBySeverity']}")
        for l in f["lint"][:20]:
            print(f"  lint {l}")
        if len(f["lint"]) > 20:
            print(f"  lint … {len(f['lint']) - 20} more")
    if a.fill:
        print(f"filled    {', '.join(t['filled']) or 'NO REGIONS FOUND'} in {a.fill}")
        if t["unknownRegions"]:
            print(f"unknown   {', '.join(t['unknownRegions'])} (left unchanged)")
    return status


if __name__ == "__main__":
    sys.exit(main())
