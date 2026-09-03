#!/usr/bin/env python3
"""Write commentary.json from rates.json, then gate it against the data.

Two jobs, deliberately separate:

  write   - compose the morning read from the curve itself. Every figure in the
            prose is computed here, so an unattended run never serves yesterday's
            numbers. Regime language (steepening/flattening, real vs breakeven,
            gold) is picked from the actual signs and sizes of the moves.

  check   - reconcile whatever is in commentary.json against rates.json,
            whether this script wrote it or a human did. Any figure in the prose
            that cannot be found in today's data, or directional language the
            data contradicts, withholds the section that carries it; a missing
            or out-of-window `asof` withholds the whole box.

Nothing is withheld silently: the page shows what was dropped and why, the run
logs the reasons, and under GitHub Actions the outcome is annotated and exposed
as a step output so a wordless page cannot ship under a green tick.

  python3 write_commentary.py            # write, then check
  python3 write_commentary.py --check    # check only (leaves the file alone)
  python3 write_commentary.py --no-write # same as --check
"""
import datetime as dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RATES = os.path.join(HERE, "rates.json")
COMMENTARY = os.path.join(HERE, "commentary.json")

# A figure in the prose must match a value the data can produce. Tolerance is
# set by how precisely the figure was quoted — "10.3%" is allowed half of its
# last decimal place, "4.19%" much less — plus a small floor for rounding drift.
TOL_PCT = 0.011      # floor for percentage-point figures, e.g. "4.19%"
TOL_BP = 0.6         # floor for basis-point figures, e.g. "12bp"


def _tol(raw, floor):
    """Half a unit in the last quoted decimal place, or the floor if larger."""
    frac = raw.split(".")[1] if "." in raw else ""
    return max(floor, 0.5 * 10 ** (-len(frac)) + 1e-9)
MAX_STALE_DAYS = 0   # commentary.asof must equal the latest common data date


def log(msg):
    print(f"[commentary] {msg}", file=sys.stderr)


# --------------------------------------------------------------- data access


class Curve:
    """Thin accessor over rates.json with the lookbacks the page uses."""

    HORIZONS = {"1d": 1, "5d": 5, "1m": 30, "3m": 91, "6m": 182, "1y": 365}

    def __init__(self, payload):
        self.p = payload
        self.m = {m["code"]: m for m in payload["markets"]}
        self.ctx = payload.get("context", {})

    # -- levels -------------------------------------------------------------
    def level(self, code, tenor, day=None):
        m = self.m.get(code)
        if not m or tenor not in m["series"]:
            return None
        i = self._index(m["dates"], day)
        return None if i is None else m["series"][tenor][i]

    def ctx_level(self, key, tenor, day=None):
        c = self.ctx.get(key)
        if not c or tenor not in c["series"]:
            return None
        i = self._index(c["dates"], day)
        return None if i is None else c["series"][tenor][i]

    def _index(self, dates, day):
        if day is None:
            for i in range(len(dates) - 1, -1, -1):
                return i
            return None
        # nearest observation on or before `day`
        lo = None
        for i, d in enumerate(dates):
            if d <= day:
                lo = i
            else:
                break
        return lo

    def _back(self, dates, days):
        if not dates:
            return None
        target = (dt.date.fromisoformat(dates[-1])
                  - dt.timedelta(days=days)).isoformat()
        return self._index(dates, target)

    # -- changes ------------------------------------------------------------
    def change_bp(self, code, tenor, horizon):
        m = self.m.get(code)
        if not m or tenor not in m["series"]:
            return None
        ser = m["series"][tenor]
        j = self._back(m["dates"], self.HORIZONS[horizon])
        if j is None or ser[-1] is None or ser[j] is None:
            return None
        return (ser[-1] - ser[j]) * 100

    def spread(self, code, short, long_, day=None):
        a = self.level(code, short, day)
        b = self.level(code, long_, day)
        return None if a is None or b is None else b - a

    def spread_change_bp(self, code, short, long_, horizon):
        a = self.change_bp(code, short, horizon)
        b = self.change_bp(code, long_, horizon)
        return None if a is None or b is None else b - a

    def ctx_change(self, key, tenor, horizon):
        c = self.ctx.get(key)
        if not c or tenor not in c["series"]:
            return None
        ser = c["series"][tenor]
        j = self._back(c["dates"], self.HORIZONS[horizon])
        if j is None or ser[-1] is None or ser[j] is None:
            return None
        return ser[-1] - ser[j]

    def common_latest(self, code_a, code_b):
        """Latest date both markets actually traded and published.

        Cross-market figures must be quoted here, not at each market's own last
        observation: the BoE publishes a session behind the US Treasury, so
        pairing the two latest values silently books a session of US move
        against a gilt that never saw it.
        """
        a, b = self.m.get(code_a), self.m.get(code_b)
        if not a or not b:
            return None
        both = set(a["dates"]) & set(b["dates"])
        return max(both) if both else None

    def data_window(self):
        """(common, latest) — the date every market has data through, and the
        freshest date any market has. They differ whenever one publisher lags:
        the BoE GLC file routinely lands a session behind the others, so a read
        dated to either end of that window is legitimately current.
        """
        days = [m["asof"] for m in self.p["markets"] if m.get("asof")]
        return (min(days), max(days)) if days else (None, None)


