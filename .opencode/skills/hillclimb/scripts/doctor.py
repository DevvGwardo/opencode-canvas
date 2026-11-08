#!/usr/bin/env python3
"""Hillclimb preflight: contract, scorer, ledger state, and what is missing.

  doctor.py [--repo PATH] [--json]

Read-only. Exit 0 always; the verdict is in the output, not the exit code.
"""
import argparse
import hashlib
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


def file_hash(p):
    try:
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:12]
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description="hillclimb preflight")
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    repo = a.repo.resolve()
    code, top = sh(["git", "rev-parse", "--show-toplevel"], cwd=repo)
    if code == 0 and top:
        repo = Path(top)
    hc = repo / "tools" / "hillclimb"
    contract_p = hc / "contract.json"
    ledger_p = hc / "ledger.json"

    contract, scorer_hash_now, scorer_drift = None, None, False
    score_cmd, scorer_path = None, None
    if contract_p.is_file():
        try:
            contract = json.loads(contract_p.read_text())
            score_cmd = (contract.get("score") or {}).get("command")
            frozen = (contract.get("score") or {}).get("scorerHash")
            # Resolve scorer path relative to tools/hillclimb when it names a file.
            for cand in (hc / "score.sh", hc / "score.py", hc / "score.mjs"):
                if cand.is_file():
                    scorer_path = cand
                    break
            if scorer_path:
                scorer_hash_now = file_hash(scorer_path)
                scorer_drift = bool(frozen and scorer_hash_now and frozen != frozen[:0] + scorer_hash_now and frozen != scorer_hash_now)
        except (OSError, ValueError) as e:
            contract = {"_parseError": str(e)}

    attempts, best = [], None
    if ledger_p.is_file():
        try:
            led = json.loads(ledger_p.read_text())
            attempts = led.get("attempts", []) if isinstance(led, dict) else []
            best = (led.get("best") if isinstance(led, dict) else None)
        except (OSError, ValueError):
            attempts = []

    keeps = sum(1 for x in attempts if isinstance(x, dict) and x.get("verdict") == "keep")
    reverts = sum(1 for x in attempts if isinstance(x, dict) and x.get("verdict") == "revert")
    _, head = sh(["git", "log", "-1", "--format=%h %cs %s"], cwd=repo)
    _, dirty = sh(["git", "status", "--porcelain"], cwd=repo)
    tools = {
        "python3": bool(shutil.which("python3")),
        "git": code == 0,
        "pytest": bool(shutil.which("pytest") or shutil.which("python3")),
    }
    notes = []
    if not contract_p.is_file():
        notes.append("no contract: run climb.py init --repo . --task ... --score-cmd ...")
    elif isinstance(contract, dict) and contract.get("_parseError"):
        notes.append(f"contract.json does not parse: {contract['_parseError']}")
    if contract and not score_cmd:
        notes.append("contract has no score.command: re-run init with --score-cmd")
    if scorer_drift:
        notes.append(f"scorer drifted since init ({scorer_path.name}): re-baseline, do not compare across the change")
    if attempts and best is None:
        notes.append("ledger has attempts but no best pointer: run climb.py tally")
    mode = "climb" if contract_p.is_file() else "bootstrap"
    result = {
        "repo": str(repo), "head": head, "dirtyFiles": len(dirty.splitlines()) if dirty else 0,
        "mode": mode,
        "contract": bool(contract_p.is_file()), "scoreCmd": score_cmd,
        "scorer": str(scorer_path) if scorer_path else None,
        "scorerHash": scorer_hash_now, "scorerDrift": scorer_drift,
        "attempts": len(attempts), "keeps": keeps, "reverts": reverts, "best": best,
        "tools": tools, "notes": notes,
    }
    if a.json:
        print(json.dumps(result, indent=2))
        return 0
    print(f"repo      {repo}  ({head or 'no commits yet'}; {result['dirtyFiles']} uncommitted)")
    print(f"mode      {mode}")
    print(f"contract  {'present' if result['contract'] else 'MISSING'}")
    print(f"score     {score_cmd or 'none recorded'}")
    print(f"scorer    {result['scorer'] or 'none'} hash={scorer_hash_now or '-'} drift={'YES' if scorer_drift else 'no'}")
    print(f"ledger    {len(attempts)} attempts ({keeps} keep / {reverts} revert) best={json.dumps(best) if best else 'none'}")
    print("tools     " + "  ".join(f"{k}:{'ok' if v else 'MISSING'}" for k, v in tools.items()))
    for n in notes:
        print(f"note      {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
