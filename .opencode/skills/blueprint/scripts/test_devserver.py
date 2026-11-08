import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

DEV = Path(__file__).with_name("devserver.py")


def dev(*args, cwd):
    r = subprocess.run([sys.executable, str(DEV), *map(str, args)], capture_output=True, text=True, cwd=cwd, timeout=60)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1]), r.stderr


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DevServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "index.html").write_text("<h1>Counter app</h1>")
        self.url = f"http://127.0.0.1:{free_port()}/"
        self.server = [sys.executable, "-m", "http.server", self.url.split(":")[2].strip("/"), "--bind", "127.0.0.1"]

    def tearDown(self):
        dev("stop", "--url", self.url, cwd=self.root)
        self.tmp.cleanup()

    def test_start_returns_once_ready_and_stop_kills_it(self):
        code, out, _ = dev("start", "--url", self.url, "--expect", "Counter app", "--", *self.server, cwd=self.root)
        self.assertEqual(code, 0)
        self.assertTrue(out["owned"])
        self.assertTrue(Path(out["log"]).is_file())
        code, again, _ = dev("start", "--url", self.url, "--", *self.server, cwd=self.root)
        self.assertEqual((code, again["note"], again["pid"]), (0, "already running", out["pid"]))
        code, stopped, _ = dev("stop", "--url", self.url, cwd=self.root)
        self.assertTrue(stopped["stopped"])
        code, status, _ = dev("status", "--url", self.url, cwd=self.root)
        self.assertFalse(status["answering"])

    def test_refuses_a_port_someone_else_is_serving(self):
        other = subprocess.Popen(self.server, cwd=self.root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            code, out, _ = dev("wait", "--url", self.url, "--timeout", "10", cwd=self.root)
            self.assertEqual(out["status"], "ok")
            code, out, _ = dev("start", "--url", self.url, "--", *self.server, cwd=self.root)
            self.assertEqual(code, 3)
            self.assertFalse(out["owned"])
            code, out, _ = dev("stop", "--url", self.url, cwd=self.root)
            self.assertFalse(out["stopped"])
            self.assertIsNone(other.poll())  # never touches a server it didn't start
        finally:
            other.kill()

    def test_command_that_dies_reports_its_log(self):
        cmd = [sys.executable, "-c", "print('boom: port in use'); raise SystemExit(2)"]
        t = time.time()
        code, out, err = dev("start", "--url", self.url, "--timeout", "30", "--", *cmd, cwd=self.root)
        self.assertEqual((code, out["status"], out["exitCode"]), (1, "exited", 2))
        self.assertIn("boom: port in use", err)
        self.assertLess(time.time() - t, 10)

    def test_wrong_app_is_not_ready(self):
        code, out, _ = dev("start", "--url", self.url, "--expect", "Some other app", "--timeout", "8",
                           "--", *self.server, cwd=self.root)
        self.assertEqual((code, out["status"]), (1, "wrong-app"))
        code, status, _ = dev("status", "--url", self.url, cwd=self.root)
        self.assertFalse(status["answering"])  # the mismatched server was cleaned up


if __name__ == "__main__":
    unittest.main()