# --------------------------------------------------------------- the writing


def _bp(x, digits=0):
    return f"{abs(x):.{digits}f}bp"


def _dirword(x, up, down, flat="little changed", thresh=1.0):
    if x is None:
        return flat
    if abs(x) < thresh:
        return flat
    return up if x > 0 else down


def _curve_shape(front_bp, back_bp):
    """Classify the day's move from the front-end and long-end changes."""
    if front_bp is None or back_bp is None:
        return "mixed", "a mixed move"
    steep = back_bp - front_bp
    both_up = front_bp > 0 and back_bp > 0
    both_dn = front_bp < 0 and back_bp < 0
    if abs(steep) < 1.5:
        if both_up:
            return "parallel_up", "a near-parallel selloff"
        if both_dn:
            return "parallel_down", "a near-parallel rally"
        return "parallel", "a flat session"
    if steep > 0:
        return ("bear_steepen", "a bear steepening") if back_bp > 0 else \
               ("bull_steepen", "a bull steepening")
    return ("bear_flatten", "a bear flattening") if front_bp > 0 else \
           ("bull_flatten", "a bull flattening")


def write_us(cv):
    front, back = "2Y", "30Y"
    lvl_b = cv.level("US", back)
    lvl_f = cv.level("US", front)
    d1_b = cv.change_bp("US", back, "1d")
    d1_f = cv.change_bp("US", front, "1d")
    m1_sp = cv.spread_change_bp("US", front, back, "1m")
    d5_sp = cv.spread_change_bp("US", front, back, "5d")
    if lvl_b is None or lvl_f is None:
        return None
    shape, phrase = _curve_shape(d1_f, d1_b)

    paras = []
    p1 = f"The session was {phrase}."
    if d1_b is not None and d1_f is not None:
        p1 += (f" The 30y {_dirword(d1_b, 'rose', 'fell')} {_bp(d1_b, 1)} "
               f"and the 2y {_dirword(d1_f, 'rose', 'fell')} {_bp(d1_f, 1)}.")
    if d5_sp is not None and m1_sp is not None:
        p1 += (f" That puts 2s30s {_bp(d5_sp, 1)} "
               f"{'steeper' if d5_sp > 0 else 'flatter'} over five sessions and "
               f"{_bp(m1_sp, 1)} {'steeper' if m1_sp > 0 else 'flatter'} over "
               f"the month.")
    paras.append(p1)

    # nominal vs real vs breakeven decomposition at the long end
    real_30 = cv.ctx_level("usreal", "30Y")
    real_1m = cv.ctx_change("usreal", "30Y", "1m")
    nom_1m = cv.change_bp("US", "30Y", "1m")
    be_10 = cv.ctx_level("breakeven", "10Y")
    be_1m = cv.ctx_change("breakeven", "10Y", "1m")
    if None not in (real_30, real_1m, nom_1m, be_10, be_1m):
        real_1m_bp = real_1m * 100
        be_1m_bp = be_1m * 100
        driver = ("real yields" if abs(real_1m_bp) > abs(be_1m_bp) * 1.5
                  else "inflation compensation" if abs(be_1m_bp) > abs(real_1m_bp) * 1.5
                  else "both legs together")
        paras.append(
            f"Decomposing the month: the 30y nominal {_dirword(nom_1m, 'rose', 'fell')} "
            f"{_bp(nom_1m, 1)}, the 30y real yield {_dirword(real_1m_bp, 'rose', 'fell')} "
            f"{_bp(real_1m_bp, 1)} to {real_30:.2f}%, and 10y breakevens "
            f"{_dirword(be_1m_bp, 'widened', 'narrowed')} {_bp(be_1m_bp, 1)} to "
            f"{be_10:.2f}%. The move is being driven by {driver}."
        )

    pol = (cv.m.get("US", {}).get("policy") or {})
    p3 = (f"For positioning: the 2y at {lvl_f:.2f}% and the 30y at {lvl_b:.2f}% "
          f"frame the trade-off.")
    if pol.get("display"):
        p3 += f" Policy is at {pol['display']}."
    if shape in ("bear_steepen", "parallel_up"):
        p3 += (" Duration is being repriced rather than the policy path, which "
               "argues for expressing a view through the curve rather than "
               "outright.")
    elif shape in ("bull_flatten", "parallel_down"):
        p3 += (" The rally is running through the long end, so carry on the "
               "front end is the less crowded side of the same view.")
    paras.append(p3)

    return {
        "key": "US", "title": "US Treasuries",
        "metrics": [
            {"label": "30y", "ref": "m.US.30Y", "h": ["1d", "1m"]},
            {"label": "2y", "ref": "m.US.2Y", "h": ["1d", "5d"]},
            {"label": "2s30s", "ref": "s.US.2Y.30Y", "h": ["1d", "1m"]},
        ],
        "body": paras,
    }


