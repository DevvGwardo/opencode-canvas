import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
import capture_pip


def windows():
    return [
        {"pid": 10, "window_id": 20, "title": "Hermes Desk", "app_name": "Electron"},
        {"pid": 10, "window_id": 21, "title": "Computer · Hermes Desk",
         "app_name": "Electron", "is_on_screen": True, "on_current_space": True},
        {"pid": 11, "window_id": 22, "title": "Computer · Hermes Desk",
         "app_name": "Electron", "is_on_screen": True, "on_current_space": True},
    ]


class CaptureTests(unittest.TestCase):
    def test_selection_requires_exact_owner_visibility_and_unambiguous_target(self):
        self.assertEqual(capture_pip.select_window(windows(), 10)["window_id"], 21)
        for pid, wid in [(11, None), (10, 22), (10, 20)]:
            with self.subTest(pid=pid, wid=wid), self.assertRaises(RuntimeError):
                capture_pip.select_window(windows(), pid, wid)
        for key in ["is_on_screen", "on_current_space"]:
            entries = windows()
            entries[1][key] = False
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                capture_pip.select_window(entries, 10)
        entries = windows() + [{**windows()[1], "window_id": 23}]
        with self.assertRaises(RuntimeError):
            capture_pip.select_window(entries, 10)
        self.assertEqual(capture_pip.select_window(entries, 10, 23)["window_id"], 23)
        browser_windows = [{**w, "app_name": "Google Chrome"} for w in windows()]
        with self.assertRaises(RuntimeError):
            capture_pip.select_window(browser_windows, 10)

    def test_capture_preserves_provenance_and_never_reuses_or_accepts_blank_evidence(self):
        def fake_driver(tool, args):
            if tool == "list_windows":
                return {"windows": windows()}
            self.assertEqual((args["pid"], args["window_id"]), (10, 21))
            self.assertFalse(args["include_accessibility_tree"])
            image = Image.new("RGB", (80, 60), "black")
            ImageDraw.Draw(image).rectangle((10, 10, 40, 40), fill="white")
            image.save(args["screenshot_out_file"])
            return {"window_title": "Computer · Hermes Desk", "screenshot_scale": 2}

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            capture_pip, "driver", side_effect=fake_driver
        ):
            a, ap = capture_pip.capture(Path(tmp), 10, None, "test")
            b, bp = capture_pip.capture(Path(tmp), 10, None, "test")
            self.assertEqual(a["status"], "captured")
            self.assertNotEqual(ap, bp)
            self.assertNotEqual(a["image"]["path"], b["image"]["path"])
            self.assertEqual(a["image"]["sha256"], b["image"]["sha256"])
            self.assertEqual((a["image"]["width"], a["image"]["height"]), (80, 60))
            self.assertEqual(a["visualReview"], "not_reviewed")
            self.assertEqual(a["behavioralVerification"], "not_tested")
            self.assertEqual(json.loads(ap.read_text()), a)
            for color in ["black", (0, 0, 0, 0)]:
                Image.new("RGBA", (80, 60), color).save(a["image"]["path"])
                with self.assertRaises(RuntimeError):
                    capture_pip.image_metadata(Path(a["image"]["path"]))
            Path(a["image"]["path"]).write_bytes(b"not a PNG")
            with self.assertRaises(OSError):
                capture_pip.image_metadata(Path(a["image"]["path"]))

            with patch.object(capture_pip, "driver", side_effect=RuntimeError("denied")):
                failed, fp = capture_pip.capture(Path(tmp), 10, None, "denied")
            self.assertEqual(failed["status"], "failed")
            self.assertFalse(failed["checks"][-1]["ok"])
            self.assertNotIn("image", failed)
            self.assertTrue(fp.exists())


if __name__ == "__main__":
    unittest.main()
