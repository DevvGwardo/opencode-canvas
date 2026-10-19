#!/usr/bin/env bash
B=/usr/bin/chromium
FLAGS=(--headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --window-size=1280,800 --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-extensions --mute-audio)
try() {
  local name="$1"; shift
  local d; d=$(mktemp -d)
  "$B" "$@" --user-data-dir="$d" about:blank </dev/null >/dev/null 2>"$d.err" &
  local pid=$! t=0
  while [ $t -lt 40 ] && [ ! -s "$d/DevToolsActivePort" ]; do sleep 0.5; t=$((t+1)); done
  if [ -s "$d/DevToolsActivePort" ]; then echo "OK   $name ($((t/2))s)"; else echo "FAIL $name; alive=$(kill -0 $pid 2>/dev/null && echo y || echo n)"; tail -5 "$d.err"; fi
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
}
try "all flags" "${FLAGS[@]}"
for f in "${FLAGS[@]}"; do
  case "$f" in --remote-debugging-port=0|--headless=new) continue;; esac
  rest=(); for g in "${FLAGS[@]}"; do [ "$g" != "$f" ] && rest+=("$g"); done
  try "without $f" "${rest[@]}"
done
