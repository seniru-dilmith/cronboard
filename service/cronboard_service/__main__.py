"""The Cronboard session D-Bus service."""

import asyncio
import os
import sys
from pathlib import Path

from dbus_fast import BusType, DBusError
from dbus_fast.aio import MessageBus
from dbus_fast.constants import RequestNameReply
from dbus_fast.service import ServiceInterface, method

from . import core

NAME = "io.github.seniru_dilmith.Cronboard"
PATH = "/io/github/seniru_dilmith/Cronboard"


class Cronboard(ServiceInterface):
    def __init__(self):
        super().__init__(NAME)

    @method()
    async def Read(self) -> "s":
        return await self._guard(core.read())

    @method()
    async def Write(self, text: "s", snapshot: "s"):
        await self._guard(core.write(text, snapshot))

    @method()
    async def Run(self, argv: "as", env: "a{ss}") -> "(is)":
        return list(await self._guard(core.run_job(argv, env)))

    @method()
    async def CronActive(self) -> "b":
        return await core.cron_active()

    @staticmethod
    async def _guard(awaitable):
        """Turns the core's errors into D-Bus errors the extension tells apart by name."""
        try:
            return await awaitable
        except core.NotInstalled:
            raise DBusError(f"{NAME}.Error.NotInstalled", "cron is not installed: the crontab command was not found.")
        except core.Conflict:
            raise DBusError(f"{NAME}.Error.Conflict", "The crontab changed outside Cronboard, so nothing was saved. Check the list and try again.")
        except Exception as e:
            raise DBusError(f"{NAME}.Error.Failed", str(e))


async def serve():
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    bus.export(PATH, Cronboard())
    if await bus.request_name(NAME) != RequestNameReply.PRIMARY_OWNER:
        sys.exit(f"{NAME} is already running")
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
