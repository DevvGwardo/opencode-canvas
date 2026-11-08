from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

MEDIA = Path(__file__).with_name("media.py")


def media(*args, cwd=None):
    return subprocess.run([sys.executable, str(MEDIA), *map(str, args)], capture_output=True, text=True, cwd=cwd)


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for i, c in enumerate(["red", "green", "blue"]):
            Image.new("RGB", (200, 100), c).save(self.root / f"s{i}.png")

    def tearDown(self):
        self.tmp.cleanup()

    def assertClean(self, res, code, text):
        self.assertEqual(res.returncode, code, res.stderr)
        self.assertIn(text, res.stdout + res.stderr)
        self.assertNotIn("Traceback", res.stderr)

    def test_help_anywhere_exits_zero(self):
        self.assertClean(media("sheet", "--help"), 0, "media.py sheet")

    def test_quoted_glob_and_zsh_joined_list_expand(self):
        out = self.root / "deep/dir/sheet.jpg"
        self.assertClean(media("sheet", out, self.root / "s*.png", "--cols", "3"), 0, "sheet.jpg")
        self.assertTrue(out.exists())
        joined = f"{self.root / 's0.png'} {self.root / 's1.png'}"
        self.assertClean(media("pair", self.root / "pair.jpg", joined), 0, "pair.jpg")

    def test_empty_glob_missing_file_and_label_mismatch_fail_clearly(self):
        self.assertClean(media("sheet", self.root / "x.jpg", self.root / "none-*.png"), 1, "glob matched nothing")
        self.assertClean(media("web", self.root / "missing.png", self.root / "x.jpg"), 1, "not found")
        self.assertClean(media("sheet", self.root / "x.jpg", self.root / "s0.png", self.root / "s1.png",
                               "--labels", "only-one"), 1, "1 labels for 2 images")
        self.assertClean(media("sheet", self.root / "x.jpg", self.root / "s0.png", "--h"), 1, "--h needs a value")
        self.assertClean(media("sheet", self.root / "x.jpg", self.root / "s0.png", "--h", "tall"), 1, "bad number")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
    def test_strip_rejects_times_past_the_end(self):
        video = self.root / "v.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
                        "-t", "1", "-pix_fmt", "yuv420p", str(video)], check=True)
        self.assertClean(media("strip", self.root / "ok.jpg", video, "0.2", "0.8"), 0, "ok.jpg")
        self.assertClean(media("strip", self.root / "late.jpg", video, "0.5", "3"), 1, "past the end")


if __name__ == "__main__":
    unittest.main()
