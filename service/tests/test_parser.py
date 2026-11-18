import unittest

from cronboard_service.parser import (DISABLED_MARKER, JobFields, Track, add_job, delete_job, jobs, log_file, parse,
                                      serialize, set_enabled, split_log, split_percent, update_job, with_log)

DIR = "/home/me/.local/state/cronboard"


def tracked(id, command):
    return (f"mkdir -p '{DIR}'; ( {command} ) >'{DIR}/{id}.log' 2>&1; "
            f"echo \"$? $(date +\\%s)\" >'{DIR}/.{id}.status.tmp' && mv '{DIR}/.{id}.status.tmp' '{DIR}/{id}.status'")


FINE = "echo \"it's fine\""
SAMPLE_LINES = [
    "# m h  dom mon dow   command",                                              # 0
    "SHELL=/bin/bash",                                                           # 1
    'MAILTO = "me@example.com"',                                                 # 2
    "PATH=/usr/local/bin:/usr/bin:/bin",                                         # 3
    "",                                                                          # 4
    "# Backup photos",                                                           # 5
    "0 2 * * * /home/me/bin/backup.sh --photos",                                 # 6
    "*/15 9-17 * * mon-fri curl -s https://example.com/ping > /dev/null 2>&1",   # 7
    "#cronboard-disabled# 30 6 * * 1 /home/me/bin/weekly.sh",                    # 8
    "@reboot sleep 30 && /home/me/bin/start.sh",                                 # 9
    "@yearly echo yearly",                                                       # 10
    "@annually echo annually",                                                   # 11
    "@monthly echo monthly",                                                     # 12
    "@weekly echo weekly",                                                       # 13
    "@daily echo daily",                                                         # 14
    "@midnight echo midnight",                                                   # 15
    "@hourly echo hourly",                                                       # 16
    "FOO=late",                                                                  # 17
    "0 9 * * * root /usr/bin/system-style",                                      # 18
    "this is not a cron line",                                                   # 19
    "61 * * * * bad minute",                                                     # 20
    "   0 3 * * * indented",                                                     # 21
    "0 4 * * * date +\\%F % input",                                              # 22
    f"0 5 * * * {tracked('1a2b3c4d', FINE)}",                                    # 23
    "#cronboard-disabled# not a job",                                            # 24
]
SAMPLE = "\n".join(SAMPLE_LINES) + "\n"


def edited(change):
    lines = list(SAMPLE_LINES)
    change(lines)
    return "\n".join(lines) + "\n"


def fields(schedule, command, name=None, track=None):
    return JobFields(schedule, command, name, track)


