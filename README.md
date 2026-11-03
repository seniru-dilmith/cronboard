<img src="icons/cronboard.svg" width="96" alt="">

# Cronboard

A GNOME Shell extension for managing your crontab from the top bar. It works on GNOME 46.

The panel menu lists your cron jobs with their schedule written out ("every weekday at 09:00") and when each one runs next. Each job has a switch to turn it off and on again. In the preferences you can add, edit and delete jobs, run a job immediately, and open its log, which keeps updating while the job is running.

## Features

- Schedules shown in plain words, with the next run time
- Turn jobs off and on without deleting them
- An editor with presets (hourly, daily, weekly, monthly, at startup) or your own cron expression, checked as you type, showing the next five runs
- Run a job now, after a confirmation, in the same minimal environment cron uses
- A live log view for jobs that write to a log file, such as `script.sh >> ~/logs/sync.log 2>&1`
- Optional run tracking: the panel icon turns red when a tracked job's last run failed

## How it handles your crontab

Cronboard reads your crontab with `crontab -l` and saves it with `crontab -`. Lines it doesn't edit are left exactly as they were, including comments, blank lines and variables such as `MAILTO=`.

Before saving, it checks the crontab hasn't been changed by something else since it was loaded, for example `crontab -e`. If it has, it doesn't save. The previous version is backed up to `~/.local/share/cronboard/backups/`, and the last 20 backups are kept.

A disabled job is commented out with a marker, so enabling it again restores the original line:

```
#cronboard-disabled# 0 9 * * 1-5 /path/to/script.sh
```

A comment on the line directly above a job is used as its name.

Run tracking is off by default and can be turned on per job. It runs the command through a small script that saves the exit code and recent output to `~/.local/state/cronboard/`. Cron still mails the output as usual. The script is stored in `~/.local/share/cronboard/`, outside the extension, so tracked jobs keep working if Cronboard is removed. Turn tracking off before deleting that folder.

Only your own crontab is supported, not the root crontab or `/etc/cron.d`.

## Installing from source

```sh
git clone https://github.com/seniru-dilmith/cronboard.git
cd cronboard
npm install
npm run build
npm run install-dev
gnome-extensions enable cronboard@seniru-dilmith.github.io
```

On Wayland, log out and back in once so GNOME Shell loads it.

## Development

`npm test` runs the parser and schedule tests. `npm run nested` starts a nested GNOME Shell with the extension enabled, and `npm run pack` builds the zip for extensions.gnome.org.

## License

GPL-2.0-or-later