def write_uk(cv):
    front, back = "5Y", "30Y"
    lvl_f = cv.level("UK", front)
    lvl_b = cv.level("UK", back)
    if lvl_f is None or lvl_b is None:
        return None
    d1_f = cv.change_bp("UK", front, "1d")
    d1_b = cv.change_bp("UK", back, "1d")
    m3_sp = cv.spread_change_bp("UK", front, back, "3m")
    shape, phrase = _curve_shape(d1_f, d1_b)
    pol = (cv.m.get("UK", {}).get("policy") or {})

    paras = []
    p1 = f"Gilts saw {phrase}."
    if d1_f is not None and d1_b is not None:
        p1 += (f" The 5y {_dirword(d1_f, 'rose', 'fell')} {_bp(d1_f, 1)} to "
               f"{lvl_f:.2f}% and the 30y {_dirword(d1_b, 'rose', 'fell')} "
               f"{_bp(d1_b, 1)} to {lvl_b:.2f}%.")
    paras.append(p1)

    if m3_sp is not None:
        # A fraction of a basis point is not a direction. Calling it one put a
        # true-but-trivial "steeper" next to three flattening horizons.
        if abs(m3_sp) < DIR_MIN_BP:
            paras.append(
                f"Over three months 5s30s has gone nowhere, within "
                f"{_bp(m3_sp, 1)} of where it started, so the shape of the "
                f"curve is not the quarter's story."
            )
        else:
            paras.append(
                f"Over three months 5s30s is {_bp(m3_sp, 1)} "
                f"{'steeper' if m3_sp > 0 else 'flatter'}, so the quarter's story is "
                f"{'the long end lagging the front' if m3_sp > 0 else 'the long end leading'}."
            )

    p3 = ""
    if pol.get("rate", pol.get("value")) is not None:
        gap = (lvl_f - float(pol.get("rate", pol.get("value")))) * 100
        p3 = (f"The 5y sits {_bp(gap, 0)} "
              f"{'above' if gap > 0 else 'below'} Bank Rate")
        if pol.get("display"):
            p3 += f" at {pol['display']}"
        p3 += (", so the strip is pricing "
               + ("no easing to speak of" if gap > 0 else "cuts ahead")
               + ".")
    common = cv.common_latest("UK", "US")
    uk_30_c = cv.level("UK", "30Y", common) if common else None
    us_30_c = cv.level("US", "30Y", common) if common else None
    if uk_30_c is not None and us_30_c is not None:
        diff = (uk_30_c - us_30_c) * 100
        p3 += (f" The 30y sits {_bp(diff, 0)} "
               f"{'above' if diff > 0 else 'below'} the US long bond")
        us_asof = (cv.m.get("US") or {}).get("asof")
        # Name the date whenever it is not simply "today" for both of them.
        p3 += f" as at {common}." if common != us_asof else "."
    if p3:
        paras.append(p3.strip())

    return {
        "key": "UK", "title": "UK gilts",
        "metrics": [
            {"label": "30y", "ref": "m.UK.30Y", "h": ["1d", "1m"]},
            {"label": "5y", "ref": "m.UK.5Y", "h": ["1d", "1m"]},
            {"label": "5s30s", "ref": "s.UK.5Y.30Y", "h": ["1d", "3m"]},
        ],
        "body": paras,
    }