class ParserTest(unittest.TestCase):
    def test_round_trip_is_byte_identical(self):
        for text in [SAMPLE, SAMPLE[:-1], "", "\n", "\n\n", "just text", SAMPLE.replace("\n", "\r\n")]:
            self.assertEqual(serialize(parse(text)), text)

    def test_classifies_lines(self):
        kinds = "".join(line.kind[0] for line in parse(SAMPLE))
        self.assertEqual(kinds, "oeeeooj" + "jjjjjjjjjj" + "ejoojjjoo")

    def test_crlf_job_lines_stay_unmanaged(self):
        self.assertEqual(parse("0 1 * * * x\r")[0].kind, "other")

    def test_jobs(self):
        found = jobs(parse(SAMPLE))
        self.assertEqual([j.index for j in found], [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 21, 22, 23])
        self.assertEqual([j.line.command for j in found], [
            "/home/me/bin/backup.sh --photos",
            "curl -s https://example.com/ping > /dev/null 2>&1",
            "/home/me/bin/weekly.sh",
            "sleep 30 && /home/me/bin/start.sh",
            "echo yearly", "echo annually", "echo monthly", "echo weekly", "echo daily", "echo midnight",
            "echo hourly",
            "root /usr/bin/system-style",
            "indented",
            "date +\\%F % input",
            FINE,
        ])
        self.assertEqual(found[0].name, "Backup photos")
        self.assertIsNone(found[1].name)
        self.assertEqual(found[1].line.schedule, "*/15 9-17 * * mon-fri")
        self.assertFalse(found[2].line.enabled)
        self.assertEqual(found[2].line.schedule, "30 6 * * 1")
        self.assertEqual(found[12].line.schedule, "0 3 * * *")
        self.assertEqual(found[14].line.track, Track(DIR, "1a2b3c4d"))

    def test_env_vars_apply_to_the_jobs_below_them(self):
        found = jobs(parse(SAMPLE))
        self.assertEqual(found[0].env, {"SHELL": "/bin/bash", "MAILTO": "me@example.com",
                                        "PATH": "/usr/local/bin:/usr/bin:/bin"})
        self.assertNotIn("FOO", found[0].env)
        self.assertEqual(found[11].env["FOO"], "late")

    def test_toggling_a_job_and_back_is_byte_exact(self):
        lines = parse(SAMPLE)
        for job in jobs(lines):
            back = set_enabled(set_enabled(lines, job.index, not job.line.enabled), job.index, job.line.enabled)
            self.assertEqual(serialize(back), SAMPLE, f"line {job.index}")

        def disable(l):
            l[6] = DISABLED_MARKER + l[6]

        def enable(l):
            l[8] = "30 6 * * 1 /home/me/bin/weekly.sh"
        self.assertEqual(serialize(set_enabled(lines, 6, False)), edited(disable))
        self.assertEqual(serialize(set_enabled(lines, 8, True)), edited(enable))

    def test_update_job_only_touches_the_target_lines(self):
        lines = parse(SAMPLE)
        backup = fields("0 2 * * *", "/home/me/bin/backup.sh --photos", "Backup photos")
        self.assertEqual(serialize(update_job(lines, 6, backup)), SAMPLE)

        def reschedule(l):
            l[6] = "0 3 * * * /home/me/bin/backup.sh --photos"
        self.assertEqual(serialize(update_job(lines, 6, backup._replace(schedule="0 3 * * *"))), edited(reschedule))

        def rename(l):
            l[5] = "# Photos"
        self.assertEqual(serialize(update_job(lines, 6, backup._replace(name="Photos"))), edited(rename))
        self.assertEqual(serialize(update_job(lines, 6, backup._replace(name=None))), edited(lambda l: l.pop(5)))
        ping = fields("*/15 9-17 * * mon-fri", "curl -s https://example.com/ping > /dev/null 2>&1", "Ping")
        self.assertEqual(serialize(update_job(lines, 7, ping)), edited(lambda l: l.insert(7, "# Ping")))
        self.assertEqual(serialize(update_job(lines, 21, fields("0 3 * * *", "indented"))), SAMPLE)

        def weekly(l):
            l[8] = f"{DISABLED_MARKER}0 7 * * 1 /home/me/bin/weekly.sh"
        self.assertEqual(serialize(update_job(lines, 8, fields("0 7 * * 1", "/home/me/bin/weekly.sh"))), edited(weekly))

    def test_update_job_handles_tracked_jobs(self):
        lines = parse(SAMPLE)
        f = fields("0 5 * * *", FINE)
        self.assertEqual(serialize(update_job(lines, 23, f._replace(track=Track(DIR, "1a2b3c4d")))), SAMPLE)

        def untrack(l):
            l[23] = f"0 5 * * * {FINE}"
        self.assertEqual(serialize(update_job(lines, 23, f)), edited(untrack))
        added = update_job(lines, 21, fields("0 3 * * *", "say 'hi'", track=Track(DIR, "ff")))
        self.assertEqual(added[21].raw, "0 3 * * * " + tracked("ff", "say 'hi'"))
        self.assertEqual(added[21].command, "say 'hi'")
        # A hand-edited wrapper is no longer ours to rewrite, so it stays a plain command.
        hand = parse(f"0 3 * * * {tracked('ff', 'x')} ; extra")
        self.assertIsNone(jobs(hand)[0].line.track)

    def test_add_job_appends_before_the_trailing_newline(self):
        job = fields("* * * * *", "echo hi")
        self.assertEqual(serialize(add_job(parse(""), job._replace(name="Hello"))), "# Hello\n* * * * * echo hi\n")
        self.assertEqual(serialize(add_job(parse(SAMPLE), job)), SAMPLE + "* * * * * echo hi\n")
        self.assertEqual(serialize(add_job(parse("a"), job)), "a\n* * * * * echo hi")
        self.assertEqual(jobs(add_job(parse(SAMPLE), job))[-1].env["FOO"], "late")

    def test_delete_job_removes_the_job_and_its_name_comment(self):
        lines = parse(SAMPLE)

        def drop_named(l):
            del l[5:7]
        self.assertEqual(serialize(delete_job(lines, 6)), edited(drop_named))
        self.assertEqual(serialize(delete_job(lines, 7)), edited(lambda l: l.pop(7)))
        with self.assertRaises(ValueError):
            delete_job(lines, 19)

    def test_split_percent_follows_cron_rules(self):
        self.assertEqual(split_percent("echo hi"), ("echo hi", None))
        self.assertEqual(split_percent("date +\\%F"), ("date +%F", None))
        self.assertEqual(split_percent("mail -s hi me%line1%line2"), ("mail -s hi me", "line1\nline2"))
        self.assertEqual(split_percent("a\\%b%c\\%d"), ("a%b", "c%d"))

    def test_log_file_finds_where_a_command_writes_its_output(self):
        cases = [
            ("/x/sync.sh >> /x/sync.log 2>&1", "/x/sync.log"),
            ("backup.sh > ~/logs/backup.log", "/home/me/logs/backup.log"),
            ('backup.sh >>"$HOME/my logs/b.log"', "/home/me/my logs/b.log"),
            ("run.sh >> out.log", "/home/me/out.log"),
            ("run.sh > /dev/null 2>&1", None),
            ("run.sh 2>&1", None),
            ("run.sh 2> err.log", None),
            ("run.sh >> $LOGDIR/x.log", None),
            ("echo hi", None),
        ]
        for command, expected in cases:
            self.assertEqual(log_file(command, "/home/me"), expected, command)

    def test_with_log_and_split_log_round_trip(self):
        for log in ["~/logs/a.log", "/var/tmp/b.log", "~/my logs/c.log", "/x/it's.log"]:
            command = with_log("/x/sync.sh --all", log)
            self.assertEqual(split_log(command), ("/x/sync.sh --all", log), command)
            self.assertIsNotNone(log_file(command, "/home/me"), command)
        self.assertEqual(with_log("/x/sync.sh", "~/my logs/c.log"), "/x/sync.sh >> ~/'my logs/c.log' 2>&1")
        self.assertEqual(with_log("echo hi", "  "), "echo hi")
        self.assertEqual(split_log("run.sh > out.log"), ("run.sh > out.log", None))
        self.assertEqual(split_log("run.sh 2>&1 >> out.log"), ("run.sh 2>&1 >> out.log", None))


if __name__ == "__main__":
    unittest.main()
