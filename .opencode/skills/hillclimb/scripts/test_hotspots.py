"""Tests for hotspots.py (stdlib + pytest only)."""
import json
import subprocess
import sys
from pathlib import Path

HOTSPOTS = Path(__file__).with_name("hotspots.py")


def run(*args):
    r = subprocess.run([sys.executable, str(HOTSPOTS), *args], capture_output=True, text=True)
    return r


def test_folded_self_and_total(tmp_path):
    p = tmp_path / "p.folded"
    p.write_text("root;mid;leaf_c 60\nroot;mid;leaf_d 30\nroot;leaf_e 10\n")
    r = run(str(p), "--top", "5")
    assert r.returncode == 0
    assert "leaf_c" in r.stdout and "60" in r.stdout
    out = r.stdout
    self_section = out.split("SELF")[1].split("TOTAL")[0]
    assert self_section.index("leaf_c") < self_section.index("leaf_d") < self_section.index("leaf_e")
    total_section = out.split("TOTAL")[1]
    assert total_section.index("root") < total_section.index("mid")


def test_chrome_cpuprofile(tmp_path):
    p = tmp_path / "p.cpuprofile"
    p.write_text(json.dumps({"nodes": [
        {"id": 1, "callFrame": {"functionName": "render", "url": "app.js"}, "hitCount": 80},
        {"id": 2, "callFrame": {"functionName": "(idle)", "url": ""}, "hitCount": 0},
        {"id": 3, "callFrame": {"functionName": "layout", "url": "app.js"}, "hitCount": 20},
    ]}))
    r = run("--format", "chrome", str(p), "--json")
    assert r.returncode == 0
    obj = json.loads(r.stdout)
    assert obj["samples"] == 100
    assert obj["self"][0]["frame"] == "render (app.js)"


def test_empty_input_ok(tmp_path):
    p = tmp_path / "empty.folded"
    p.write_text("\n  \n")
    r = run(str(p))
    assert r.returncode == 0 and "no samples" in r.stdout


def test_malformed_lines_skipped(tmp_path):
    p = tmp_path / "bad.folded"
    p.write_text("not a stack line here\na;b 5\n")
    r = run(str(p), "--json")
    assert r.returncode == 0
    obj = json.loads(r.stdout)
    assert obj["samples"] == 5 and obj["skipped"] == 1
