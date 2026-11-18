"""Crontab text <-> lines.

Every line keeps its raw text and only the lines the user edits are rewritten, so
everything Cronboard doesn't manage (comments, blank lines, env vars, lines it
can't parse) survives byte for byte.
"""

import re
from dataclasses import dataclass
from typing import NamedTuple, Optional

from .schedule import validate

DISABLED_MARKER = "#cronboard-disabled# "

# "Any character but a line break", like `.` in the JavaScript this was ported from, so a
# CRLF line is classified the same way it always was.
_ANY = r"[^\n\r\u2028\u2029]"


class Track(NamedTuple):
    dir: str  # absolute folder where the run's log and status are written
    id: str


@dataclass(frozen=True)
class Line:
    kind: str  # 'job', 'env' or 'other'
    raw: str
    key: str = ""  # env
    value: str = ""  # env
    schedule: str = ""  # job
    command: str = ""  # job
    enabled: bool = True  # job
    track: Optional[Track] = None  # job


class Job(NamedTuple):
    index: int
    line: Line
    name: Optional[str]
    env: dict  # variables in effect at this job's position


class JobFields(NamedTuple):
    schedule: str
    command: str
    name: Optional[str]
    track: Optional[Track] = None


_ENV = re.compile(rf"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*({_ANY}*?)\s*")
# Tracked jobs record their output and exit status around the command, see _tracked_command().
_TRACKED = re.compile(rf"mkdir -p '((?:[^']|'\\'')*)'; \( ({_ANY}*) \) >'{_ANY}*/([0-9a-f]+)\.log' 2>&1; echo ")
_SPECIAL_JOB = re.compile(rf"(@[A-Za-z0-9_]+)\s+(\S{_ANY}*)")
_JOB = re.compile(rf"(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S{_ANY}*)")
_NAME = re.compile(rf"\s*#\s*(\S{_ANY}*?)\s*")


def _unquote(value):
    q = value[:1]
    return value[1:-1] if len(value) >= 2 and q in ('"', "'") and value.endswith(q) else value


def _shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def _parse_job(text):
    body = text.lstrip()
    m = (_SPECIAL_JOB if body.startswith("@") else _JOB).fullmatch(body)
    if not m or validate(m[1]) is not None:
        return None
    schedule = " ".join(re.split(r"\s+", m[1]))
    t = _TRACKED.match(m[2])
    if t:
        track = Track(t[1].replace("'\\''", "'"), t[3])
        # Only a line that is exactly what we would write counts as tracked; anything else stays a plain command.
        if _tracked_command(t[2], track) == m[2]:
            return {"schedule": schedule, "command": t[2], "track": track}
    return {"schedule": schedule, "command": m[2]}


def _parse_line(raw):
    """Same order as Debian cron: env assignment first, then job, else leave it alone."""
    env = _ENV.fullmatch(raw)
    if env:
        return Line("env", raw, key=env[1], value=_unquote(env[2]))
    enabled = not raw.startswith(DISABLED_MARKER)
    job = _parse_job(raw if enabled else raw[len(DISABLED_MARKER):])
    return Line("job", raw, enabled=enabled, **job) if job else Line("other", raw)


def parse(text):
    return [_parse_line(raw) for raw in text.split("\n")]


def serialize(lines):
    return "\n".join(line.raw for line in lines)


def _name_at(lines, index):
    """A job's name is the plain comment directly above it."""
    prev = lines[index - 1] if index > 0 else None
    if prev is None or prev.kind != "other" or prev.raw.startswith(DISABLED_MARKER):
        return None
    m = _NAME.fullmatch(prev.raw)
    return m[1] if m else None


def jobs(lines):
    env = {}
    out = []
    for index, line in enumerate(lines):
        if line.kind == "env":
            env[line.key] = line.value
        elif line.kind == "job":
            out.append(Job(index, line, _name_at(lines, index), dict(env)))
    return out


def _tracked_command(command, track):
    """The command wrapped so cron records its output (the last run only) in <dir>/<id>.log and its
    exit status and finish time in <dir>/<id>.status, which Cronboard reads for the menu and log viewer.
    The status is written under a dot name and renamed so a reader never sees half of it.
    ponytail: a dir containing % would need escaping for cron; the state dir is under $HOME, so it's skipped.
    """
    def at(name):
        return _shell_quote(f"{track.dir}/{name}")
    return (f"mkdir -p {_shell_quote(track.dir)}; ( {command} ) >{at(f'{track.id}.log')} 2>&1; "
            f'echo "$? $(date +\\%s)" >{at(f".{track.id}.status.tmp")} && mv {at(f".{track.id}.status.tmp")} {at(f"{track.id}.status")}')


