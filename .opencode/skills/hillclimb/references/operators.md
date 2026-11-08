# Hillclimb operators

One variant per attempt. Pick the smallest operator that can test the hypothesis.

## Operator menu

1. **Shrink** — do less work per frame/pass (cull, early-out, smaller batch).
2. **Cache** — memoize across attempts/frames; key must include every input that
   affects the output or the score is lying.
3. **Reorder** — move the expensive check last, the cheap reject first.
4. **Specialize** — fast path for the common fixture shape, generic fallback kept.
5. **Remove** — delete a pass/allocation that measurement shows is dead weight.
6. **Widen** — only when the score is throughput under parallelism; never widen to
   hide latency the fixtures actually penalize.

## Acceptance math

- `keep` iff `score > best + epsilon` with all gates green and no constraint
  broken. Ties and epsilon-noise are reverts.
- Report deltas as `score - prevBest`, never as percentages of a near-zero base.
- Average only with a fixed sample count; record seed, samples, and wall-clock in
  the ledger `detail`.

## Plateau and budget

- Default budget 20 attempts, plateau 3 consecutive reverts. Raise the budget only
  when keeps are still landing; lower the plateau when reverts repeat a signature.
- After a plateau, stop and write the winner up: what won, by how much, on which
  fixtures, with the exact command to reproduce it. A climb that never plateaus
  has a scorer that is too easy, not a codebase that is infinitely improvable.