def write_gold(cv):
    g = cv.ctx.get("gold")
    if not g:
        return None
    tenor = "USD" if "USD" in g["series"] else list(g["series"])[0]
    lvl = cv.ctx_level("gold", tenor)
    if lvl is None:
        return None
    d1 = cv.ctx_change("gold", tenor, "1d")
    m1 = cv.ctx_change("gold", tenor, "1m")
    real_1m = cv.ctx_change("usreal", "30Y", "1m")

    paras = []
    p1 = f"The PM auction fixed at ${lvl:,.2f}."
    if m1 is not None and lvl:
        pct = m1 / (lvl - m1) * 100 if (lvl - m1) else 0
        p1 += (f" That is {abs(pct):.1f}% "
               f"{'higher' if m1 > 0 else 'lower'} over the month.")
    paras.append(p1)

    if real_1m is not None and m1 is not None:
        together = (real_1m > 0 and m1 > 0) or (real_1m < 0 and m1 < 0)
        paras.append(
            "Gold is moving with real yields rather than against them, which is "
            "the unusual configuration: both are expressing a view about "
            "government paper rather than hedging one another."
            if together else
            "Gold is moving inversely to real yields, the textbook relationship, "
            "so it is behaving as a discount-rate asset rather than a fiscal hedge."
        )
    return {
        "key": "gold", "colour": "--m-JP", "title": "Gold",
        "metrics": [{"label": "PM fix", "ref": "c.gold.USD", "h": ["1d", "1m"]}],
        "body": paras,
    }


def compose(payload):
    cv = Curve(payload)
    _, asof = cv.data_window()
    sections = [s for s in (write_us(cv), write_uk(cv), write_gold(cv)) if s]
    if not sections:
        return {}

    us_1d_30 = cv.change_bp("US", "30Y", "1d")
    uk_1d_30 = cv.change_bp("UK", "30Y", "1d")
    if us_1d_30 is not None and uk_1d_30 is not None:
        same = (us_1d_30 > 0) == (uk_1d_30 > 0)
        headline = (
            f"Long ends moved together: the US 30y "
            f"{_dirword(us_1d_30, 'rose', 'fell')} {_bp(us_1d_30, 1)} and the "
            f"gilt 30y {_dirword(uk_1d_30, 'rose', 'fell')} {_bp(uk_1d_30, 1)}, "
            f"pointing at a common duration bid rather than anything domestic."
            if same else
            f"The two long ends parted company: the US 30y "
            f"{_dirword(us_1d_30, 'rose', 'fell')} {_bp(us_1d_30, 1)} while the "
            f"gilt 30y {_dirword(uk_1d_30, 'rose', 'fell')} {_bp(uk_1d_30, 1)}, "
            f"so the driver is local rather than global."
        )
    else:
        headline = "Curve read for the last session."

    uk = cv.m.get("UK", {})
    foot = ("Written automatically from the published curves; every figure is "
            "computed from the same data the grids use.")
    if (uk.get("meta") or {}).get("basis_override"):
        foot += (f" UK curve is on a {uk['meta']['basis_override']} basis, so "
                 f"long-end gilt levels sit a few bp off a par redemption yield "
                 f"and are not strictly like-for-like with the US par curve.")
    return {
        "asof": asof,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "author": "auto",
        "kicker": "Read of the last session",
        "headline": headline,
        "sections": sections,
        "footnote": foot,
    }


