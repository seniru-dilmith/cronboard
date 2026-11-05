# Cronboard service

The companion service for the [Cronboard](https://github.com/seniru-dilmith/cronboard) GNOME Shell extension. It runs in your user session and does the work the extension is not allowed to do itself: reading and writing your crontab (with a backup of the previous one), running a job on demand, and checking that the cron service is running. The extension talks to it over the session D-Bus.

```bash
pipx install cronboard-service
cronboard-service install
```

`install` registers the service with the session bus so it starts on demand. Without it you can run `cronboard-service` in a terminal instead.
