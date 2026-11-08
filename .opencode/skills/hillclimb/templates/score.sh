#!/usr/bin/env bash
# Hillclimb score harness template. Copy to tools/hillclimb/score.sh and fill in.
# Contract: print exactly one SCORE=<float> line (higher = better), exit non-zero
# when the goal's gate checks fail (a high score with a red gate is a revert).
set -u
# Example: average FPS over a fixed seed (replace with the real measurement).
# SAMPLES=5
# total=0
# for i in $(seq 1 $SAMPLES); do
#   v=$(node tools/hillclimb/bench.mjs --seed 42 | sed -n 's/^FPS=//p')
#   total=$(awk "BEGIN{print $total+$v}")
# done
# echo "SCORE=$(awk "BEGIN{print $total/$SAMPLES}")"
# echo "SAMPLES=$SAMPLES"
echo "SCORE=0.0"