# ------------------------------------------------------------- the gatekeeper

NUM_PCT = re.compile(r"(-?\d+(?:\.\d+)?)\s*%")
NUM_BP = re.compile(r"(-?\d+(?:\.\d+)?)\s*bp\b", re.I)
NUM_USD = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")

# Horizons the prose may quote a direction over. A directional word is only
# wrong if the data contradicts it at *every* one of them: a single US paragraph
# describes 2s30s over the session, five days and a month, and those three
# routinely point different ways.
DIR_HORIZONS = ("1d", "5d", "1m", "3m")
DIR_MIN_BP = 1.5     # below this a move is noise, not a direction

# Past tense too: prose written by hand says "the curve steepened", and a rule
# that only knows "steeper" and "steepening" waves it through unchecked.
STEEPER = re.compile(r"\bsteep(er|ens|ened|ening)\b", re.I)
FLATTER = re.compile(r"\bflatt(er|ens|ened|ening)\b", re.I)
SOLDOFF = re.compile(r"\b(sold off|selloff|sell-off|rose|higher in yield)\b", re.I)
RALLIED = re.compile(r"\b(rallied|rally|fell|lower in yield)\b", re.I)


def key_pair(m):
    """The tenor pair the section is written about.

    Markets declare it as `key` (US 2s30s, UK 5s30s); the first and last tenors
    are a poor stand-in, since `tenors[0]` is the 3M bill for the US and moves
    with the policy floor rather than with the curve the prose describes.
    """
    pair = m.get("key") or []
    if len(pair) == 2 and all(t in m["tenors"] for t in pair):
        return pair[0], pair[1]
    return m["tenors"][0], m["tenors"][-1]


def _pair_label(short, long_):
    if short.endswith("Y") and long_.endswith("Y"):
        return f"{short[:-1]}s{long_[:-1]}s"
    return f"{short}/{long_}"


def _known(values):
    return [v for v in values if v is not None]


def _moves(values):
    return [v for v in values if abs(v) >= DIR_MIN_BP]


def directional_reasons(cv, code, text, title):
    """Directional language checked against the pair and horizons it describes.

    Two separate questions, and conflating them is what withheld the gilt read
    on 2 September. `_moves` answers "is there a move here worth judging at
    all", so that a curve which has not gone anywhere cannot contradict
    anything. The contradiction itself is then judged on every horizon that has
    a number, noise included — because the prose is entitled to describe a small
    move, and the horizon it describes must not be the one the noise filter
    threw away. Saying "0.8bp steeper" while the other horizons flattened is an
    accurate sentence, and the old rule read it as a lie.
    """
    m = cv.m.get(code)
    if not m or len(m["tenors"]) < 2:
        return []
    short, long_ = key_pair(m)
    pair = _pair_label(short, long_)
    reasons = []

    sps = _known([cv.spread_change_bp(code, short, long_, h) for h in DIR_HORIZONS])
    if _moves(sps):
        if STEEPER.search(text) and not any(x > 0 for x in sps):
            reasons.append(f"{title}: says steeper, {pair} flattened over every horizon")
        if FLATTER.search(text) and not any(x < 0 for x in sps):
            reasons.append(f"{title}: says flatter, {pair} steepened over every horizon")

    ds = _known([cv.change_bp(code, long_, h) for h in DIR_HORIZONS])
    if _moves(ds):
        if SOLDOFF.search(text) and not any(x > 0 for x in ds) and not RALLIED.search(text):
            reasons.append(f"{title}: says selloff, the {long_} fell over every horizon")
        if RALLIED.search(text) and not any(x < 0 for x in ds) and not SOLDOFF.search(text):
            reasons.append(f"{title}: says rally, the {long_} rose over every horizon")
    return reasons


