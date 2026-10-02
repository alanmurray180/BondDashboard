/**
 * In-day market health: delayed quotes turned into a relative stress reading.
 *
 * Every curve on the page comes from an official publisher once a day, after
 * the close. None of them has an intraday feed, so this reads delayed market
 * quotes instead — Yahoo's chart endpoint, keyless, ~15 minutes behind — and
 * scores each move against that instrument's own recent behaviour.
 *
 * The same module runs in two places, so the arithmetic exists once:
 *   - the Worker's GET /live, which the page polls while it is open
 *   - worker/snapshot.mjs under Node in the build, whose output is baked into
 *     the page as a fallback for when the Worker is unreachable or blocked
 *
 * Scoring. Each indicator's move today is divided by the standard deviation of
 * its daily moves over the last LOOKBACK sessions, giving z: "how many normal
 * days is this". Each indicator says which direction is stress — MOVE up, the
 * credit ratios down, or a large move either way for yields and FX — and that
 * direction turns z into a stress score. Under 1 is a normal day, 1 to 2 is
 * worth a look, 2 or more is unusual. A group takes its worst member.
 *
 * This is relative health, not valuation: a z of 2 says today is unusual for
 * this instrument, not that anything is mispriced.
 */

export const LOOKBACK = 60;          // sessions of daily moves behind each sigma
export const AMBER = 1;
export const RED = 2;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * kind:   'yield'  quoted in percent, moves in bp
 *         'price'  moves in %, total return (dividend-adjusted)
 *         'level'  an index level (MOVE, VIX), moves in points
 *         'ratio'  price of a over price of b, moves in %
 *         'spread' yield of a less yield of b, moves in bp
 * stress: 'up' | 'down' | 'abs' — which direction counts against health
 */
export const GROUPS = [
  {
    key: "vol", title: "Rates volatility",
    note: "Implied volatility. A rising MOVE is the bond market paying up for protection.",
    items: [
      { id: "MOVE", label: "MOVE index", sym: "^MOVE", kind: "level", stress: "up", pct: true,
        what: "ICE BofA implied volatility of 1m Treasury options" },
      { id: "VIX", label: "VIX", sym: "^VIX", kind: "level", stress: "up", pct: true,
        what: "S&P 500 implied volatility, for comparison" },
    ],
  },
  {
    key: "ust", title: "US Treasuries, live",
    note: "Cboe yield indices. The 3m is the 13-week bill rate. A large move either way counts.",
    items: [
      { id: "UST3M", label: "3m bill", sym: "^IRX", kind: "yield", stress: "abs" },
      { id: "UST5Y", label: "5y", sym: "^FVX", kind: "yield", stress: "abs" },
      { id: "UST10Y", label: "10y", sym: "^TNX", kind: "yield", stress: "abs" },
      { id: "UST30Y", label: "30y", sym: "^TYX", kind: "yield", stress: "abs" },
      { id: "UST5S30S", label: "5s30s curve", a: "^TYX", b: "^FVX", kind: "spread", stress: "abs",
        what: "30y less 5y" },
    ],
  },
  {
    key: "credit", title: "Credit risk appetite",
    note: "Credit ETF over a Treasury ETF of similar duration, so the rates move cancels and the spread move is left. Falling is stress.",
    items: [
      { id: "IG", label: "Investment grade", a: "LQD", b: "IEF", kind: "ratio", stress: "down",
        what: "LQD / IEF" },
      { id: "HY", label: "High yield", a: "HYG", b: "IEI", kind: "ratio", stress: "down",
        what: "HYG / IEI" },
      { id: "EM", label: "EM sovereign", a: "EMB", b: "IEF", kind: "ratio", stress: "down",
        what: "EMB / IEF" },
    ],
  },
  {
    key: "infl", title: "US inflation expectations",
    note: "TIPS over nominal Treasuries of similar duration: rising means breakevens widening.",
    items: [
      { id: "BEI", label: "Breakeven proxy", a: "TIP", b: "IEF", kind: "ratio", stress: "abs",
        what: "TIP / IEF" },
    ],
  },
  {
    key: "uk", title: "Gilts and sterling",
    note: "Gilts falling with sterling falling is the credibility pattern (Sept 2022); gilts falling with sterling rising is a hawkish or growth story.",
    items: [
      { id: "IGLT", label: "Gilt ETF", sym: "IGLT.L", kind: "price", stress: "abs",
        what: "iShares Core UK Gilts, total return" },
      { id: "GBPUSD", label: "GBP/USD", sym: "GBPUSD=X", kind: "price", stress: "abs" },
      { id: "SELLGB", label: "Gilts and sterling both down", kind: "joint", of: ["IGLT", "GBPUSD"],
        what: "geometric mean of the two falls, in sigmas; zero unless both fell" },
    ],
  },
  {
    key: "fx", title: "Dollar and yen",
    note: "A large move either way counts. Yen weakness alongside rising JGB yields is the Japanese stress pattern.",
    items: [
      { id: "DXY", label: "Dollar index", sym: "DX-Y.NYB", kind: "price", stress: "abs" },
      { id: "USDJPY", label: "USD/JPY", sym: "JPY=X", kind: "price", stress: "abs" },
    ],
  },
];

