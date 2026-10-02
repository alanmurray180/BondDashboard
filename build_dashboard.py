#!/usr/bin/env python3
"""Inject rates.json + a self-extracting copy of the toolkit into template.html.

Output: bond_yield_monitor.html — a single self-contained file that carries both
the dashboard and the source needed to rebuild it in a fresh environment.

  python3 build_dashboard.py            build the dashboard
  python3 build_dashboard.py --extract <file.html> <dir>
                                        recover the toolkit from a built page
"""
import base64
import json
import os
import sys
import tarfile
import io

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLKIT = ["fetch_rates.py", "write_commentary.py", "template.html",
           "build_dashboard.py", "check_build.py", "policy_rates.json",
           "commentary.json", "REFRESH.md",
           "worker/src/live.js", "worker/snapshot.mjs"]


def pack():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name in TOOLKIT:
            p = os.path.join(HERE, name)
            if os.path.exists(p):
                tf.add(p, arcname=name)
    return base64.b64encode(buf.getvalue()).decode()


def extract(html_path, dest):
    html = open(html_path, encoding="utf-8").read()
    start = html.index('<script id="toolkit" type="text/plain">') + len(
        '<script id="toolkit" type="text/plain">')
    end = html.index("</script>", start)
    blob = html[start:end].strip()
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(blob)), mode="r:gz") as tf:
        tf.extractall(dest)
    print("extracted:", sorted(os.listdir(dest)))


def build():
    data = json.load(open(os.path.join(HERE, "rates.json"), encoding="utf-8"))
    # The in-day panel: a snapshot from worker/snapshot.mjs, and the Worker's
    # address for the page to poll. Either may be absent; the page copes.
    lp = os.path.join(HERE, "live.json")
    if os.path.exists(lp):
        try:
            data["live"] = json.load(open(lp, encoding="utf-8"))
        except ValueError as e:
            print(f"live.json unreadable, panel will rely on the Worker: {e}")
    live_url = os.environ.get("LIVE_URL", "").strip()
    if live_url:
        data["live_url"] = live_url
    data = json.dumps(data, separators=(",", ":"))
    tpl = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
    blob = pack()
    assert "/*__DATA__*/" in tpl and "/*__TOOLKIT__*/" in tpl, "placeholder missing"
    out = (tpl.replace("/*__TOOLKIT__*/", blob)
              .replace("/*__DATA__*/", data.replace("</", "<\\/")))
    path = os.path.join(HERE, "bond_yield_monitor.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"wrote {path}  {os.path.getsize(path)/1e6:.2f} MB "
          f"(toolkit {len(blob)/1024:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--extract":
        extract(sys.argv[2], sys.argv[3])
    else:
        build()
