#!/usr/bin/env python3
"""Hillclimb ledger: init a climb, record attempts, report best/totals.

  climb.py init   --repo . --task "..." --score-cmd "..." [--budget N] [--plateau N] [--epsilon F] [--gate "..."]
  climb.py record --repo . --score FLOAT --hypothesis "..." --files "a.ts,b.ts" --verdict keep|revert|baseline [--detail "..."]
  climb.py best   --repo . [--json]
  climb.py tally  --repo . [--json]

Ledger lives at <repo>/tools/hillclimb/ledger.json, contract at
<repo>/tools/hillclimb/contract.json. record appends; history is never rewritten.
A keep with score <= best+epsilon is rejected (exit 1) to enforce strict improvement.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def fail(msg):
    print(f"climb.py: {msg}", file=sys.stderr)
    return 1


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


def load_json(p):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError) as e:
        print(f"climb.py: cannot read {p}: {e}", file=sys.stderr)
        raise SystemExit(1)


def cmd_init(a):
    repo = repo_root(a.repo)
    hc = repo / "tools" / "hillclimb"
    hc.mkdir(parents=True, exist_ok=True)
    scorer = None
    for cand in ("score.sh", "score.py", "score.mjs"):
        if (hc / cand).is_file():
            scorer = hc / cand
            break
    scorer_hash = hashlib.sha256(scorer.read_bytes()).hexdigest()[:12] if scorer else None
    try:
        budget, plateau, epsilon = int(a.budget), int(a.plateau), float(a.epsilon)
    except ValueError:
        return fail("budget/plateau must be ints, epsilon a float")
    contract = {
        "task": a.task,
        "gate": a.gate or "",
        "score": {"command": a.score_cmd, "direction": "higher",
                  "epsilon": epsilon, "scorerHash": scorer_hash,
                  "scorer": scorer.name if scorer else None},
        "budget": budget, "plateau": plateau,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (hc / "contract.json").write_text(json.dumps(contract, indent=2) + "\n")
    led = {"attempts": [], "best": None}
    if not (hc / "ledger.json").is_file() or a.reset:
        (hc / "ledger.json").write_text(json.dumps(led, indent=2) + "\n")
    print(f"init      {hc.relative_to(repo)}/contract.json budget={budget} plateau={plateau} epsilon={epsilon}")
    print(f"score     {a.score_cmd}")
    if scorer:
        print(f"scorer    {scorer.name} hash={scorer_hash}")
    else:
        print("note      no tools/hillclimb/score.* yet: copy templates/score.sh to start")
    return 0


def cmd_record(a):
    repo = repo_root(a.repo)
    hc = repo / "tools" / "hillclimb"
    cp, lp = hc / "contract.json", hc / "ledger.json"
    if not cp.is_file():
        return fail("no contract.json: run climb.py init first")
    contract = load_json(cp)
    eps = float((contract.get("score") or {}).get("epsilon", 1e-9))
    led = load_json(lp) if lp.is_file() else {"attempts": [], "best": None}
    attempts = led.get("attempts", [])
    best = led.get("best")
    try:
        score = float(a.score)
    except ValueError:
        return fail(f"score must be a float, got {a.score!r}")
    verdict = a.verdict.lower()
    if verdict not in ("keep", "revert", "baseline"):
        return fail("verdict must be keep|revert|baseline")
    prev_best = float(best["score"]) if isinstance(best, dict) and best.get("score") is not None else None
    n = len(attempts) + 1
    if verdict == "baseline" and n != 1:
        return fail("baseline is only valid as attempt 1 (use --reset on init for a fresh climb)")
    if verdict == "keep" and prev_best is not None and not (score > prev_best + eps):
        return fail(f"keep rejected: {score} not > best {prev_best} + epsilon {eps}; use revert")
    entry = {
        "n": n,
        "hypothesis": a.hypothesis, "files": [f.strip() for f in (a.files or '').split(",") if f.strip()],
        "score": score, "prevBest": prev_best, "delta": (score - prev_best) if prev_best is not None else 0.0,
        "verdict": verdict, "detail": a.detail or "",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    attempts.append(entry)
    if verdict in ("keep", "baseline"):
        led["best"] = {"n": n, "score": score, "hypothesis": a.hypothesis}
    led["attempts"] = attempts
    lp.write_text(json.dumps(led, indent=2) + "\n")
    streak = 0
    for x in reversed(attempts):
        if x.get("verdict") == "revert":
            streak += 1
        else:
            break
    plateau = int(contract.get("plateau", 3))
    budget = int(contract.get("budget", 20))
    print(f"attempt   #{n} {verdict} score={score} prevBest={prev_best} delta={entry['delta']:+.6g}")
    print(f"ledger    {len(attempts)}/{budget} used, revert-streak {streak}/{plateau}")
    if len(attempts) >= budget:
        print("stop      budget reached")
    elif streak >= plateau:
        print("stop      plateau reached")
    return 0


def cmd_best(a):
    repo = repo_root(a.repo)
    lp = repo / "tools" / "hillclimb" / "ledger.json"
    if not lp.is_file():
        return fail("no ledger.json: run climb.py init first")
    led = load_json(lp)
    best = led.get("best")
    if a.json:
        print(json.dumps({"best": best, "attempts": len(led.get("attempts", []))}, indent=2))
        return 0
    if not best:
        print("best      none yet")
        return 0
    print(f"best      attempt #{best['n']} score={best['score']} hypothesis={best.get('hypothesis', '')}")
    return 0


def cmd_tally(a):
    repo = repo_root(a.repo)
    hc = repo / "tools" / "hillclimb"
    if not (hc / "contract.json").is_file():
        return fail("no contract.json: run climb.py init first")
    contract = load_json(hc / "contract.json")
    led = load_json(hc / "ledger.json") if (hc / "ledger.json").is_file() else {"attempts": [], "best": None}
    attempts = led.get("attempts", [])
    keeps = [x for x in attempts if x.get("verdict") == "keep"]
    reverts = [x for x in attempts if x.get("verdict") == "revert"]
    scorer_name = (contract.get("score") or {}).get("scorer")
    drift = False
    if scorer_name and (hc / scorer_name).is_file() and (contract.get("score") or {}).get("scorerHash"):
        h = hashlib.sha256((hc / scorer_name).read_bytes()).hexdigest()[:12]
        drift = h != contract["score"]["scorerHash"]
    out = {"attempts": len(attempts), "keeps": len(keeps), "reverts": len(reverts),
           "best": led.get("best"), "budget": contract.get("budget"),
           "plateau": contract.get("plateau"), "scorerDrift": drift}
    status = 1 if drift else 0
    if a.json:
        print(json.dumps(out, indent=2))
        return status
    print(f"attempts  {len(attempts)}/{contract.get('budget')} ({len(keeps)} keep / {len(reverts)} revert)")
    print(f"best      {json.dumps(led.get('best')) if led.get('best') else 'none'}")
    if drift:
        print("FAIL      scorer drifted since init: re-baseline before comparing scores")
    for x in attempts:
        files = ",".join(x.get("files", []))
        print(f"  #{x['n']} {x['verdict']:<8} score={x['score']:<12} delta={x.get('delta', 0):+.6g} {files} :: {x.get('hypothesis', '')}")
    return status


def main(argv=None):
    ap = argparse.ArgumentParser(description="hillclimb ledger")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--task", required=True)
    p.add_argument("--score-cmd", required=True)
    p.add_argument("--budget", default="20")
    p.add_argument("--plateau", default="3")
    p.add_argument("--epsilon", default="1e-9")
    p.add_argument("--gate", default="")
    p.add_argument("--reset", action="store_true")
    p = sub.add_parser("record")
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--score", required=True)
    p.add_argument("--hypothesis", required=True)
    p.add_argument("--files", default="")
    p.add_argument("--verdict", required=True)
    p.add_argument("--detail", default="")
    p = sub.add_parser("best")
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("tally")
    p.add_argument("--repo", type=Path, default=Path.cwd())
    p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    return {"init": cmd_init, "record": cmd_record, "best": cmd_best, "tally": cmd_tally}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
