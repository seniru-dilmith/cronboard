# Security

## Supported versions

Only the latest release of the extension and of `cronboard-service` gets security fixes. Please update both before reporting.

## Reporting a vulnerability

Please don't report security problems in public issues. Use GitHub's private reporting instead: open the [Security tab](https://github.com/seniru-dilmith/cronboard/security) of this repository and choose **Report a vulnerability**. Only the maintainer can see the report.

Include what you found, how to reproduce it, and which versions of the extension, `cronboard-service` and GNOME Shell you used. You should get a first reply within a week. Once a fix is released, the report can be made public, with credit if you want it.

## What counts

Cronboard manages your own crontab, so the things worth reporting are ones that let something else act as you. For example:

- another user or process on the machine reading or changing your crontab through `cronboard-service` or its D-Bus interface
- a crafted crontab line, job name or log file that makes the extension or service run something you didn't ask for
- the service or extension writing files somewhere it shouldn't, or with permissions that are too open

Problems in GNOME Shell, cron or systemd themselves should go to those projects.
