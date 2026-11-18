# Cronboard service

The companion service for the [Cronboard](https://github.com/seniru-dilmith/cronboard) GNOME Shell extension. It runs in your user session and does all of Cronboard's work: it reads your crontab, lists the jobs with readable schedules, next runs and last results, saves your changes (with a backup of the previous crontab), runs a job on demand and checks that the cron service is running. The extension is only a front end that talks to it over the session D-Bus.

```bash
pipx install cronboard-service
cronboard-service install
```

`install` registers the service with the session bus so it starts on demand. Without it you can run `cronboard-service` in a terminal instead.
