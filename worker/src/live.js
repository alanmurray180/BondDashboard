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
  // The last completed session's own move, on the same scale, so the summary
  // can say whether today is continuing it, reversing it or breaking from it.
  const prevMove = n >= 2 ? mv(s.closes[n - 2], s.closes[n - 1]) : null;
  const prevZ = sigma && prevMove != null ? prevMove / sigma : null;
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
    move, sigma, z, stress, pct, prevMove, prevZ,
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
          const prevBoth = p.prevZ < 0 && q.prevZ < 0;
          const prevSt = p.prevZ == null || q.prevZ == null ? null : prevBoth ? Math.sqrt(p.prevZ * q.prevZ) : 0;
          r = { level: null, move: null, z: null, stress: st, prevStress: prevSt, unit: "",
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
    groups, errors, summary: summarise(groups),
  };
}

// --------------------------------------------------------------- summary ----

/**
 * What each indicator moving up or down means, in a line. Keyed by item id,
 * then by the sign of today's move. Written for a sterling-based holder of
 * mixed assets: plain consequences, not forecasts.
 */
const IMPLY = {
  MOVE: { up: "rates hedging is getting dearer and liquidity thinner; a poor moment to add or switch duration",
          dn: "rates volatility is easing, so conditions for dealing in bonds are calmer" },
  VIX: { up: "equity stress is rising; watch whether it spills into credit",
         dn: "equity risk appetite is improving" },
  UST3M: { up: "the front end is pricing a tighter Fed: fewer or later cuts",
           dn: "the front end is pricing more Fed easing" },
  UST5Y: { up: "medium-dated Treasuries are cheapening; policy expectations are being pushed higher",
           dn: "medium-dated Treasuries are richening; the market is leaning towards easier policy" },
  UST10Y: { up: "the benchmark discount rate is rising: duration loses value and equity valuations face a headwind",
            dn: "the benchmark discount rate is falling: duration gains, whether from growth worries or a flight to quality" },
  UST30Y: { up: "the long end is selling off: term premium or fiscal concern rather than policy",
            dn: "the long end is bid: demand for long duration, often defensive" },
  UST5S30S: { up: "the curve is steepening: long-end premium rising or easing being priced at the front",
              dn: "the curve is flattening: tightening priced at the front or a long-end bid" },
  IG: { up: "investment-grade spreads are tightening; corporate funding is easy",
        dn: "investment-grade spreads are widening; corporate funding costs are rising" },
  HY: { up: "high-yield spreads are tightening; risk appetite is firm",
        dn: "high-yield spreads are widening; the first place risk appetite fades" },
  EM: { up: "EM sovereign spreads are tightening; global risk appetite is supportive",
        dn: "EM sovereign spreads are widening; usually dollar strength or risk aversion" },
  BEI: { up: "inflation expectations are rising: linkers outperform nominals",
         dn: "inflation expectations are falling: nominals outperform linkers" },
  IGLT: { up: "gilts are rallying: UK yields lower",
          dn: "gilts are selling off: UK yields higher, sterling borrowing costs up" },
  GBPUSD: { up: "sterling is firmer: the GBP value of dollar assets falls",
            dn: "sterling is weaker: the GBP value of dollar assets rises" },
  SELLGB: { up: "gilts and sterling are falling together, the UK credibility pattern; watch fiscal news and gilt auctions",
            dn: "" },
  DXY: { up: "the dollar is strengthening, tightening global financial conditions",
         dn: "the dollar is weakening, easing global financial conditions" },
  USDJPY: { up: "the yen is weakening; watch JGB yields and the risk of intervention",
            dn: "the yen is strengthening, often a risk-off or carry-unwind signal" },
};

