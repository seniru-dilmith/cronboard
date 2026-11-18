"""Cron schedules: validation, next run times, readable descriptions and the editor presets."""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta

SPECIALS = {
    "@reboot": "",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]
WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


@dataclass(frozen=True)
class _Field:
    name: str
    lo: int
    hi: int
    names: tuple = ()
    first: int = 0  # value of names[0]


FIELDS = [
    _Field("minute", 0, 59),
    _Field("hour", 0, 23),
    _Field("day of month", 1, 31),
    _Field("month", 1, 12, tuple(MONTHS), 1),
    _Field("day of week", 0, 7, tuple(WEEKDAYS), 0),
]


@dataclass
class Cron:
    reboot: bool
    minute: set = field(default_factory=set)
    hour: set = field(default_factory=set)
    dom: set = field(default_factory=set)
    month: set = field(default_factory=set)
    dow: set = field(default_factory=set)
    # Vixie cron rule: if either day field starts with '*', a day must match
    # both fields; if both are restricted, matching either one is enough.
    dom_star: bool = False
    dow_star: bool = False


_PART = re.compile(r"(?:\*|([A-Za-z0-9_]+)(?:-([A-Za-z0-9_]+))?)(?:/([0-9]+))?")


def _num(s):
    return int(s) if re.fullmatch(r"[0-9]+", s) else None


def _expand(expr):
    return re.split(r"\s+", SPECIALS.get(expr, expr))


def _value(token, f):
    n = _num(token)
    if n is not None:
        return n
    return next((i + f.first for i, name in enumerate(f.names) if name[:3].lower() == token.lower()), None)


def _parse_field(text, f):
    out = set()
    for part in text.split(","):
        m = _PART.fullmatch(part)
        if not m:
            return f'Invalid {f.name}: "{part}"'
        start, end, step_text = m.groups()
        # ponytail: "N/S" (a step without a range) is rejected; some crons accept it as N-max/S.
        if start is not None and end is None and step_text is not None:
            return f'Invalid {f.name}: "{part}" (a step needs a range or *)'
        lo = f.lo if start is None else _value(start, f)
        hi = f.hi if start is None else lo if end is None else _value(end, f)
        step = 1 if step_text is None else int(step_text)
        if lo is None or hi is None or lo < f.lo or hi > f.hi or lo > hi:
            return f'Invalid {f.name}: "{part}" (allowed {f.lo}-{f.hi})'
        if step < 1:
            return f'Invalid {f.name}: "{part}" (step must be at least 1)'
        out.update(range(lo, hi + 1, step))
    return out


def parse_schedule(expr):
    """Parses a 5-field expression or @special. Returns an error message on failure."""
    text = expr.strip()
    if text == "@reboot":
        return Cron(reboot=True)
    if text.startswith("@") and text not in SPECIALS:
        return f'Unknown schedule "{text}"'
    fields = _expand(text)
    if len(fields) != 5:
        return "A cron expression needs 5 fields: minute, hour, day of month, month, day of week"
    sets = []
    for text_field, f in zip(fields, FIELDS):
        parsed = _parse_field(text_field, f)
        if isinstance(parsed, str):
            return parsed
        sets.append(parsed)
    minute, hour, dom, month, dow = sets
    if 7 in dow:
        dow.add(0)
    return Cron(False, minute, hour, dom, month, dow, fields[2].startswith("*"), fields[4].startswith("*"))


def validate(expr):
    """None when the expression is valid, otherwise an error message."""
    cron = parse_schedule(expr)
    return cron if isinstance(cron, str) else None


def _weekday(d):
    return d.isoweekday() % 7  # 0 = Sunday, like cron


def _day_matches(c, d):
    dom = d.day in c.dom
    dow = _weekday(d) in c.dow
    return dom and dow if c.dom_star or c.dow_star else dom or dow


