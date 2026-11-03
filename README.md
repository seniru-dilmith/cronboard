# Cronboard

A GNOME Shell extension (GNOME 46) for managing your own crontab from the top panel.

- **Panel menu:** every job with its schedule in words, its next run and, for tracked jobs, the last result. A switch turns a job on or off, and ▶ runs it now. The icon turns red when a tracked job's last run failed.
- **Preferences:** add, edit and delete jobs. Pick a preset (every minute, hour, day, week, month, at startup) or type a cron expression. It's checked as you type, with a plain-English description and the next five run times.

## How it treats your crontab

- It reads with `crontab -l` and writes with `crontab -`. Only the lines you edit change: comments, blank lines, variables and anything Cronboard doesn't understand stay exactly as they were.
- Disabled jobs are commented out with a marker: `#cronboard-disabled# 0 9 * * 1-5 /path/to/script.sh`.
- A job's name is the comment on the line directly above it.
- Before every write, Cronboard re-reads the crontab and refuses to save if it changed since it was loaded (for example by `crontab -e`). It also backs up the old version to `~/.local/share/cronboard/backups/`, keeping the last 20 with permissions 0600.
- **Run now** uses a cron-like environment: a minimal environment plus the crontab's own variables, through `$SHELL -c`, in a temporary systemd user unit. Its output goes to the journal: `journalctl --user -u 'cronboard-run-*'`.
- **Track runs** (optional, per job) wraps the command as `~/.local/share/cronboard/cronboard-run <id> '<command>'`. It records the exit status and the last 64 KB of output in `~/.local/state/cronboard/`. Cron still mails the output as before, with stdout and stderr combined. The wrapper lives outside the extension folder, so tracked jobs keep working if you uninstall Cronboard. Turn tracking off before deleting `~/.local/share/cronboard`.

Only the current user's crontab is supported. Root's crontab and `/etc/cron.d` are out of scope.

## Development

```sh
npm install
npm test             # parser and schedule tests (Node)
npm run build        # type-check, then bundle into dist/
npm run install-dev  # symlink dist/ into ~/.local/share/gnome-shell/extensions
npm run nested       # nested GNOME Shell with the extension enabled
npm run pack         # zip for extensions.gnome.org
```

## License

GPL-2.0-or-later
