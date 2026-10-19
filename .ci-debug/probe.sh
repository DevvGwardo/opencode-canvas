#!/usr/bin/env bash
B=/usr/bin/chromium
MIN=(--headless=new --remote-debugging-port=0 --no-first-run)
try() {
  local name="$1" io="$2"; shift 2
  local d; d=$(mktemp -d)
  case "$io" in
    devnull) "$B" "$@" --user-data-dir="$d" about:blank </dev/null >/dev/null 2>"$d.err" & ;;
    pipe)    ( "$B" "$@" --user-data-dir="$d" about:blank 2>&1 | cat >"$d.err" ) & ;;
    stdin)   "$B" "$@" --user-data-dir="$d" about:blank >"$d.out" 2>"$d.err" & ;;
  esac
  local pid=$! t=0
  while [ $t -lt 40 ] && [ ! -s "$d/DevToolsActivePort" ]; do sleep 0.5; t=$((t+1)); done
  if [ -s "$d/DevToolsActivePort" ]; then echo "OK   $name [$io] ($((t/2))s)"; else echo "FAIL $name [$io]"; grep -m3 -E "FATAL|Check failed|ERROR:(?!dbus)" "$d.err" | grep -v dbus | cut -c1-240; fi
  pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; pkill -f "user-data-dir=$d" 2>/dev/null; wait $pid 2>/dev/null
}
try minimal pipe "${MIN[@]}"
try minimal devnull "${MIN[@]}"
try minimal stdin "${MIN[@]}"
for f in --remote-debugging-address=127.0.0.1 --window-size=1280,800 --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-extensions --mute-audio; do
  try "minimal + $f" devnull "${MIN[@]}" "$f"
done