export function symbols() {
  const s = new Set();
  for (const g of GROUPS) for (const it of g.items) {
    if (it.sym) s.add(it.sym);
    if (it.a) s.add(it.a);
    if (it.b) s.add(it.b);
  }
  return [...s];
}

function chartUrl(host, sym) {
  return `https://${host}.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(sym)}?range=1y&interval=1d&events=div`;
}

/**
 * One symbol's chart, trying both Yahoo hosts. Throws with the status and the
 * opening bytes, so a block page is diagnosable rather than "bad JSON".
 */
export async function fetchChart(sym, fetchImpl = fetch, extra = {}) {
  const tried = [];
  for (const host of ["query1", "query2"]) {
    try {
      const resp = await fetchImpl(chartUrl(host, sym), {
        headers: { "User-Agent": UA, Accept: "application/json" }, ...extra,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`${resp.status} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      const res = JSON.parse(text)?.chart?.result?.[0];
      if (!res) throw new Error("no result");
      return res;
    } catch (e) {
      tried.push(`${host}: ${e.message || e}`);
    }
  }
  throw new Error(tried.join("; "));
}

/**
 * A chart result reduced to what the scoring needs: the live price, its time,
 * and completed daily bars before today's session, in exchange-local dates.
 *
 * The previous close is the dividend-adjusted one. On an ETF's ex-dividend day
 * the price drops by the dividend; against the raw close HYG would book that as
 * a credit selloff every month. Adjusted, the move is total return.
 */
export function parseChart(res) {
  const meta = res.meta || {};
  const off = Number(meta.gmtoffset) || 0;
  const dayOf = (ts) => new Date((ts + off) * 1000).toISOString().slice(0, 10);
  const price = Number(meta.regularMarketPrice);
  const time = Number(meta.regularMarketTime);
  if (!Number.isFinite(price) || !Number.isFinite(time)) throw new Error("no live price");
  const today = dayOf(time);
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || [];
  const bars = new Map();
  ts.forEach((t, i) => {
    const c = q.close?.[i];
    if (c == null || !Number.isFinite(c)) return;
    const d = dayOf(t);
    if (d >= today) return;
    const a = adj[i];
    bars.set(d, Number.isFinite(a) ? a : c);
  });
  const dates = [...bars.keys()].sort();
  return {
    price, time, today, currency: meta.currency || "",
    dates, closes: dates.map((d) => bars.get(d)),
  };
}

// ------------------------------------------------------------ arithmetic ----

function sd(xs) {
  if (xs.length < 10) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return v > 0 ? Math.sqrt(v) : null;
}

// Cboe yield indices are in percent; very old feeds scaled them by ten.
const yld = (v) => (v > 25 ? v / 10 : v);

function moveFn(kind) {
  if (kind === "yield" || kind === "spread") return (a, b) => (yld(b) - yld(a)) * 100;
  if (kind === "level") return (a, b) => b - a;
  return (a, b) => (b / a - 1) * 100;
}

function series(kind, x, y) {
  if (!y) return x;
  // Pair on dates both traded; a ratio across different sessions is not one.
  const yb = new Map(y.dates.map((d, i) => [d, y.closes[i]]));
  const dates = x.dates.filter((d) => yb.has(d));
  const xb = new Map(x.dates.map((d, i) => [d, x.closes[i]]));
  const f = kind === "spread" ? (a, b) => yld(a) - yld(b) : (a, b) => a / b;
  return {
    price: f(x.price, y.price),
    time: Math.min(x.time, y.time),
    today: x.today < y.today ? x.today : y.today,
    sameSession: x.today === y.today,
    currency: "",
    dates, closes: dates.map((d) => f(xb.get(d), yb.get(d))),
  };
}

function score(it, s) {
  const mv = moveFn(it.kind);
  const n = s.closes.length;
  if (!n) throw new Error("no history");
  const prev = s.closes[n - 1];
  const move = mv(prev, s.price);
  const daily = [];
  for (let i = Math.max(1, n - LOOKBACK); i < n; i++) daily.push(mv(s.closes[i - 1], s.closes[i]));
  const sigma = sd(daily);
  const z = sigma ? move / sigma : null;
  let stress = null;
  if (z != null) stress = it.stress === "up" ? z : it.stress === "down" ? -z : Math.abs(z);
  let pct = null;
  if (it.pct) {
    const yr = s.closes.slice(-252);
    pct = Math.round((100 * yr.filter((v) => v <= s.price).length) / yr.length);
    // A level in the top decile of its year is stress even on a quiet day.
    if (pct >= 90) stress = Math.max(stress ?? 0, RED);
    else if (pct >= 75) stress = Math.max(stress ?? 0, AMBER);
  }
  const level = it.kind === "yield" ? yld(s.price) : it.kind === "spread" ? s.price * 100 : s.price;
  return {
    level, prev: it.kind === "yield" ? yld(prev) : it.kind === "spread" ? prev * 100 : prev,
    move, sigma, z, stress, pct,
    unit: it.kind === "yield" || it.kind === "spread" ? "bp" : it.kind === "level" ? "pt" : "%",
    asof: new Date(s.time * 1000).toISOString(),
    session: s.today, prevSession: s.dates[n - 1],
    sameSession: s.sameSession !== false,
    currency: s.currency,
  };
}

export function status(stress) {
  if (stress == null) return "na";
  return stress >= RED ? "red" : stress >= AMBER ? "amber" : "green";
}

/**
 * Pure: charts in, payload out. `charts` maps symbol to a raw chart result or
 * an Error. Nothing here touches the network, so the build and the Worker
 * produce the same numbers from the same quotes.
 */
export function assemble(charts, source, now = new Date()) {
  const parsed = {}, errors = [];
  for (const [sym, res] of Object.entries(charts)) {
    if (res instanceof Error) { errors.push({ symbol: sym, detail: res.message }); continue; }
    try { parsed[sym] = parseChart(res); }
    catch (e) { errors.push({ symbol: sym, detail: e.message }); }
  }
  const groups = GROUPS.map((g) => {
    const byId = {};
    const items = g.items.map((it) => {
      const base = { id: it.id, kind: it.kind, label: it.label, what: it.what || it.sym || "", stressDir: it.stress || "down" };
      try {
        let r;
        if (it.kind === "joint") {
          const [p, q] = it.of.map((k) => byId[k]);
          if (p?.z == null || q?.z == null) throw new Error("needs both legs");
          const both = p.z < 0 && q.z < 0;
          const st = both ? Math.sqrt(p.z * q.z) : 0;
          r = { level: null, move: null, z: null, stress: st, unit: "",
            asof: p.asof < q.asof ? p.asof : q.asof, sameSession: true,
            flag: both ? "both fell" : p.z < 0 ? "gilts down, sterling not" : q.z < 0 ? "sterling down, gilts not" : "neither fell" };
        } else {
          const x = parsed[it.sym || it.a], y = it.b ? parsed[it.b] : null;
          if (!x || (it.b && !y)) throw new Error(`quote missing: ${[it.sym || it.a, it.b].filter(Boolean).join(", ")}`);
          r = score(it, series(it.kind, x, y));
        }
        const out = { ...base, ...r, status: status(r.stress) };
        byId[it.id] = out;
        return out;
      } catch (e) {
        const out = { ...base, error: e.message, status: "na" };
        byId[it.id] = out;
        return out;
      }
    });
    const scored = items.filter((i) => i.stress != null);
    const worst = scored.reduce((m, i) => Math.max(m, i.stress), -Infinity);
    return { key: g.key, title: g.title, note: g.note, items,
      stress: scored.length ? worst : null, status: scored.length ? status(worst) : "na" };
  });
  return {
    generated: now.toISOString(), source,
    lookback: LOOKBACK, thresholds: { amber: AMBER, red: RED },
    groups, errors,
  };
}

/** Fetch every symbol in parallel and assemble. */
export async function buildLive(source, fetchImpl = fetch, extra = {}) {
  const syms = symbols();
  const got = await Promise.all(syms.map((s) =>
    fetchChart(s, fetchImpl, extra).then((r) => r, (e) => new Error(e.message || String(e)))));
  return assemble(Object.fromEntries(syms.map((s, i) => [s, got[i]])), source);
}
