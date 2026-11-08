#!/usr/bin/env python3
"""Verify preflight: config, feature map, newest proof reports, tools.

  doctor.py [--repo PATH] [--json]

Read-only. Exit 0 always; the verdict is in the output, not the exit code.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def sh(args, cwd=None, timeout=20):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def main():
    ap = argparse.ArgumentParser(description="verify preflight")
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    repo = a.repo.resolve()
    code, top = sh(["git", "rev-parse", "--show-toplevel"], cwd=repo)
    if code == 0 and top:
        repo = Path(top)
    vd = repo / "tools" / "verify"
    cfg, fmap = vd / "config.json", vd / "feature-map.md"
    gates = None
    if cfg.is_file():
        try:
            gates = [g.get("name", "?") for g in json.loads(cfg.read_text())["gates"]]
        except (ValueError, KeyError):
            gates = ["PARSE-ERROR"]
    data = repo / "verify-out" / "data"
    reports = sorted(data.glob("report-*.json")) if data.is_dir() else []
    newest = None
    if reports:
        try:
            rep = json.loads(reports[-1].read_text())
            newest = {"path": reports[-1].name, "passed": rep.get("passed"), "total": rep.get("total")}
        except (OSError, ValueError):
            newest = {"path": reports[-1].name, "passed": "?", "total": "?"}
    _, ignored = sh(["git", "check-ignore", "-q", "verify-out/x"], cwd=repo), None
    ignored = sh(["git", "check-ignore", "-q", "verify-out/x"], cwd=repo)[0] == 0
    notes = []
    if not cfg.is_file():
        notes.append("no config: run verify.py init --repo .")
    if not fmap.is_file():
        notes.append("no feature map: run verify.py init --repo . (stale maps misroute agents)")
    if (vd.is_dir() or reports) and not ignored:
        notes.append("verify-out/ is not gitignored: add it before the next run")
    result = {"repo": str(repo), "config": cfg.is_file(), "gates": gates,
              "featureMap": fmap.is_file(), "reports": len(reports),
              "newest": newest, "verifyOutIgnored": ignored,
              "tools": {"python3": bool(shutil.which("python3")), "git": code == 0},
              "notes": notes}
    if a.json:
        print(json.dumps(result, indent=2))
        return 0
    _, head = sh(["git", "log", "-1", "--format=%h %cs %s"], cwd=repo)
    print(f"repo      {repo}  ({head or 'not a git repo'})")
    print(f"config    {'present: ' + ', '.join(gates) if gates else 'MISSING'}")
    print(f"map       {'present' if fmap.is_file() else 'MISSING'}")
    print(f"proof     {len(reports)} reports" + (f", newest {newest['path']}: {newest['passed']}/{newest['total']}" if newest else ""))
    for n in notes:
        print(f"note      {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
