"""The Cronboard session D-Bus service."""

import asyncio
import os
import sys
from pathlib import Path

from dbus_fast import BusType, DBusError, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.constants import RequestNameReply
from dbus_fast.service import ServiceInterface, method, signal

from . import core, schedule

NAME = "io.github.seniru_dilmith.Cronboard"
PATH = "/io/github/seniru_dilmith/Cronboard"
STATUS_POLL_SECONDS = 2


def _variant(value):
    sig = "b" if isinstance(value, bool) else "i" if isinstance(value, int) else "as" if isinstance(value, list) else "s"
    return Variant(sig, value)


def _dict(d):
    return {k: _variant(v) for k, v in d.items()}


def _plain(fields):
    return {k: v.value for k, v in fields.items()}


class Cronboard(ServiceInterface):
    """The extension and its preferences only show what this returns and send actions back."""

    def __init__(self):
        super().__init__(NAME)

    @method()
    async def ListJobs(self) -> "aa{sv}":
        return [_dict(job) for job in await self._guard(core.list_jobs())]

    @method()
    async def SetEnabled(self, id: "s", enabled: "b"):
        await self._change(core.set_enabled(id, enabled))

    @method()
    async def AddJob(self, fields: "a{sv}"):
        await self._change(core.add_job(_plain(fields)))

    @method()
    async def UpdateJob(self, id: "s", fields: "a{sv}"):
        await self._change(core.update_job(id, _plain(fields)))

    @method()
    async def DeleteJob(self, id: "s"):
        await self._change(core.delete_job(id))

    @method()
    async def RunNow(self, id: "s") -> "is":
        return list(await self._guard(core.run_now(id)))

    @method()
    def CheckSchedule(self, expr: "s") -> "a{sv}":
        return _dict(schedule.check(expr))

    @method()
    async def CronActive(self) -> "b":
        return await core.cron_active()

    @signal()
    def JobsChanged(self):
        pass

    async def _change(self, awaitable):
        await self._guard(awaitable)
        self.JobsChanged()

    @staticmethod
    async def _guard(awaitable):
        """Turns the core's errors into D-Bus errors the extension tells apart by name."""
        try:
            return await awaitable
        except core.NotInstalled:
            raise DBusError(f"{NAME}.Error.NotInstalled", "cron is not installed: the crontab command was not found.")
        except core.Conflict:
            raise DBusError(f"{NAME}.Error.Conflict", "The crontab changed outside Cronboard, so nothing was saved. Check the list and try again.")
        except core.Invalid as e:
            raise DBusError(f"{NAME}.Error.Invalid", str(e))
        except Exception as e:
            raise DBusError(f"{NAME}.Error.Failed", str(e))


async def _watch_runs(service):
    """Tells clients when a tracked job finishes (it renames its .status file into the state folder).

    ponytail: polls the folder's mtime; inotify through ctypes if the 2 s delay or wakeups ever matter.
    """
    def stamp():
        try:
            return core.state_dir().stat().st_mtime_ns
        except OSError:
            return None
    last = stamp()
    while True:
        await asyncio.sleep(STATUS_POLL_SECONDS)
        now = stamp()
        if now != last:
            last = now
            service.JobsChanged()


async def serve():
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    service = Cronboard()
    bus.export(PATH, service)
    if await bus.request_name(NAME) != RequestNameReply.PRIMARY_OWNER:
        sys.exit(f"{NAME} is already running")
    watcher = asyncio.create_task(_watch_runs(service))  # noqa: F841 (kept referenced so it isn't collected)
    try:
        await bus.wait_for_disconnect()
    except EOFError:
        pass  # the session bus went away (logout)


def install():
    """Registers the service with the session bus so it starts when the extension asks for it."""
    data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    target = data / "dbus-1" / "services" / f"{NAME}.service"
    target.parent.mkdir(parents=True, exist_ok=True)
    exe = Path(sys.argv[0]).resolve()
    target.write_text(f"[D-BUS Service]\nName={NAME}\nExec={exe}\n")
    print(f"Registered {target}")


def main():
    if sys.argv[1:] == ["install"]:
        install()
    elif len(sys.argv) == 1:
        asyncio.run(serve())
    else:
        sys.exit("usage: cronboard-service [install]")


if __name__ == "__main__":
    main()