def candidate_values(cv, code):
    """Every percentage-point and bp figure today's data can legitimately produce."""
    pcts, bps = set(), set()
    codes = [code] if code in cv.m else list(cv.m)
    for c in codes:
        m = cv.m[c]
        for t in m["tenors"]:
            v = cv.level(c, t)
            if v is not None:
                pcts.add(v)
            for h in Curve.HORIZONS:
                d = cv.change_bp(c, t, h)
                if d is not None:
                    bps.add(d)
        for a, b in m.get("spreads", []):
            sp = cv.spread(c, a, b)
            if sp is not None:
                pcts.add(sp)
                bps.add(sp * 100)
            for h in Curve.HORIZONS:
                d = cv.spread_change_bp(c, a, b, h)
                if d is not None:
                    bps.add(d)
        pol = m.get("policy") or {}
        rate = pol.get("rate", pol.get("value"))
        if rate is not None:
            pcts.add(float(rate))
            for t in m["tenors"]:
                v = cv.level(c, t)
                if v is not None:
                    bps.add((v - float(rate)) * 100)
        # figures quoted from the policy tile itself, e.g. "3.50-3.75%" or CPI
        for raw in re.findall(r"-?\d+(?:\.\d+)?", str(pol.get("display", ""))):
            pcts.add(float(raw))
        if pol.get("cpi") is not None:
            pcts.add(float(pol["cpi"]))
        # Cross-market differentials at matching tenors. The auto-written prose
        # quotes these on the latest common date; a human might reasonably quote
        # either that or each market's own latest, so both are allowed rather
        # than risking a false suppression.
        for other in cv.m.values():
            if other["code"] == c:
                continue
            common = cv.common_latest(c, other["code"])
            days = [None] + ([common] if common else [])
            for t in set(m["tenors"]) & set(other["tenors"]):
                for day in days:
                    a = cv.level(c, t, day)
                    b = cv.level(other["code"], t, day)
                    if a is not None and b is not None:
                        bps.add((a - b) * 100)
    for key, ctx in cv.ctx.items():
        for t in ctx["tenors"]:
            v = cv.ctx_level(key, t)
            if v is not None and ctx.get("unit") != "usd":
                pcts.add(v)
            for h in Curve.HORIZONS:
                d = cv.ctx_change(key, t, h)
                if d is None:
                    continue
                base = cv.ctx_level(key, t)
                if ctx.get("unit") == "usd" or (base or 0) > 50:
                    # a price series: the quotable figure is the % move
                    prev = (base - d) if base is not None else None
                    if prev:
                        pcts.add(d / prev * 100)
                else:
                    bps.add(d * 100)
                    pcts.add(d)
    return pcts, bps