def line_command(f):
    """The command part of the line as cron sees it (wrapped when tracked)."""
    return _tracked_command(f.command, f.track) if f.track else f.command


def format_job(f, enabled=True):
    return f"{'' if enabled else DISABLED_MARKER}{f.schedule} {line_command(f)}"


def check_command(command):
    """None if the command can go on a crontab line, otherwise why not."""
    if not command.strip():
        return "Enter a command"
    if re.search(r"[\r\n]", command):
        return "The command must be a single line"
    return None


_REDIRECT = re.compile(r"""(?:^|[^0-9&<>])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))""")


def log_file(command, home):
    """The file a command sends its output to (`cmd >> file` or `cmd > file`), as an absolute path,
    or None if it has none. Cron runs jobs from $HOME, so relative paths and `~` resolve there.
    ponytail: paths with other variables in them (`$LOGDIR/x.log`) are skipped rather than guessed.
    """
    for m in _REDIRECT.finditer(command):
        path = re.sub(r"^(~|\$HOME|\$\{HOME\})(?=/)", lambda _: home, m[1] or m[2] or m[3])
        if path == "/dev/null" or "$" in path:
            continue
        return path if path.startswith("/") else f"{home}/{path}"
    return None


# A trailing `>> file 2>&1`, the form the editor's Log file field writes.
_LOG_SUFFIX = re.compile(rf"""\s+>>\s*((?:\\{_ANY}|[^\s;&|<>'"\\]|'[^']*'|"[^"]*")+)\s+2>&1\s*\Z""")


def split_log(command):
    """Splits the editor's log file off a command: (command, log), or (command, None) if it doesn't end in one."""
    m = _LOG_SUFFIX.search(command)
    if not m:
        return command, None
    log = re.sub(rf"""'([^']*)'|"([^"]*)"|\\({_ANY})""", lambda q: "".join(g or "" for g in q.groups()), m[1])
    return command[:m.start()], log


def with_log(command, log):
    """Appends `>> log 2>&1`, quoting the path when needed but keeping a leading `~/` so the shell expands it."""
    log = log.strip()
    if not log:
        return command

    def quote(s):
        return s if re.fullmatch(r"[A-Za-z0-9_./+-]+", s) else _shell_quote(s)
    path = f"~/{quote(log[2:])}" if log.startswith("~/") else quote(log)
    return f"{command} >> {path} 2>&1"


def _spliced(lines, start, remove, *add):
    return lines[:start] + [_parse_line(raw) for raw in add] + lines[start + remove:]


def _job_at(lines, index):
    line = lines[index] if 0 <= index < len(lines) else None
    if line is None or line.kind != "job":
        raise ValueError(f"Line {index + 1} is not a cron job")
    return line


def set_enabled(lines, index, enabled):
    """Adds or strips the disabled marker; toggling back is byte-exact."""
    line = _job_at(lines, index)
    if line.enabled == enabled:
        return lines
    raw = line.raw[len(DISABLED_MARKER):] if enabled else DISABLED_MARKER + line.raw
    return _spliced(lines, index, 1, raw)


def update_job(lines, index, f):
    """Rewrites a job and its name comment, keeping raw text for whatever didn't change."""
    line = _job_at(lines, index)
    old_name = _name_at(lines, index)
    same = line.schedule == f.schedule and line.command == f.command and line.track == f.track
    job = line.raw if same else format_job(f, line.enabled)
    name = [] if not f.name else [lines[index - 1].raw] if f.name == old_name else [f"# {f.name}"]
    if old_name is not None:
        return _spliced(lines, index - 1, 2, *name, job)
    return _spliced(lines, index, 1, *name, job)


def add_job(lines, f):
    """Appends a job (new jobs inherit the env vars set above them)."""
    # Insert before the final empty element so a trailing newline stays last.
    end = len(lines) - 1 if lines and lines[-1].raw == "" else len(lines)
    return _spliced(lines, end, 0, *([f"# {f.name}"] if f.name else []), format_job(f))


def delete_job(lines, index):
    _job_at(lines, index)
    return _spliced(lines, index - 1, 2) if _name_at(lines, index) is not None else _spliced(lines, index, 1)


def split_percent(command):
    """Cron's % rule: text after the first unescaped % is fed to the command on
    stdin, with any further % turned into newlines; \\% is a literal %.
    Returns (cmd, stdin), stdin None when there is no %.
    """
    cmd, stdin = "", None
    i = 0
    while i < len(command):
        c = command[i]
        if c == "\\" and command[i + 1:i + 2] == "%":
            c = "%"
            i += 1
        elif c == "%":
            if stdin is None:
                stdin = ""
                i += 1
                continue
            c = "\n"
        if stdin is None:
            cmd += c
        else:
            stdin += c
        i += 1
    return cmd, stdin

