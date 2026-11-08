#!/usr/bin/env python3
"""Blueprint preflight: what exists in this repo, which mode applies, and which tools are missing.

  doctor.py [--repo PATH] [--json]

Read-only. Same output in Claude Code (Bash) and Hermes (terminal). Exit 0 always; the
verdict is in the output ("mode", "blocked"), not the exit code.
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

URL_RE = re.compile(r"https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9_-]+")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def sh(args, cwd=None):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=20)
        return r.returncode, r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def reviewed_reports(review_root):
    """Capture reports whose separate visual-review.json (visual_evidence.py --import-*) says reviewed."""
    done = set()
    for f in review_root.glob("*/visual-review.json") if review_root.is_dir() else ():
        try:
            rev = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if rev.get("visualReview") == "reviewed" and rev.get("captureReport"):
            done.add(str(Path(rev["captureReport"]).resolve()))
    return done


def latest_reports(out_dir, limit=8):
    """The newest harness reports (checks passed/total, visualReview, age) plus the total count."""
    data_dir, reviewed = out_dir / "data", reviewed_reports(out_dir / "review")
    found = []
    for p in data_dir.glob("report-*.json") if data_dir.is_dir() else ():
        try:
            rep = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(rep, dict) and isinstance(rep.get("checks"), list):
            found.append((p.stat().st_mtime, p, rep))
    found.sort(key=lambda f: f[0], reverse=True)
    out = []
    for mtime, p, rep in found[:limit]:
        checks = rep["checks"]
        out.append({
            "name": p.stem[len("report-"):], "path": str(p), "ageHours": round((time.time() - mtime) / 3600, 1),
            "passed": sum(1 for c in checks if isinstance(c, dict) and c.get("ok")), "total": len(checks),
            "visualReview": "reviewed" if str(p.resolve()) in reviewed else rep.get("visualReview"), "screenshots": len(rep.get("screenshots") or []),
        })
    return out, len(found)


def tools(repo):
    found = {
        "node": bool(shutil.which("node")), "python-pillow": importlib.util.find_spec("PIL") is not None,
        "ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")),
        "chrome": Path(CHROME).exists() or bool(shutil.which("google-chrome") or shutil.which("chromium")),
        "agy": bool(shutil.which("agy")), "cua-driver": bool(shutil.which("cua-driver")),
    }
    if found["node"]:
        # Some harnesses borrow Playwright from another checkout (BP_PLAYWRIGHT_FROM / PW_ROOT).
        roots = [repo, *(Path(os.environ[v]) for v in ("BP_PLAYWRIGHT_FROM", "PW_ROOT") if os.environ.get(v))]
        resolve = "try{require.resolve('playwright')}catch{require.resolve('playwright-core')}"
        found["playwright"] = any(sh(["node", "-e", resolve], cwd=r)[0] == 0 for r in roots if r.is_dir())
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    repo = args.repo.resolve()
    code, top = sh(["git", "rev-parse", "--show-toplevel"], cwd=repo)
    is_git = code == 0 and bool(top)
    if is_git:
        repo = Path(top)
    tb = repo / "tools" / "blueprint"
    docs = [d for d in (repo / "docs" / "blueprint", repo / "docs" / "blueprints") if d.is_dir()]
    pages = sorted(str(p.relative_to(repo)) for d in docs for p in d.glob("*.html"))
    urls = sorted({u for f in [tb / "README.md", *(p for d in docs for p in d.glob("*.md"))] if f.is_file()
                   for u in URL_RE.findall(f.read_text(errors="replace"))})
    ignored = sh(["git", "check-ignore", "-q", "blueprint-out/x"], cwd=repo)[0] == 0
    _, head = sh(["git", "log", "-1", "--format=%h %cs %s"], cwd=repo)
    _, dirty = sh(["git", "status", "--porcelain"], cwd=repo)
    t = tools(repo)
    result = {
        "repo": str(repo), "head": head, "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        "harness": sorted(p.name for p in tb.iterdir() if p.is_file()) if tb.is_dir() else [],
        "reports": pages, "publishedUrls": urls, "blueprintOutIgnored": ignored,
        "tools": t,
    }
    result["latestRuns"], result["reportCount"] = latest_reports(repo / "blueprint-out")
    result["mode"] = "feature-pass or refresh" if tb.is_dir() or pages else "bootstrap"
    blocked = [k for k in ("node", "python-pillow", "chrome", "playwright") if k in t and not t[k]]
    result["blocked"] = blocked
    notes = []
    if (tb.is_dir() or pages) and not ignored:
        notes.append("blueprint-out/ is not gitignored: add it before the next run")
    if pages and not urls:
        notes.append("no published URL recorded; ask before publishing, then write it into tools/blueprint/README.md")
    runs = result["latestRuns"]
    if runs and runs[0]["ageHours"] > 24:
        notes.append(f"newest report is {runs[0]['ageHours']}h old: re-run the harness before quoting any number")
    pending = [r["name"] for r in runs if r["screenshots"] and r["visualReview"] in ("pending", "not_reviewed", None)]
    if pending:
        notes.append(f"screenshots not marked reviewed: {', '.join(pending)}")
    result["notes"] = notes

    if args.json:
        print(json.dumps(result, indent=2))
        return
    print(f"repo      {repo}  ({head or ('no commits yet' if is_git else 'not a git repo')}; {result['dirtyFiles']} uncommitted)")
    print(f"mode      {result['mode']}")
    print(f"harness   {', '.join(result['harness']) or 'none (tools/blueprint/ missing)'}")
    print(f"reports   {', '.join(pages) or 'none'}")
    print(f"published {', '.join(urls) or 'none recorded'}")
    print(f"runs      {result['reportCount']} report JSONs in blueprint-out/data; newest:")
    for r in runs:
        print(f"  {r['name']}: {r['passed']}/{r['total']} checks, {r['screenshots']} shots, "
              f"visual {r['visualReview'] or '-'}, {r['ageHours']}h old")
    print("tools     " + "  ".join(f"{k}:{'ok' if v else 'MISSING'}" for k, v in t.items()))
    if blocked:
        notes.append(f"blocked until installed: {', '.join(blocked)}"
                     + (" (or set BP_PLAYWRIGHT_FROM to a checkout that has it)" if "playwright" in blocked else ""))
    for n in notes:
        print(f"note      {n}")


if __name__ == "__main__":
    sys.exit(main())