def review(payload, cm):
    """Reconcile commentary against the data.

    Returns (global_reasons, section_reasons). A global reason withholds the
    whole box — there is no commentary, or it is dated outside the data window.
    section_reasons is keyed by section index, so a figure the US section cannot
    justify no longer takes the gilt and gold reads down with it.
    """
    if not cm or not cm.get("headline"):
        return ["no commentary written"], {}

    cv = Curve(payload)
    common, latest = cv.data_window()
    globals_ = []
    asof = cm.get("asof")
    if not asof:
        globals_.append("commentary has no asof date")
    elif common and latest:
        if asof > latest:
            globals_.append(f"commentary dated {asof}, ahead of the data ({latest})")
        else:
            stale = (dt.date.fromisoformat(common)
                     - dt.date.fromisoformat(asof)).days
            if stale > MAX_STALE_DAYS:
                globals_.append(f"commentary dated {asof}, all markets current "
                                f"through {common}")

    per_section = {}
    for idx, sec in enumerate(cm.get("sections", [])):
        code = sec.get("key", "")
        title = sec.get("title", code)
        pcts, bps = candidate_values(cv, code)
        body = sec.get("body", [])
        text = " ".join(body if isinstance(body, list) else [str(body)])
        text = re.sub(r"<[^>]+>", "", text)

        reasons = []
        for raw in NUM_PCT.findall(text):
            val, tol = float(raw), _tol(raw, TOL_PCT)
            if not any(abs(val - c) <= tol for c in pcts):
                reasons.append(f"{title}: '{raw}%' not in today's data")
        for raw in NUM_BP.findall(text):
            val, tol = abs(float(raw)), _tol(raw, TOL_BP)
            if not any(abs(val - abs(c)) <= tol for c in bps):
                reasons.append(f"{title}: '{raw}bp' not in today's data")
        reasons += directional_reasons(cv, code, text, title)
        if reasons:
            per_section[idx] = reasons

    return globals_, per_section


def flatten(globals_, per_section):
    return list(globals_) + [r for i in sorted(per_section) for r in per_section[i]]


def check(payload, cm):
    """(ok, [reasons]) across the whole document — what `--check` reports."""
    globals_, per_section = review(payload, cm)
    reasons = flatten(globals_, per_section)
    return (not reasons), reasons


# --------------------------------------------------------------------- entry


def report_to_ci(status, reasons):
    """Put the outcome where an unattended run will be seen.

    An annotation on the run, a line in the job summary, and a step output the
    workflow turns into a failed job. Without this a suppressed read ships a
    wordless page under a green tick.
    """
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    if status != "published":
        title = ("Commentary withheld" if status == "suppressed"
                 else "Commentary partially withheld")
        print(f"::warning title={title}::{' · '.join(reasons) or 'no detail'}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Commentary: {status}\n\n")
            f.writelines(f"- {r}\n" for r in reasons)
            f.write("\n")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"status={status}\n")


def main():
    do_write = not any(a in sys.argv for a in ("--check", "--no-write"))
    payload = json.load(open(RATES, encoding="utf-8"))

    if do_write:
        cm = compose(payload)
        if cm:
            with open(COMMENTARY, "w", encoding="utf-8") as f:
                json.dump(cm, f, indent=1, ensure_ascii=False)
            log(f"wrote commentary.json for {cm.get('asof')}")
        else:
            log("nothing to write — insufficient data")
    cm = json.load(open(COMMENTARY, encoding="utf-8")) if os.path.exists(COMMENTARY) else {}

    globals_, per_section = review(payload, cm)
    reasons = flatten(globals_, per_section)
    sections = cm.get("sections", [])
    kept = [sec for i, sec in enumerate(sections) if i not in per_section]
    withheld = [{"title": sections[i].get("title", sections[i].get("key", "")),
                 "reasons": per_section[i]} for i in sorted(per_section)]

    if globals_ or (sections and not kept):
        status = "suppressed"
        for r in reasons:
            log(f"SUPPRESSED: {r}")
        cm = {"suppressed": True, "reasons": reasons,
              "asof": cm.get("asof"), "author": cm.get("author")}
    elif withheld:
        status = "partial"
        for r in reasons:
            log(f"WITHHELD: {r}")
        log(f"publishing {len(kept)} of {len(sections)} sections")
        cm["sections"] = kept
        cm["withheld"] = withheld
        cm["status"] = "partial"
    else:
        status = "published"
        cm["status"] = "ok"
        log("reconciled against the data — publishing")

    report_to_ci(status, reasons)
    payload["commentary"] = cm
    with open(RATES, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    log("rates.json updated")
    # The data still publishes: a read that cannot be reconciled is a reason to
    # withhold prose, not to withhold the curves. STRICT is for local runs.
    return 1 if status != "published" and os.environ.get("COMMENTARY_STRICT") else 0


if __name__ == "__main__":
    sys.exit(main())
