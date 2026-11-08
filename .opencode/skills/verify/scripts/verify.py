#!/usr/bin/env python3
"""Maintained verify CLI: run the repo's gates the same way every time.

  verify.py init --repo . [--force]
  verify.py run  --repo . [--config PATH]

run executes every gate in tools/verify/config.json sequentially with timeouts,
writes a proof report to verify-out/data/report-<timestamp>.json, prints one
line per gate plus the report path, and exits 1 when anything fails.
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SKILL_TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
TAIL_LINES = 20


def repo_root(p):
    p = Path(p).resolve()
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=p,
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return p


def cmd_init(a):
    repo = repo_root(a.repo)
    vd = repo / "tools" / "verify"
    vd.mkdir(parents=True, exist_ok=True)
    wrote = []
    for name in ("config.json", "feature-map.md"):
        dest = vd / name
        if dest.exists() and not a.force:
            print(f"keep      {dest.relative_to(repo)} (exists; --force to overwrite)")
            continue
        dest.write_text((SKILL_TEMPLATES / name).read_text())
        wrote.append(str(dest.relative_to(repo)))
    if wrote:
        print(f"init      wrote {', '.join(wrote)} — edit the gates to match this repo, then run: verify.py run --repo .")
    return 0


def run_gate(gate, cwd):
    name = gate.get("name", "?")
    cmd = gate.get("cmd", "")
    try:
        timeout = float(gate.get("timeout", 300))
    except (TypeError, ValueError):
        timeout = 300
    start = time.time()
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True,
                           text=True, timeout=timeout)
        out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
        return {"name": name, "cmd": cmd, "ok": r.returncode == 0,
                "exit": r.returncode, "elapsed": round(time.time() - start, 2),
                "tail": "\n".join(out.splitlines()[-TAIL_LINES:])}
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))
        return {"name": name, "cmd": cmd, "ok": False, "exit": "timeout",
                "elapsed": round(time.time() - start, 2),
                "tail": "\n".join(out.splitlines()[-TAIL_LINES:]) or f"timed out after {timeout}s"}
    except OSError as e:
        return {"name": name, "cmd": cmd, "ok": False, "exit": "spawn-error",
                "elapsed": 0.0, "tail": str(e)}


def cmd_run(a):
    repo = repo_root(a.repo)
    cfg_p = Path(a.config).resolve() if a.config else repo / "tools" / "verify" / "config.json"
    if not cfg_p.is_file():
        print(f"verify.py: no config at {cfg_p}; run verify.py init first", file=sys.stderr)
        return 2
    try:
        gates = json.loads(cfg_p.read_text())["gates"]
    except (ValueError, KeyError) as e:
        print(f"verify.py: bad config {cfg_p}: {e}", file=sys.stderr)
        return 2
    results = [run_gate(g, cwd=repo) for g in gates]
    passed = sum(1 for r in results if r["ok"])
    out_dir = repo / "verify-out" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_p = out_dir / f"report-{stamp}.json"
    report_p.write_text(json.dumps({"gates": results, "passed": passed,
                                    "total": len(results)}, indent=2) + "\n")
    for r in results:
        mark = "ok " if r["ok"] else "FAIL"
        print(f"{mark}  {r['name']} ({r['elapsed']}s) :: {r['cmd']}")
        if not r["ok"] and r["tail"]:
            print(f"      {r['tail'].splitlines()[-1] if r['tail'].strip() else r['exit']}")
    print(f"proof     {report_p.relative_to(repo)}  {passed}/{len(results)} gates green")
    return 0 if passed == len(results) else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="maintained verify CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--repo", default=".")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("run")
    p.add_argument("--repo", default=".")
    p.add_argument("--config", default=None)
    a = ap.parse_args(argv)
    return {"init": cmd_init, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
