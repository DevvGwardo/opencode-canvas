#!/usr/bin/env python3
"""Rank hotspots from a CPU profile. Stdlib only.

  hotspots.py profile.folded [--top N]          # folded stacks: "a;b;c 123"
  hotspots.py --format chrome profile.cpuprofile [--top N]   # node --cpu-prof
  hotspots.py ... --json                        # machine-readable output

Folded mode: self time goes to the leaf frame, total time to every frame on the
stack. Chrome mode ranks nodes by self samples (hitCount); total time is not
reconstructed (parents are ambiguous without the samples array), so only the
self column is reported.

Exit 0 always; empty or unparsable input prints a note and empty tables.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path


def parse_folded(text):
    self_time, total_time, skipped = Counter(), Counter(), 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            stack, count_s = line.rsplit(None, 1)
            count = float(count_s)
        except ValueError:
            skipped += 1
            continue
        frames = [f.strip() or "(anon)" for f in stack.split(";") if f.strip()]
        if not frames:
            skipped += 1
            continue
        self_time[frames[-1]] += count
        for f in frames:
            total_time[f] += count
    return self_time, total_time, skipped


def parse_chrome(obj):
    self_time = Counter()
    try:
        nodes = obj["nodes"]
    except (KeyError, TypeError):
        return self_time, 0
    skipped = 0
    for n in nodes if isinstance(nodes, list) else []:
        if not isinstance(n, dict):
            skipped += 1
            continue
        hits = n.get("hitCount", 0)
        try:
            hits = float(hits)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not hits:
            continue
        cf = n.get("callFrame", {}) if isinstance(n.get("callFrame"), dict) else {}
        name = (cf.get("functionName") or "(anon)").strip() or "(anon)"
        url = (cf.get("url") or "").strip()
        label = f"{name} ({url})" if url else name
        self_time[label] += hits
    return self_time, skipped


def main(argv=None):
    ap = argparse.ArgumentParser(description="rank CPU profile hotspots")
    ap.add_argument("profile", type=Path)
    ap.add_argument("--format", choices=("folded", "chrome"), default="folded")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        raw = a.profile.read_text()
    except OSError as e:
        print(f"hotspots.py: cannot read {a.profile}: {e}", file=sys.stderr)
        return 1
    if a.format == "chrome":
        try:
            obj = json.loads(raw)
        except ValueError as e:
            print(f"hotspots.py: bad chrome JSON: {e}", file=sys.stderr)
            return 1
        self_time, skipped = parse_chrome(obj)
        total_time = Counter()
    else:
        self_time, total_time, skipped = parse_folded(raw)
    total = sum(self_time.values())
    top = max(1, a.top)
    self_rank = self_time.most_common(top)
    total_rank = total_time.most_common(top) if total_time else []
    if a.json:
        print(json.dumps({
            "samples": total, "skipped": skipped,
            "self": [{"frame": f, "samples": s} for f, s in self_rank],
            "total": [{"frame": f, "samples": s} for f, s in total_rank],
        }, indent=2))
        return 0
    if not self_rank:
        print("hotspots: no samples parsed (empty or unrecognized input)")
        return 0
    print(f"samples   {total:g}  skipped-lines {skipped}")
    print(f"{'SELF':>10}  {'%':>5}  frame (top {len(self_rank)})")
    for f, s in self_rank:
        pct = 100.0 * s / total if total else 0
        print(f"{s:>10g}  {pct:>4.1f}%  {f}")
    if total_rank:
        print(f"{'TOTAL':>10}  frame (top {len(total_rank)})")
        for f, s in total_rank:
            print(f"{s:>10g}  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
