#!/usr/bin/env python3
"""Gate the built page: markets present, curves fresh enough, gaps named.

Run after build_dashboard.py. Exits non-zero when the page must not be
published, and prints GitHub Actions annotations on the way through (harmless
noise when run by hand).

    python3 check_build.py [rates.json]
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIRED = {"US", "UK", "DE", "JP"}

# Days since a market's latest observation.
#
# WARN_DAYS is the point at which a curve is worth a look; FAIL_DAYS is the
# point at which the page must not be published at all. Splitting the two is
# what stops a public holiday taking the whole dashboard down: a market that is
# merely shut says so on the run, a market that has actually stopped publishing
# still fails the build.
WARN_DAYS = 5

# Sized to each market's own holiday calendar, because a single global limit
# cannot be right when the four markets do not keep the same one.
#
# US/UK/DE: the longest run of closures is an Easter or Christmas/New Year
# weekend — four or five calendar days — and the publishers add a session's lag
# on top. Eight covers that and still catches a genuine outage inside a week.
#
# JP: Tokyo keeps a materially longer calendar. Golden Week shuts the market
# for up to eight consecutive days, MOF's file has run a session behind besides,
# and Silver Week closed it Sat 19 to Wed 23 September 2026 — which tripped the
# old flat five-day rule and took the page offline with three healthy markets on
# it. Twelve clears Golden Week with room to spare; anything tighter fails the
# build for most of a week, every spring.
FAIL_DAYS = {"US": 8, "UK": 8, "DE": 8, "JP": 12}
DEFAULT_FAIL_DAYS = 8


def main(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)

    problems = []
    markets = d.get("markets") or []

    missing = REQUIRED - {m["code"] for m in markets}
    if missing:
        problems.append(f"markets missing: {', '.join(sorted(missing))}")

    today = dt.date.today()
    for m in markets:
        code = m["code"]
        asof = m["asof"]
        lag = (today - dt.date.fromisoformat(asof)).days
        limit = FAIL_DAYS.get(code, DEFAULT_FAIL_DAYS)
        print(f"{code}: as at {asof} ({lag}d, fails at {limit}d)")
        if lag > limit:
            problems.append(
                f"{code} stale: as at {asof}, {lag} days old, {limit} allowed")
        elif lag > WARN_DAYS:
            print(f"::warning title=Stale curve::{code} is {lag} days old (as "
                  f"at {asof}); this run fails at {limit}. Usually a public "
                  f"holiday — check that market's calendar before assuming a "
                  f"fault.")

    # A hole in the middle of a series no longer distorts anything: the missing
    # weekdays are carried as blank rows, so a lookback landing in one returns
    # nothing instead of a move measured across it, and the page names the
    # dates. That makes an unfilled hole a thing to know about rather than a
    # thing to fail on.
    for m in markets:
        for g in (m.get("meta") or {}).get("history_gaps") or []:
            print(f"::warning title=Missing sessions::{m['code']} has a "
                  f"{g['days']}-day hole between {g['after']} and {g['until']}; "
                  f"horizons reaching into it are blank")

    for e in d.get("context_errors") or []:
        print(f"context series unavailable: {e['series']} — {e['detail']}")

    cm = d.get("commentary") or {}
    if cm.get("suppressed"):
        print("commentary: suppressed —", "; ".join(cm.get("reasons") or []))
    elif cm.get("withheld"):
        print("commentary: partial — withheld:",
              "; ".join(w["title"] for w in cm["withheld"]))
    else:
        print("commentary: published")

    for p in problems:
        print(f"::error title=Page not publishable::{p}")
    if problems:
        raise SystemExit("; ".join(problems))
    print("checks passed")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "rates.json"))
