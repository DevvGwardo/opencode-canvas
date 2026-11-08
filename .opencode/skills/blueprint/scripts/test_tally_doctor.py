import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent


def run(script, *args, cwd=None):
    return subprocess.run([sys.executable, str(HERE / script), *map(str, args)],
                          capture_output=True, text=True, cwd=cwd)


def report(root, name, checks, **extra):
    path = root / f"report-{name}.json"
    path.write_text(json.dumps({"checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks], **extra}))
    return path


class TallyTests(unittest.TestCase):
    def test_fill_is_idempotent_and_leaves_unknown_regions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = report(root, "sweep-0e3465fb-6ec7-4695-b77f-dbf0b99c0e92", [("Loads", True, {"ms": 120})], errors=[])
            b = report(root, "feature", [("Undo", True, "1 step"), ("Saves", False, "lost")], perf={"fps": 60})
            page = root / "page.html"
            page.write_text("<b><!--bp:checks-->N/N<!--/bp:checks--></b><!--bp:mystery-->keep<!--/bp:mystery-->"
                            "<tbody><!--bp:checks-rows--><tr>old</tr><!--/bp:checks-rows--></tbody>")
            first = run("tally.py", a, b, "--fill", page, "--json")
            self.assertEqual(first.returncode, 1)  # one check failed
            out = json.loads(first.stdout)
            self.assertEqual((out["passed"], out["total"]), (2, 3))
            self.assertEqual(out["unknownRegions"], ["mystery"])
            filled = page.read_text()
            self.assertIn("<!--bp:checks-->2 / 3<!--/bp:checks-->", filled)
            self.assertIn("keep", filled)
            self.assertNotIn("<tr>old</tr>", filled)
            self.assertIn("<td>sweep</td>", filled)  # run uuid stripped from the area column
            self.assertIn("{&quot;ms&quot;: 120}", filled)  # JSON, not a Python repr
            run("tally.py", a, b, "--fill", page)
            self.assertEqual(page.read_text(), filled)

    def test_ledger_lint_catches_unanchored_unfixed_and_duplicate_findings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = root / "findings.json"
            ledger.write_text(json.dumps([
                {"id": "B1", "sev": "high", "status": "fixed", "ev": "a.ts:1", "fix": "x", "sha": "abc1234"},
                {"id": "B2", "severity": "med", "status": "open", "anchor": "b.ts:2"},
                {"id": "B2", "sev": "low", "status": "fixed", "ev": "c.ts:3", "fix": "y"},
                {"id": "B3", "sev": "low", "status": "open", "fix": "z"},
            ]))
            ok = report(root, "sweep", [("Loads", True, "")])
            res = run("tally.py", ok, "--findings", ledger, "--json")
            self.assertEqual(res.returncode, 1)
            f = json.loads(res.stdout)["findings"]
            self.assertEqual(f["byStatus"], {"fixed": 2, "open": 2})
            self.assertEqual(f["openBySeverity"], {"med": 1, "low": 1})
            self.assertEqual(sorted(f["lint"]), ["B2: fixed with no sha", "B2: open with no fix",
                                                 "B3: no evidence anchor", "duplicate id B2"])

    def test_fill_without_regions_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            page = root / "page.html"
            page.write_text("<p>no markers</p>")
            res = run("tally.py", report(root, "sweep", [("Loads", True, "")]), "--fill", page)
            self.assertEqual(res.returncode, 1)
            self.assertIn("NO REGIONS FOUND", res.stdout)


class DoctorTests(unittest.TestCase):
    def test_bootstrap_vs_existing_blueprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            empty = json.loads(run("doctor.py", "--repo", repo, "--json").stdout)
            self.assertEqual(empty["mode"], "bootstrap")
            (repo / "tools/blueprint").mkdir(parents=True)
            (repo / "tools/blueprint/README.md").write_text("Published at https://claude.ai/artifact/AbC123_x.\n")
            (repo / "docs/blueprints").mkdir(parents=True)
            (repo / "docs/blueprints/app-blueprint.html").write_text("<title>x</title>")
            data = repo / "blueprint-out/data"
            data.mkdir(parents=True)
            shots = report(data, "sweep-run1", [("Loads", True, "")], screenshots=[{"id": "a"}], visualReview="pending")
            review = repo / "blueprint-out/review/sweep-run1"
            review.mkdir(parents=True)
            out = json.loads(run("doctor.py", "--repo", repo, "--json").stdout)
            self.assertEqual(out["mode"], "feature-pass or refresh")
            self.assertEqual(out["reports"], ["docs/blueprints/app-blueprint.html"])
            self.assertEqual(out["publishedUrls"], ["https://claude.ai/artifact/AbC123_x"])
            self.assertFalse(out["blueprintOutIgnored"])
            self.assertTrue(any("not gitignored" in n for n in out["notes"]))
            self.assertTrue(any("not marked reviewed" in n for n in out["notes"]))
            (review / "visual-review.json").write_text(json.dumps(
                {"visualReview": "reviewed", "captureReport": str(shots)}))
            (repo / ".gitignore").write_text("blueprint-out\n")
            out = json.loads(run("doctor.py", "--repo", repo, "--json").stdout)
            self.assertEqual(out["latestRuns"][0]["visualReview"], "reviewed")
            self.assertTrue(out["blueprintOutIgnored"])
            self.assertFalse(any("reviewed" in n or "gitignored" in n for n in out["notes"]))


if __name__ == "__main__":
    unittest.main()
