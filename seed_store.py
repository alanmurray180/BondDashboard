#!/usr/bin/env python3
"""One-off: seed uk_glc_store.json from a dashboard page built earlier.

August 2026 fell out of both BoE files at the month rollover, and the store did
not exist yet when it happened, so there was nothing to restore from. A page
built before the rollover still carries the whole series in its embedded
payload, which is enough to put the missing sessions back.

Only ever adds dates the store lacks, so running it twice is harmless and it
can never overwrite something the BoE has since restated.

    python3 seed_store.py <built-page.html> [more.html ...]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "uk_glc_store.json")


def uk_rows(html_path):
    html = open(html_path, encoding="utf-8", errors="replace").read()
    m = re.search(r'<script id="payload"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise SystemExit(f"{html_path}: no payload block")
    # build_dashboard escapes "</" as "<\/" so the JSON cannot close the tag
    payload = json.loads(m.group(1).replace("<\\/", "</"))
    uk = next((x for x in payload.get("markets", []) if x.get("code") == "UK"), None)
    if not uk:
        raise SystemExit(f"{html_path}: no UK market in the payload")
    rows = {}
    for i, d in enumerate(uk["dates"]):
        row = {t: uk["series"][t][i] for t in uk["tenors"]
               if uk["series"][t][i] is not None}
        if row:
            rows[d] = row
    return rows


def main(paths):
    store = {}
    if os.path.exists(STORE):
        store = json.load(open(STORE, encoding="utf-8"))
    before = len(store)
    added = []
    for p in paths:
        rows = uk_rows(p)
        print(f"{p}: {len(rows)} UK session(s), {min(rows)} to {max(rows)}")
        for d, row in rows.items():
            if d not in store:
                store[d] = row
                added.append(d)
    with open(STORE, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(store.items())), f, separators=(",", ":"))
    print(f"store: {before} -> {len(store)} session(s)" +
          (f", added {len(added)} ({min(added)} to {max(added)})"
           if added else ", nothing new"))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
