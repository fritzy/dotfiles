#!/usr/bin/env python3
"""Logical work days: day_start_hour → day_start_hour local time (default 4 AM), except
Monday, which starts at monday_start_sunday_hour on Sunday (default 6 PM) so Sunday-night
prep counts toward the week it's for. Sunday is therefore 4 AM–6 PM.

  days.py today CONFIG              logical today
  days.py default-start CONFIG      Monday of last week, relative to logical today
  days.py bounds START END CONFIG   local timestamps where START begins and END ends
"""
import json, sys
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


class Days:
    def __init__(self, cfg):
        self.tz = ZoneInfo(cfg.get("tz", "America/Los_Angeles"))
        self.day_start = cfg.get("day_start_hour", 4)
        self.monday_start = cfg.get("monday_start_sunday_hour", 18)  # null disables

    def _at(self, d, hour):
        return datetime.combine(d, time(hour), self.tz)

    def of(self, dt):
        local = dt.astimezone(self.tz)
        d = (local - timedelta(hours=self.day_start)).date()
        if self.monday_start is not None and d.weekday() == 6 and local >= self._at(d, self.monday_start):
            d += timedelta(days=1)
        return d

    def of_ts(self, ts):
        return self.of(datetime.fromisoformat(ts.replace("Z", "+00:00")))

    def today(self):
        return self.of(datetime.now(self.tz))

    def begins(self, d):
        if self.monday_start is not None and d.weekday() == 0:
            return self._at(d - timedelta(days=1), self.monday_start)
        return self._at(d, self.day_start)

    def ends(self, d):
        return self.begins(d + timedelta(days=1))

    def describe(self):
        h = lambda x: f"{(x % 12) or 12} {'AM' if x < 12 else 'PM'}"
        text = f"days start at {h(self.day_start)}"
        if self.monday_start is not None:
            text += f"; Monday starts {h(self.monday_start)} Sunday"
        return text


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    days = Days(json.load(open(rest[-1])))
    if cmd == "today":
        print(days.today())
    elif cmd == "default-start":
        t = days.today()
        print(t - timedelta(days=t.weekday() + 7))
    elif cmd == "bounds":
        s, e = date.fromisoformat(rest[0]), date.fromisoformat(rest[1])
        print(days.begins(s).isoformat(), days.ends(e).isoformat())
    else:
        sys.exit(__doc__)
