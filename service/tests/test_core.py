import asyncio
import os
import stat
import tempfile
import unittest
from pathlib import Path

from cronboard_service import core

# A stand-in crontab that keeps its "crontab" in a file, so the tests never touch the real one.
FAKE = """#!/bin/sh
f="$FAKE_CRONTAB"
case "$1" in
  -l) [ -f "$f" ] && cat "$f" || { echo "no crontab for tester" >&2; exit 1; } ;;
  -) cat >"$f" ;;
esac
"""


class CoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        fake = self.tmp / "crontab"
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.env = {
            "PATH": f"{self.tmp}:{os.environ['PATH']}",
            "FAKE_CRONTAB": str(self.tmp / "stored"),
            "XDG_DATA_HOME": str(self.tmp / "data"),
        }
        self.saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_no_crontab_reads_as_empty(self):
        self.assertEqual(asyncio.run(core.read()), "")

    def test_write_then_read_and_backup(self):
        asyncio.run(core.write("0 5 * * * a", ""))
        self.assertEqual(asyncio.run(core.read()), "0 5 * * * a\n")  # final newline added
        asyncio.run(core.write("0 6 * * * b\n", "0 5 * * * a\n"))
        backups = list((self.tmp / "data" / "cronboard" / "backups").glob("crontab-*.txt"))
        self.assertEqual([b.read_text() for b in backups], ["0 5 * * * a\n"])

    def test_write_refuses_when_crontab_changed(self):
        asyncio.run(core.write("x\n", ""))
        with self.assertRaises(core.Conflict):
            asyncio.run(core.write("y\n", "something else\n"))
        self.assertEqual(asyncio.run(core.read()), "x\n")

    def test_missing_crontab_command(self):
        os.environ["PATH"] = "/nonexistent"
        with self.assertRaises(core.NotInstalled):
            asyncio.run(core.read())


if __name__ == "__main__":
    unittest.main()
