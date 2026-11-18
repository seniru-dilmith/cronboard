"""Cron jobs: listing, changing and running them. No D-Bus in here, so it can be tested directly."""

import asyncio
import hashlib
import os
import pwd
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

from . import parser, schedule

BACKUPS_KEPT = 20


class NotInstalled(Exception):
    pass


class Conflict(Exception):
    pass


class Invalid(Exception):
    """The job the user entered can't be saved; the message says why."""


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


def state_dir():
    """Where tracked jobs record their last run (see the tracked command in parser.py)."""
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "cronboard"


def _job_id(job):
    """Its line number plus a hash of the line, so an id stops matching once the line changes."""
    return f"{job.index}:{hashlib.sha1(job.line.raw.encode()).hexdigest()[:12]}"


async def _load(job_id):
    """(crontab text, its lines, the job with that id); Conflict when the job is gone or changed."""
    text = await read()
    lines = parser.parse(text)
    job = next((j for j in parser.jobs(lines) if _job_id(j) == job_id), None)
    if job is None:
        raise Conflict()
    return text, lines, job


def _last_run(track_id):
    """(exit status, finish time) of a tracked job's last run, or None (it's informational, so errors count as none)."""
    try:
        exit_status, finished = (state_dir() / f"{track_id}.status").read_text().split()
        return int(exit_status), datetime.fromtimestamp(int(finished))
    except (OSError, ValueError, OverflowError):
        return None


def _forget_runs(track_id):
    for ext in ("status", "log"):
        (state_dir() / f"{track_id}.{ext}").unlink(missing_ok=True)


async def list_jobs():
    now = datetime.now()
    home = str(Path.home())
    out = []
    for job in parser.jobs(parser.parse(await read())):
        line = job.line
        runs = schedule.next_runs(line.schedule, now, 1) if line.enabled else []
        last = _last_run(line.track.id) if line.track else None
        command, log = parser.split_log(line.command)
        logs = [parser.log_file(line.command, home), line.track and str(state_dir() / f"{line.track.id}.log")]
        out.append({
            "id": _job_id(job),
            "name": job.name or "",
            "command": line.command,
            "edit_command": command,  # the editor shows the log file in its own field
            "edit_log": log or "",
            "schedule": line.schedule,
            "description": schedule.describe(line.schedule),
            "next_run": schedule.format_when(runs[0], now) if runs else "",
            "enabled": line.enabled,
            "tracked": line.track is not None,
            "last_run": schedule.format_when(last[1], now) if last else "",
            "last_exit": last[0] if last else 0,
            "log_paths": [p for p in logs if p],  # the command's own log first, then the tracked one
        })
    return out


def _fields(fields, old_track):
    """Checks and normalises what the editor sent: name, command, log, schedule, tracked."""
    expr = " ".join(fields.get("schedule", "").split())
    command = fields.get("command", "").strip()
    log = fields.get("log", "").strip()
    full = parser.with_log(command, log)
    error = schedule.validate(expr) or parser.check_command(command) or parser.check_command(full)
    if error:
        raise Invalid(error)
    if log:
        # Cron can't write the log if its folder is missing; relative paths are from $HOME, like cron's.
        path = Path.home() / re.sub(r"^~/", "", log)
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            pass  # cron will report it when the job runs; not a reason to refuse the save
    track = None
    if fields.get("tracked"):
        track = parser.Track(str(state_dir()), old_track.id if old_track else uuid.uuid4().hex[:8])
    return parser.JobFields(expr, full, " ".join(fields.get("name", "").split()) or None, track)


async def set_enabled(job_id, enabled):
    text, lines, job = await _load(job_id)
    await write(parser.serialize(parser.set_enabled(lines, job.index, enabled)), text)


async def add_job(fields):
    text = await read()
    await write(parser.serialize(parser.add_job(parser.parse(text), _fields(fields, None))), text)


async def update_job(job_id, fields):
    text, lines, job = await _load(job_id)
    f = _fields(fields, job.line.track)
    await write(parser.serialize(parser.update_job(lines, job.index, f)), text)
    if job.line.track and not f.track:
        _forget_runs(job.line.track.id)


async def delete_job(job_id):
    text, lines, job = await _load(job_id)
    await write(parser.serialize(parser.delete_job(lines, job.index)), text)
    if job.line.track:
        _forget_runs(job.line.track.id)


async def run_now(job_id):
    """Runs a job now the way cron would: a minimal environment plus the crontab's own variables,
    through $SHELL -c, with cron's % rule for stdin. Returns what run_job returns.
    """
    _, _, job = await _load(job_id)
    user = pwd.getpwuid(os.getuid()).pw_name
    env = {"HOME": str(Path.home()), "LOGNAME": user, "USER": user, "SHELL": "/bin/sh", "PATH": "/usr/bin:/bin",
           **job.env}
    cmd, stdin = parser.split_percent(parser.line_command(job.line))
    shell = env["SHELL"]
    if stdin is None:
        argv = [shell, "-c", cmd]
    else:
        argv = [shell, "-c", 'printf "%s" "$1" | "$0" -c "$2"', shell, stdin if stdin.endswith("\n") else stdin + "\n", cmd]
    return await run_job(argv, env)
