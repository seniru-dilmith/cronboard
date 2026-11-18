import unittest
from datetime import datetime

from cronboard_service.schedule import check, describe, expr_to_preset, format_when, next_runs, validate


def at(s):
    return datetime.fromisoformat(s)


def iso(dates):
    return [d.isoformat()[:16] for d in dates]

# 2026-11-01 is a Sunday.


class ScheduleTest(unittest.TestCase):
    def test_validate_accepts_valid_expressions(self):
        for expr in ["* * * * *", "*/15 * * * *", "0 9 * * 1-5", "0 0 1 jan *", "30 4 * * SUN",
                     "0 0 * * 7", "0 9-17/2 * * mon-fri", "5,35 * 1,15 * *", "@daily", "@reboot", "@annually"]:
            self.assertIsNone(validate(expr), expr)

    def test_validate_rejects_invalid_expressions(self):
        for expr in ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *",
                     "* * * 13 *", "* * * * 8", "5/10 * * * *", "*/0 * * * *", "5-1 * * * *", "* * * foo *",
                     "@sometimes", "1,,2 * * * *"]:
            self.assertIsNotNone(validate(expr), expr)

    def test_next_runs_basics(self):
        self.assertEqual(iso(next_runs("0 9 * * 1-5", at("2026-11-01T12:00"), 3)),
                         ["2026-11-02T09:00", "2026-11-03T09:00", "2026-11-04T09:00"])
        self.assertEqual(iso(next_runs("* * * * *", at("2026-11-01T12:00:30"), 2)),
                         ["2026-11-01T12:01", "2026-11-01T12:02"])
        self.assertEqual(iso(next_runs("0 8 * * 7", at("2026-11-01T12:00"), 1)), ["2026-11-08T08:00"])
        self.assertEqual(iso(next_runs("0 0 1 1 *", at("2026-11-01T12:00"), 1)), ["2027-01-01T00:00"])
        self.assertEqual(next_runs("@reboot", at("2026-11-01T12:00"), 3), [])

    def test_both_day_fields_restricted_means_either_matches(self):
        self.assertEqual(iso(next_runs("0 0 3 * 5", at("2026-11-01T00:00"), 3)),
                         ["2026-11-03T00:00", "2026-11-06T00:00", "2026-11-13T00:00"])

    def test_a_day_field_starting_with_star_means_both_must_match(self):
        self.assertEqual(iso(next_runs("0 0 */2 * 5", at("2026-11-01T00:00"), 3)),
                         ["2026-11-13T00:00", "2026-11-27T00:00", "2026-12-11T00:00"])

    def test_rare_and_impossible_dates(self):
        self.assertEqual(iso(next_runs("0 0 29 2 *", at("2026-11-01T00:00"), 1)), ["2028-02-29T00:00"])
        self.assertEqual(next_runs("0 0 30 2 *", at("2026-11-01T00:00"), 1), [])

    def test_describe(self):
        cases = [
            ("* * * * *", "every minute"),
            ("*/15 * * * *", "every 15 minutes"),
            ("0 * * * *", "every hour"),
            ("30 * * * *", "every hour at :30"),
            ("0 */2 * * *", "every 2 hours"),
            ("0 9 * * *", "every day at 09:00"),
            ("0 9 * * 1-5", "every weekday at 09:00"),
            ("30 18 * * mon,wed,fri", "every Monday, Wednesday and Friday at 18:30"),
            ("0 0 * * 0", "every Sunday at 00:00"),
            ("0 0 1 * *", "on the 1st of every month at 00:00"),
            ("@yearly", "on the 1st of January at 00:00"),
            ("0 9,17 * * *", "every day at 09:00 and 17:00"),
            ("*/10 * * * 1-5", "every 10 minutes on weekdays"),
            ("0 9 * 6 *", "every day at 09:00 in June"),
            ("0 9 13 * 5", "on the 13th of every month and every Friday at 09:00"),
            ("@reboot", "at startup"),
            ("not valid", "not valid"),
        ]
        for expr, text in cases:
            self.assertEqual(describe(expr), text, expr)

    def test_format_when(self):
        now = at("2026-11-01T12:00")
        self.assertEqual(format_when(at("2026-11-01T18:05"), now), "today 18:05")
        self.assertEqual(format_when(at("2026-11-02T09:00"), now), "tomorrow 09:00")
        self.assertEqual(format_when(at("2026-10-31T09:00"), now), "yesterday 09:00")
        self.assertEqual(format_when(at("2026-11-05T09:00"), now), "Thu 09:00")
        self.assertEqual(format_when(at("2026-12-24T09:00"), now), "24 Dec 09:00")
        self.assertEqual(format_when(at("2027-01-01T00:00"), now), "1 Jan 2027 00:00")

    def test_presets(self):
        for expr, preset in [("* * * * *", "minute"), ("15 * * * *", "hourly"), ("15 7 * * *", "daily"),
                             ("15 7 * * 3", "weekly"), ("15 7 20 * *", "monthly"), ("@reboot", "reboot"),
                             ("@daily", "daily"), ("0 9 * * 1-5", "custom"), ("0 0 1 1 *", "custom")]:
            self.assertEqual(expr_to_preset(expr)[0], preset, expr)
        self.assertEqual(expr_to_preset("15 7 * * 3"), ("weekly", {"minute": 15, "hour": 7, "weekday": 3, "day": 1}))

    def test_check(self):
        now = at("2026-11-01T12:00")
        self.assertEqual(check("0 9 * * *", now)["next"],
                         "Next: tomorrow 09:00, Tue 09:00, Wed 09:00, Thu 09:00, Fri 09:00")
        self.assertEqual(check("@reboot", now)["next"], "Runs when the computer starts")
        self.assertEqual(check("0 0 30 2 *", now)["next"], "Never runs: no date matches")
        self.assertTrue(check("61 * * * *", now)["error"])


if __name__ == "__main__":
    unittest.main()
