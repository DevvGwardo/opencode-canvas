# Trace-driven performance climbs

Hillclimb maximizes a number; traces tell it *where* to look. Without a profile
the loop guesses. With one, every attempt attacks the measured hottest frame.

## The loop with traces

1. **Capture a baseline profile** of the real workload (not a microbenchmark):
   - Node/Bun: `node --cpu-prof --cpu-prof-dir=./prof app.js` (Chrome `.cpuprofile`),
     or `node --prof` + `node --prof-process` for tick summaries.
   - Python: `py-spy record -o prof.folded --format folded -- <cmd>`, or
     `python -m cProfile` for function totals.
   - Linux/Rust/Go: `perf record -F 99 -g -- <cmd>` then `perf script` folded.
   - macOS: Instruments → Time Profiler → export, or `sample` folded.
2. **Rank hotspots** with the skill helper (stdlib only, no deps):
   ```sh
   python3 "$HC_SKILL/scripts/hotspots.py" prof.folded --top 10
   python3 "$HC_SKILL/scripts/hotspots.py" --format chrome prof.cpuprofile --top 10
   ```
   Self time = where CPU burns (optimize the leaf). Total time = what to
   avoid calling (hoist, cache, or stop calling the subtree).
3. **Freeze the scorer.** Copy `templates/score-perf.sh` to
   `tools/hillclimb/score-perf.sh`, set `WORKLOAD_CMD` to the profiled workload,
   and `init` with `--score-cmd "bash tools/hillclimb/score-perf.sh"`. The
   workload must be the same one you profiled, or the score is fiction.
4. **Attack the top frame, one operator per attempt** (see `operators.md`):
   shrink the leaf, cache its inputs, hoist it out of the hot loop, specialize
   the common shape. Re-profile after every keep — hotspots move.
5. **Revert on score+trace mismatch.** A faster SCORE with the same hotspot on
   top is suspicious (the timer moved, not the work). A faster SCORE with the
   hotspot gone or shrunk is real. Record the top-frame delta in `detail`.

## Rules that keep auto-perf honest

- **Same machine, same load.** Perf numbers only compare within one climb on one
  quiet machine. Never compare laptop scores to CI scores.
- **Fixed SAMPLES, pinned inputs.** Throughput jitters; `SAMPLES=5` minimum,
  fixed seed, warmed cache, recorded in the ledger.
- **Gate stays green.** Correctness checks run with every score. A faster wrong
  answer is a revert, always.
- **No benchmark gaming.** Shrinking the workload, warming what production keeps
  cold, or special-casing the fixture shape without a general fallback is
  scorer fraud — same ban as editing the scorer.
