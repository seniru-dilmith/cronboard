"""Crontab access and job running. No D-Bus in here, so it can be tested directly."""

import asyncio
import os
import re
import time
from pathlib import Path

BACKUPS_KEPT = 20


class NotInstalled(Exception):
    pass


class Conflict(Exception):
    pass


async def _run(argv, stdin=None, env=None):
    """Runs a command and returns (exit status, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "LC_ALL": "C", **(env or {})},  # stable messages to match on
        )
    except FileNotFoundError as e:
        raise NotInstalled(argv[0]) from e
    out, err = await proc.communicate(stdin.encode() if stdin is not None else None)
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def read():
    """The current crontab text; '' when the user has none."""
    status, out, err = await _run(["crontab", "-l"])
    if status == 0:
        return out
    if err.startswith("no crontab for "):
        return ""
    raise RuntimeError(err.strip() or f"crontab -l exited with status {status}")


def _backup_dir():
    data = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(data) / "cronboard" / "backups"


def _backup(text):
    folder = _backup_dir()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
    (folder / f"crontab-{stamp}.txt").write_text(text)
    for old in sorted(p for p in folder.glob("crontab-*.txt"))[:-BACKUPS_KEPT]:
        old.unlink(missing_ok=True)


async def write(text, snapshot):
    """Installs text as the crontab, but only if it still matches what the caller last read.

    The previous crontab is backed up first.
    ponytail: the re-read and the install aren't atomic; flock(1) on a lock file would close that gap.
    """
    current = await read()
    if current != snapshot:
        raise Conflict()
    if text == current:
        return
    if current:
        _backup(current)
    data = text if text == "" or text.endswith("\n") else text + "\n"  # cron needs a final newline
    status, _, err = await _run(["crontab", "-"], stdin=data)
    if status != 0:
        raise RuntimeError(err.strip() or f"crontab exited with status {status}")


async def run_job(argv, env):
    """Runs a job now in a transient systemd user unit, so it isn't a child of this service.

    Waits for it to end and returns (the job's exit status, stderr); a non-empty stderr
    means systemd-run itself failed. The job's own output goes to the user journal.
    """
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    bus = Path(runtime) / "bus"
    # Shells started with dbus-run-session (nested or test sessions) have a private bus without systemd on it.
    bus_env = {"DBUS_SESSION_BUS_ADDRESS": f"unix:path={bus}"} if bus.exists() else {}
    unit = f"cronboard-run-{time.time_ns() // 1000}"
    status, _, err = await _run(
        ["systemd-run", "--user", "--wait", "--collect", "--quiet", f"--unit={unit}",
         f"--working-directory={env.get('HOME', str(Path.home()))}", "--",
         "/usr/bin/env", "-i", *(f"{k}={v}" for k, v in env.items()), *argv],
        env=bus_env,
    )
    return status, err


async def cron_active():
    """False when a known cron service exists but isn't running."""
    try:
        _, out, _ = await _run(["systemctl", "is-active", "cron.service", "crond.service", "cronie.service"])
    except NotInstalled:
        return True  # no systemctl: we can't tell, so don't warn
    return re.search(r"^active$", out, re.M) is not None