// A volatility index flagged for where it sits, not for how far it moved.
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const levelLed = (i) => i.pct != null && i.pct >= 75 && Math.abs(i.z ?? 0) < i.stress;
const ord = (n) => n + ((n % 100 > 10 && n % 100 < 14) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

function fmtMove(i, v = i.move) {
  if (v == null) return "";
  const sg = v > 0 ? "+" : v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (i.unit === "bp") return `${sg}${a.toFixed(1)}bp`;
  if (i.unit === "%") return `${sg}${a.toFixed(2)}%`;
  return `${sg}${a.toFixed(2)}`;
}

/**
 * How today compares with the last completed session, or null when the two
 * are not different enough to mention. Measured in each instrument's own
 * sigmas so a 3bp move in bills and a 3bp move in the 30y are not treated
 * alike.
 */
export function divergence(i) {
  const z = i.kind === "joint" ? i.stress : i.z;
  const pz = i.kind === "joint" ? i.prevStress : i.prevZ;
  if (z == null || pz == null) return null;
  const a = Math.abs(z), pa = Math.abs(pz);
  if (i.kind !== "joint" && a >= 0.75 && pa >= 0.75 && Math.sign(z) !== Math.sign(pz))
    return { tag: "Reversal", phrase: "reversing the last session's move" };
  if (pa < 0.5 && a >= 1.5)
    return { tag: "Breakout", phrase: "after a quiet last session" };
  if (a >= 1 && Math.sign(z) === Math.sign(pz) && a >= 2 * pa && pa >= 0.25)
    return { tag: "Accelerating", phrase: "extending the last session's move, faster" };
  if (pa >= 2 && a < 0.5)
    return { tag: "Calming", phrase: "quiet after a large move last session" };
  return null;
}

/**
 * A short, rule-written read of the panel: one headline, then the few things
 * worth a look — anything unusual, and anything moving differently from the
 * last session — each with its plain implication. Rule-written rather than
 * free text so every figure in it is the figure in the table.
 */
export function summarise(groups) {
  const items = groups.flatMap((g) => g.items).filter((i) => !i.error);
  if (!items.length) return null;
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  const scored = items.filter((i) => i.stress != null);
  const red = scored.filter((i) => i.status === "red");
  const amber = scored.filter((i) => i.status === "amber");

  // Tone, from the direction of the main legs rather than their size.
  const sgn = (i, t = 0.5) => (!i || i.z == null ? 0 : i.z >= t ? 1 : i.z <= -t ? -1 : 0);
  const ust = sgn(by.UST10Y) || sgn(by.UST30Y);
  const credit = sgn(by.HY) || sgn(by.IG);
  const vol = sgn(by.VIX) || sgn(by.MOVE);
  let tone;
  if (ust < 0 && credit < 0 && vol > 0) tone = "Risk-off: Treasuries are bid while credit weakens and volatility rises, a flight to quality.";
  else if (ust > 0 && credit < 0) tone = "A broad selloff: Treasuries and credit are both weaker, so bonds are not hedging risk today.";
  else if (ust > 0 && vol > 0) tone = "A rates-led selloff: yields are higher with volatility rising; credit is holding up so far.";
  else if (ust > 0) tone = "Yields are higher in an orderly way: volatility and credit are steady.";
  else if (ust < 0 && credit > 0) tone = "Risk-on with a bond rally: yields are lower and credit firmer, a benign mix.";
  else if (ust < 0) tone = "Treasuries are rallying without stress elsewhere.";
  else if (credit < 0) tone = "Rates are steady but credit is softening; worth watching.";
  else if (credit > 0 && vol < 0) tone = "Risk appetite is firm: credit is stronger and volatility lower, rates little changed.";
  else tone = "A quiet session so far: rates, credit and volatility are all within normal days.";

  let headline;
  if (!red.length && !amber.length) headline = "Nothing is moving more than a normal day. " + tone;
  else {
    const lead = [...red, ...amber].sort((a, b) => b.stress - a.stress)[0];
    const why = levelLed(lead) ? ` (level in the ${ord(lead.pct)} percentile of its year)`
      : lead.move != null ? ` (${fmtMove(lead)}, ${lead.stress.toFixed(1)}σ)` : ` (${lead.stress.toFixed(1)}σ)`;
    const counts = [red.length && `${red.length} unusual`, amber.length && `${amber.length} on watch`].filter(Boolean).join(", ");
    const leadName = lead.id.startsWith("UST") ? "the US " + lead.label : lead.label.replace(/^[A-Z][a-z]/, (m) => m.toLowerCase());
    headline = `${counts}, led by ${leadName}${why}. ${tone}`;
  }

  const points = [];
  const seen = new Set();
  const add = (i, tag, phrase) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    const z = i.kind === "joint" ? i.stress : i.z;
    const dir = i.kind === "joint" ? (i.stress > 0 ? "up" : "dn") : z >= 0 ? "up" : "dn";
    let imp = (IMPLY[i.id] || {})[dir] || "";
    if (tag === "Calming") imp = "the pressure from the last session has not carried into today";
    if (!imp && i.kind === "joint") return;
    const today = i.kind === "joint" ? `${i.flag}, ${i.stress.toFixed(1)}σ`
      : `${fmtMove(i)} today (${z >= 0 ? "+" : "−"}${Math.abs(z).toFixed(1)}σ), last session ${fmtMove(i, i.prevMove)}` +
        (levelLed(i) ? `; the level is in the ${ord(i.pct)} percentile of its year` : "");
    if (levelLed(i) && !phrase) imp = (IMPLY[i.id] || {}).up || imp;
    const name = i.id.startsWith("UST") ? "US " + i.label : i.label;
    points.push({ id: i.id, tag, status: i.status, label: name,
      text: `${name}: ${today}${phrase ? ", " + phrase : ""}.`,
      implication: imp ? cap(imp) + "." : "" });
  };
  // Anything moving differently from the last session first, biggest first.
  const divs = items.map((i) => ({ i, d: divergence(i) })).filter((x) => x.d)
    .sort((a, b) => Math.abs(b.i.z ?? b.i.stress) - Math.abs(a.i.z ?? a.i.stress));
  // Treasury tenors doing the same thing are one story, told once.
  const TEN = ["UST3M", "UST5Y", "UST10Y", "UST30Y"];
  const ustDivs = divs.filter((x) => TEN.includes(x.i.id));
  for (const tag of new Set(ustDivs.map((x) => x.d.tag))) {
    const same = ustDivs.filter((x) => x.d.tag === tag);
    const sign = Math.sign(same[0].i.z);
    if (same.length < 2 || !same.every((x) => Math.sign(x.i.z) === sign)) continue;
    const legs = same.map((x) => x.i).sort((a, b) => TEN.indexOf(a.id) - TEN.indexOf(b.id));
    const longest = legs[legs.length - 1];
    const worst = legs.reduce((m, i) => (i.stress > m.stress ? i : m));
    legs.forEach((i) => seen.add(i.id));
    points.push({ id: "UST", tag, status: worst.status, label: "US Treasuries",
      text: `US Treasuries ${legs.map((i) => i.label).join(", ")}: ` +
        `${legs.map((i) => fmtMove(i)).join(" / ")} today, last session ` +
        `${legs.map((i) => fmtMove(i, i.prevMove)).join(" / ")}, ${same[0].d.phrase}.`,
      implication: cap(tag === "Calming" ? "the pressure from the last session has not carried into today"
        : (IMPLY[longest.id] || {})[sign >= 0 ? "up" : "dn"]) + "." });
  }
  divs.forEach(({ i, d }) => add(i, d.tag, d.phrase));
  // Then anything unusual or on watch that is simply continuing.
  [...red, ...amber].sort((a, b) => b.stress - a.stress).forEach((i) => add(i, i.status === "red" ? "Unusual" : "Watch", ""));
  return { headline, points: points.slice(0, 6), more: Math.max(0, points.length - 6) };
}

/** Fetch every symbol in parallel and assemble. */
export async function buildLive(source, fetchImpl = fetch, extra = {}) {
  const syms = symbols();
  const got = await Promise.all(syms.map((s) =>
    fetchChart(s, fetchImpl, extra).then((r) => r, (e) => new Error(e.message || String(e)))));
  return assemble(Object.fromEntries(syms.map((s, i) => [s, got[i]])), source);
}
