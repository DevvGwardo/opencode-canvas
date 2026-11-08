"""Tests for verify.py (stdlib + pytest only)."""
import json
import subprocess
import sys
from pathlib import Path

VERIFY = Path(__file__).with_name("verify.py")


def run(repo, *args):
    return subprocess.run([sys.executable, str(VERIFY), *args, "--repo", str(repo)],
                          capture_output=True, text=True)


def write_config(repo, gates):
    d = repo / "tools" / "verify"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps({"gates": gates}))


def test_init_scaffolds(tmp_path):
    assert run(tmp_path, "init").returncode == 0
    assert (tmp_path / "tools" / "verify" / "config.json").is_file()
    assert (tmp_path / "tools" / "verify" / "feature-map.md").is_file()
    # Second init keeps existing files without --force.
    assert run(tmp_path, "init").returncode == 0


def test_run_green(tmp_path):
    write_config(tmp_path, [{"name": "a", "cmd": "true", "timeout": 10},
                            {"name": "b", "cmd": "echo hi", "timeout": 10}])
    r = run(tmp_path, "run")
    assert r.returncode == 0 and "2/2 gates green" in r.stdout
    reports = list((tmp_path / "verify-out" / "data").glob("report-*.json"))
    assert len(reports) == 1
    rep = json.loads(reports[0].read_text())
    assert rep["passed"] == 2 and all(g["ok"] for g in rep["gates"])


def test_run_red_and_timeout(tmp_path):
    write_config(tmp_path, [{"name": "bad", "cmd": "false", "timeout": 10},
                            {"name": "slow", "cmd": "sleep 5", "timeout": 1}])
    r = run(tmp_path, "run")
    assert r.returncode == 1 and "FAIL" in r.stdout
    reports = list((tmp_path / "verify-out" / "data").glob("report-*.json"))
    rep = json.loads(reports[-1].read_text())
    assert rep["passed"] == 0
    assert {g["name"]: g["exit"] for g in rep["gates"]} == {"bad": 1, "slow": "timeout"}


def test_run_missing_config(tmp_path):
    assert run(tmp_path, "run").returncode == 2
