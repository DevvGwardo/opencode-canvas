#!/usr/bin/env python3
"""Start, wait for, and stop the app server a harness drives, with no sleep loops.

  devserver.py start --url URL [--cwd DIR] [--expect TEXT] [--timeout 120] -- CMD ...
  devserver.py wait  --url URL [--expect TEXT] [--timeout 60]
  devserver.py stop  --url URL [--cwd DIR]
  devserver.py status --url URL [--cwd DIR]

start runs CMD detached in its own process group (log in blueprint-out/devserver/), returns once
URL answers, and prints {"url","pid","log","readyMs","owned"} as JSON. If URL already answers and
this tool didn't start it, start refuses (exit 3): it may be another session's server. Pick another
port. --expect checks the page contains TEXT, so the right app is serving. stop kills only a
server this tool started. Exit 0 ok, 1 failed/timed out, 3 port taken. Same in Bash and terminal.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def probe(url, expect=None):
    """(answered, matched): any HTTP response under 500 means up; expect must appear in the body."""
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            body = r.read(200_000).decode("utf-8", "replace")
            return True, expect is None or expect in body
    except urllib.error.HTTPError as e:
        return e.code < 500, expect is None
    except (urllib.error.URLError, OSError, ValueError):
        return False, False


def state_file(cwd, url):
    u = urlparse(url)
    return Path(cwd) / "blueprint-out" / "devserver" / f"{u.hostname}-{u.port or 80}.json"


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def tail(log, n=30):
    try:
        return "\n".join(Path(log).read_text(errors="replace").splitlines()[-n:])
    except OSError:
        return ""


def kill_group(pid, proc=None):
    """SIGTERM then SIGKILL the whole group. proc (our own child) is reaped, so it can't linger as a zombie."""
    for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):  # gone, or only a zombie leader is left
            return
        end = time.time() + wait
        while time.time() < end and (proc.poll() is None if proc else alive(pid)):
            time.sleep(0.1)
        if (proc.poll() is not None) if proc else not alive(pid):
            return


def wait_up(url, expect, timeout, proc=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc is not None and proc.poll() is not None:
            return "exited", None
        up, ok = probe(url, expect)
        if up:
            return ("ok" if ok else "wrong-app"), round((time.time() - t0) * 1000)
        time.sleep(0.5)
    return "timeout", None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=["start", "wait", "stop", "status"])
    ap.add_argument("--url", required=True)
    ap.add_argument("--cwd", type=Path, default=Path.cwd())
    ap.add_argument("--expect")
    ap.add_argument("--timeout", type=float)
    argv = sys.argv[1:]
    split = argv.index("--") if "--" in argv else len(argv)
    a, cmd = ap.parse_args(argv[:split]), argv[split + 1:]
    cwd, sf = a.cwd.resolve(), state_file(a.cwd.resolve(), a.url)
    state = json.loads(sf.read_text()) if sf.is_file() else None
    ours = state is not None and alive(state["pid"])

    if a.action == "status":
        up, ok = probe(a.url, a.expect)
        print(json.dumps({"url": a.url, "answering": up, "expected": ok, "owned": ours,
                          **({"pid": state["pid"], "log": state["log"]} if ours else {})}))
        return 0
    if a.action == "wait":
        status, ms = wait_up(a.url, a.expect, a.timeout or 60)
        print(json.dumps({"url": a.url, "status": status, "readyMs": ms}))
        return 0 if status == "ok" else 1
    if a.action == "stop":
        if not ours:
            print(json.dumps({"url": a.url, "stopped": False, "reason": "no server started here for this URL"}))
            sf.unlink(missing_ok=True)
            return 0
        kill_group(state["pid"])
        sf.unlink(missing_ok=True)
        print(json.dumps({"url": a.url, "stopped": not alive(state["pid"]), "pid": state["pid"]}))
        return 0

    if not cmd:
        ap.error("start needs the server command after --")
    up, ok = probe(a.url, a.expect)
    if up:
        if ours:
            print(json.dumps({"url": a.url, "pid": state["pid"], "log": state["log"], "readyMs": 0,
                              "owned": True, "expected": ok, "note": "already running"}))
            return 0 if ok else 1
        print(json.dumps({"url": a.url, "owned": False, "expected": ok,
                          "error": "something not started by devserver.py already answers here; use another port"}))
        return 3
    sf.parent.mkdir(parents=True, exist_ok=True)
    log = sf.with_suffix(".log")
    with open(log, "ab") as out:
        proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                start_new_session=True)
    sf.write_text(json.dumps({"pid": proc.pid, "cmd": cmd, "url": a.url, "log": str(log), "started": time.time()}))
    status, ms = wait_up(a.url, a.expect, a.timeout or 120, proc)
    if status == "ok":
        print(json.dumps({"url": a.url, "pid": proc.pid, "log": str(log), "readyMs": ms, "owned": True}))
        return 0
    if proc.poll() is None:
        kill_group(proc.pid, proc)
    sf.unlink(missing_ok=True)
    print(json.dumps({"url": a.url, "status": status, "exitCode": proc.poll(), "log": str(log)}))
    print(tail(log), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
