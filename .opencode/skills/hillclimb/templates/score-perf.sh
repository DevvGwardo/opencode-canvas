#!/usr/bin/env bash
# Hillclimb perf scorer template. Copy to tools/hillclimb/score-perf.sh and fill in.
# Runs WORKLOAD_CMD SAMPLES times, prints SCORE (higher = faster) + metadata.
# SCORE is throughput (1000 / mean seconds); gate fails (exit 1) on any bad run.
set -u
: "${WORKLOAD_CMD:?set WORKLOAD_CMD to the command that exercises the hotspot}"
: "${SAMPLES:=5}"
sum=0
i=0
while [ "$i" -lt "$SAMPLES" ]; do
  start=$(python3 -c 'import time;print(time.time())')
  # shellcheck disable=SC2086
  if ! $WORKLOAD_CMD >/dev/null 2>&1; then echo "GATE=workload-failed"; exit 1; fi
  end=$(python3 -c 'import time;print(time.time())')
  sum=$(awk "BEGIN{print $sum+($end-$start)}")
  i=$((i + 1))
done
mean=$(awk "BEGIN{print $sum/$SAMPLES}")
echo "SCORE=$(awk "BEGIN{print 1000/$mean}")"
echo "MEAN_S=$mean"
echo "SAMPLES=$SAMPLES"
