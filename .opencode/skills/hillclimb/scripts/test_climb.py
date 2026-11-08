"""Tests for climb.py ledger rules (stdlib + pytest only)."""
import json
import subprocess
import sys
from pathlib import Path

CLIMB = Path(__file__).with_name("climb.py")


def run(repo, *args):
    r = subprocess.run([sys.executable, str(CLIMB), *args, "--repo", str(repo)],
                       capture_output=True, text=True)
    return r


def test_init_record_best_tally(tmp_path):
    assert run(tmp_path, "init", "--task", "speed up tiles", "--score-cmd",
               "bash tools/hillclimb/score.sh").returncode == 0
    assert (tmp_path / "tools" / "hillclimb" / "contract.json").is_file()
    assert run(tmp_path, "record", "--score", "10", "--hypothesis", "baseline run",
               "--verdict", "baseline").returncode == 0
    # Non-improving keep must be rejected.
    bad = run(tmp_path, "record", "--score", "10", "--hypothesis", "no-op",
              "--files", "src/a.ts", "--verdict", "keep")
    assert bad.returncode == 1 and "not > best" in bad.stderr
    # Revert then a real improvement.
    assert run(tmp_path, "record", "--score", "9.5", "--hypothesis", "bad idea",
               "--files", "src/a.ts", "--verdict", "revert").returncode == 0
    assert run(tmp_path, "record", "--score", "12.25", "--hypothesis", "cache tiles",
               "--files", "src/tiles.ts", "--verdict", "keep").returncode == 0
    led = json.loads((tmp_path / "tools" / "hillclimb" / "ledger.json").read_text())
    assert len(led["attempts"]) == 3
    assert led["best"] == {"n": 3, "score": 12.25, "hypothesis": "cache tiles"}
    t = run(tmp_path, "tally", "--json")
    assert t.returncode == 0
    assert json.loads(t.stdout)["keeps"] == 1


def test_baseline_only_first(tmp_path):
    assert run(tmp_path, "init", "--task", "t", "--score-cmd", "echo SCORE=1").returncode == 0
    assert run(tmp_path, "record", "--score", "1", "--hypothesis", "b",
               "--verdict", "baseline").returncode == 0
    dup = run(tmp_path, "record", "--score", "2", "--hypothesis", "b2", "--verdict", "baseline")
    assert dup.returncode == 1


def test_epsilon_enforced(tmp_path):
    assert run(tmp_path, "init", "--task", "t", "--score-cmd", "echo SCORE=1",
               "--epsilon", "0.5").returncode == 0
    assert run(tmp_path, "record", "--score", "10", "--hypothesis", "b",
               "--verdict", "baseline").returncode == 0
    tiny = run(tmp_path, "record", "--score", "10.2", "--hypothesis", "noise",
               "--verdict", "keep")
    assert tiny.returncode == 1