def next_runs(expr, start, count):
    """The next `count` run times strictly after `start` (naive local time).

    ponytail: cron's DST special cases are ignored; these times are for display.
    """
    c = parse_schedule(expr)
    if isinstance(c, str) or c.reboot:
        return []
    runs = []
    d = start.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = start + timedelta(days=5 * 366)
    while len(runs) < count and d < limit:
        if d.month not in c.month:
            d = (d.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
        elif not _day_matches(c, d):
            d = d.replace(hour=0, minute=0) + timedelta(days=1)
        elif d.hour not in c.hour:
            d = d.replace(minute=0) + timedelta(hours=1)
        elif d.minute not in c.minute:
            d += timedelta(minutes=1)
        else:
            runs.append(d)
            d += timedelta(minutes=1)
    return runs


def _pad(n):
    return f"{n:02d}"


def _step_of(s):
    m = re.fullmatch(r"\*/([0-9]+)", s)
    return int(m[1]) if m else None


def _range_of(s):
    m = re.fullmatch(r"([0-9]+)-([0-9]+)", s)
    return (int(m[1]), int(m[2])) if m else None


def _list(items):
    return "".join(items) if len(items) < 2 else f"{', '.join(items[:-1])} and {items[-1]}"


def _every(n, unit):
    return f"every {unit}" if n == 1 else f"every {n} {unit}s"


def _ordinal(n):
    teen = 11 <= n % 100 <= 13
    return f"{n}{'th' if teen or n % 10 > 3 else ('th', 'st', 'nd', 'rd')[n % 10]}"


def _time_phrase(mi, h):
    """Schedules that repeat within a day: "every 15 minutes", "every 2 hours at :30"."""
    m, hour = _num(mi), _num(h)
    m_step, h_step, h_range = _step_of(mi), _step_of(h), _range_of(h)
    minutes = "every minute" if mi == "*" else _every(m_step, "minute") if m_step else None
    if minutes and h == "*":
        return minutes
    if minutes and hour is not None:
        return f"{minutes} from {_pad(hour)}:00 to {_pad(hour)}:59"
    if minutes and h_range:
        return f"{minutes} from {_pad(h_range[0])}:00 to {_pad(h_range[1])}:59"
    past = f" at :{_pad(m)}" if m else ""
    if m is not None and h == "*":
        return f"every hour{past}"
    if m is not None and h_step:
        return f"{_every(h_step, 'hour')}{past}"
    if m is not None and h_range:
        return f"every hour from {_pad(h_range[0])}:{_pad(m)} to {_pad(h_range[1])}:{_pad(m)}"
    return f"at minute {mi} past hour {h}"


def _day_phrase(c, dom, dow, months):
    """("every weekday", "on weekdays"), ("on the 1st of every month", ...), ..."""
    if dom == "*" and dow == "*":
        return "every day", ""
    weekdays = sorted({d % 7 for d in c.dow}, key=lambda d: (d + 6) % 7)
    workweek = weekdays == [1, 2, 3, 4, 5]
    names = _list([WEEKDAYS[d] for d in weekdays])
    dow_every = "every weekday" if workweek else f"every {names}"
    dow_on = "on weekdays" if workweek else f"on {names}"
    if dom == "*":
        return dow_every, dow_on
    dom_text = f"the {_list([_ordinal(d) for d in sorted(c.dom)])}" if len(c.dom) <= 5 else f"day {dom}"
    on_dom = f"on {dom_text} of {months or 'every month'}"
    if dow == "*":
        return on_dom, on_dom
    if c.dom_star or c.dow_star:
        return f"{on_dom}, only {dow_on}", f"{on_dom}, only {dow_on}"
    return f"{on_dom} and {dow_every}", f"{on_dom} and {dow_on}"


def describe(expr):
    """Human-readable text, e.g. "every weekday at 09:00". Invalid input is returned as is."""
    text = expr.strip()
    c = parse_schedule(text)
    if isinstance(c, str):
        return text
    if c.reboot:
        return "at startup"
    mi, h, dom, mon, dow = _expand(text)
    months = "" if mon == "*" else _list([MONTHS[m - 1] for m in sorted(c.month)])
    every, on = _day_phrase(c, dom, dow, months)
    in_months = f" in {months}" if months and dom == "*" else ""
    m, hour = _num(mi), _num(h)
    if m is not None and hour is not None:
        return f"{every} at {_pad(hour)}:{_pad(m)}{in_months}"
    if m is not None and re.fullmatch(r"[0-9]+(,[0-9]+)+", h) and len(c.hour) <= 4:
        return f"{every} at {_list([f'{_pad(x)}:{_pad(m)}' for x in sorted(c.hour)])}{in_months}"
    return f"{_time_phrase(mi, h)}{' ' + on if on else ''}{in_months}"


def format_when(date, now):
    """Short relative date: "today 09:00", "tomorrow 09:00", "Mon 09:00", "12 Nov 09:00"."""
    time = f"{_pad(date.hour)}:{_pad(date.minute)}"
    days = (date.date() - now.date()).days
    if days == 0:
        return f"today {time}"
    if days == 1:
        return f"tomorrow {time}"
    if days == -1:
        return f"yesterday {time}"
    if abs(days) < 7:
        return f"{WEEKDAYS[_weekday(date)][:3]} {time}"
    year = "" if date.year == now.year else f" {date.year}"
    return f"{date.day} {MONTHS[date.month - 1][:3]}{year} {time}"


def expr_to_preset(expr):
    """Which editor preset (and options) an expression corresponds to; 'custom' if none."""
    options = {"minute": 0, "hour": 9, "weekday": 1, "day": 1}
    text = expr.strip()
    if text == "@reboot":
        return "reboot", options
    if validate(text) is not None:
        return "custom", options
    fields = _expand(text)
    if fields == ["*"] * 5:
        return "minute", options
    mi, h, dom, mon, dow = fields
    minute, hour, day, weekday = _num(mi), _num(h), _num(dom), _num(dow)
    if minute is None or mon != "*":
        return "custom", options
    options["minute"] = minute
    if h == "*" and dom == "*" and dow == "*":
        return "hourly", options
    if hour is None:
        return "custom", options
    options["hour"] = hour
    if dom == "*" and dow == "*":
        return "daily", options
    if dom == "*" and weekday is not None:
        options["weekday"] = weekday % 7
        return "weekly", options
    if dow == "*" and day is not None:
        options["day"] = day
        return "monthly", options
    return "custom", options


def check(expr, now=None):
    """Everything the editor shows about the expression being typed."""
    now = now or datetime.now()
    error = validate(expr) or ""
    preset, options = expr_to_preset(expr)
    if error:
        next_text = ""
    elif runs := next_runs(expr, now, 5):
        next_text = "Next: " + ", ".join(format_when(d, now) for d in runs)
    else:
        next_text = "Runs when the computer starts" if expr.strip() == "@reboot" else "Never runs: no date matches"
    return {"error": error, "description": "" if error else describe(expr), "next": next_text,
            "preset": preset, **options}
