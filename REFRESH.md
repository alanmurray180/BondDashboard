# Bond yield monitor — refresh procedure

This toolkit rebuilds `bond_yield_monitor.html` from scratch. Every source is a
free official publisher; no API keys, no logins.

## Files

| File | Role |
|---|---|
| `fetch_rates.py` | pulls all curves, writes `rates.json` |
| `template.html` | the dashboard shell (HTML/CSS/JS, no data) |
| `build_dashboard.py` | injects `rates.json` + a copy of this toolkit into the template |
| `write_commentary.py` | writes `commentary.json` from the data, then reconciles it |
| `policy_rates.json` | central bank rates shown on the tiles — **update by hand each month** |
| `commentary.json` | the written read at the top of the page — written automatically, or by hand |
| `manual_quotes.json` | optional same-day UK 2y/30y screen quotes (reference only) |

## Run

```bash
python3 fetch_rates.py         # ~25s: US, UK, DE, JP. Exits non-zero if a market drops out.
python3 write_commentary.py    # writes the read, then gates it against the data
python3 build_dashboard.py     # writes bond_yield_monitor.html
```

## Cloud deployment

`.github/workflows/build.yml` runs the three steps twice each weekday and
publishes to GitHub Pages. Two things matter for anything running off a
datacentre IP:

**The BoE IADB endpoint is blocked.** `_iadb-fromshowcolumns.asp` returns HTTP 200
with an "Access denied" page and a WAF reference id from cloud ranges, so the par
yields behind `IUDSNPY/IUDMNPY/IUDLNPY` are unavailable. `UK_BASIS=spot` (the
default) skips it and takes the whole UK curve from the GLC files instead — plain
file downloads, which are not blocked. Set `UK_BASIS=par` to use the IADB splice
when running from a machine that can reach it; if the call fails it falls back to
spot rather than dropping the market.

**Failures must be loud.** `fetch_rates.py` exits non-zero if any market is
missing, and the workflow asserts all four markets are present and no curve is
more than five days stale. Without that a scheduled run reports success while
serving a page with a market silently absent.

Loud does not mean brittle, though. Every fetch retries twice through a
transient upstream failure — 1.5s then 3s — because publishers have moments: on
1 Sep 2026 the Bundesbank answered 400 to all six tenor requests inside six
seconds and was serving normally an hour later, and a single-shot fetch turned
that into a failed build. A 404 is not a moment and is not retried. A real
outage still exhausts the attempts and fails, costing about 4.5s per dead URL.

A *context* series — real yields, breakevens, gold — is not fatal in the same
way; the curves are the point of the page. But it must not vanish quietly
either, so `build_context()` returns its failures alongside the data, they are
written to `rates.json` as `context_errors`, annotated on the run, and named on
the page under the context grid. Gold disappeared for three days in August 2026
under a green tick because the old code logged the exception and moved on.

When a publisher starts answering 200 with an interstitial instead of JSON,
`json.loads` reports only "Expecting value: line 1 column 1". `get_json()`
carries the status, content type, length and opening bytes into the error
instead, which is the difference between a diagnosable failure and a guess.

## Cross-market figures are quoted on a common date

Publishers do not keep the same clock. The US Treasury posts the day's par
curve after its own close; the BoE posts the *previous* session's curve around
midday London. So on a morning build the US carries a session the gilt curve
has not seen, and the two markets' holiday calendars diverge besides — 31 Aug
2026 was a UK bank holiday and a normal US session.

Pairing each market's latest observation therefore books a session of US move
against a gilt that never traded it. A spread between two markets only exists
on a day both of them traded, so `crossSeries()` emits a differential only
where both have an observation on the same date, and `Curve.common_latest()`
gives the written commentary the same footing. The date can sit behind the
fresher market; that is the honest answer, and the page says so.

## The UK month-end hole

The UK curve is assembled from two BoE downloads and they do not hand over
cleanly. The archive is regenerated periodically and lags; the current-month
file rolls on the 1st, a day or two late. On 2 Sep 2026 the current-month file
became September while the archive still ended 31 July, so August existed in
neither and the gilt series lost twenty-one sessions in a single run.

Refreshing the archive more often does not fix this — that lag is the BoE's,
not ours, which is what the weekly cache key got wrong when it was introduced.
Three things address it instead:

- every `Nominal daily` sheet in the latest zip is parsed, not only the one
  named `current`, so a previous-month file is picked up if the BoE ships one
- `_store_merge()` unions each parse with the sessions earlier runs already
  saw, cached between runs. Fresh data always wins, so a revision is never
  resurrected; the store only supplies dates today's fetch does not carry
- `contiguous_tail()` drops history sitting behind a hole rather than serving a
  lookback measured across it. A "1m" move computed over a five-week void is
  not a 1m move, and a shorter series that is true beats a longer one that is
  not — and beats publishing nothing while a publisher sorts itself out. The
  page names the market and the date its history starts

The gap assertion below stays as the backstop: it now fires only if a hole
survived truncation, which would mean a bug rather than a publisher.

## The UK archive cache

The UK curve is assembled from two BoE downloads: the ~39MB historical archive
and a "current month" file. Only the current-month file is fetched every run;
the archive is cached, because it is large and changes rarely.

On the 1st the current-month file rolls over, and the tail of the month it just
left lives only in the archive. So a stale archive does not look broken — it
silently drops the end of the previous month, and every lookback that spans the
hole quietly shortens.

The old cache key was the run id with a `glc-archive-` restore prefix, which
restored the first copy ever fetched, forever. `_glc_zip()` only re-downloads
when the file is 7+ days old by mtime, and the cache round-trip refreshes that
mtime, so the expiry never fired. The key is now the ISO week with no
restore-keys, making the first run of each week a deliberate miss.

The workflow also asserts that no market has an interior gap of more than ten
days across its last 90 observations. Holidays make gaps of a few days —
Christmas and Easter run to about five — so a larger one means data has gone
missing rather than the market having been shut. This fails the build: a page
with a hole in it reports moves over the wrong window, which is worse than a
page that does not update, and the freshness banner now makes the latter
visible anyway.

## Why the schedule is redundant

GitHub's `schedule` trigger is best-effort: firings are delayed under load and
dropped outright when the delay runs long. Through late August 2026 the delay on
this repo grew from ~30 minutes to 8+ hours, whole firings went missing, one
landed on a Saturday that the `1-5` cron excludes, and the page sat three days
stale while every run that *did* fire went green.

So the workflow declares six weekday windows rather than two. They are not extra
coverage — the data only moves twice a day — they are redundancy, so a dropped
firing is picked up two hours later instead of half a day later. A build takes
~40s and the deploy is idempotent, so the cost of the extra runs is nil.

Redundancy narrows the window; it cannot close it. The page therefore judges its
own freshness: `renderFreshness()` counts how many build windows have passed
since `generated` without producing a newer build, skipping weekends, and shows
a banner at two and a louder one at four. One missed window is a delayed firing
and stays quiet. The build cannot detect its own non-firing, so this check has
to live on the page rather than in the workflow.

## The commentary gate

`write_commentary.py` composes the morning read from `rates.json` itself, so every
figure in the prose is computed from the same series the grids draw — auto-written
text cannot drift from the data by construction.

It then reconciles whatever is in `commentary.json` — its own output or something
written by hand — against these checks:

| Check | Scope | Catches |
|---|---|---|
| `asof` falls inside the data window | whole box | yesterday's read served against today's curve |
| every `x.xx%` figure matches a level, spread or policy rate in today's data | section | levels carried forward |
| every `NNbp` figure matches a change over 1d/5d/1m/3m/6m/1y, a spread, or a cross-market gap | section | stale move figures |
| steeper/flatter language agrees with the market's `key` pair over at least one of 1d/5d/1m/3m | section | direction reversed since writing |
| selloff/rally language agrees with the long end over at least one of those horizons | section | ditto |

Tolerance follows the precision quoted: `10.3%` is allowed half of its last
decimal place, `4.19%` far less.

Three things about how that gate is drawn, each of them load-bearing:

**Directional language is checked against the pair and the horizons the prose
actually uses.** A section says "2s30s is 3bp steeper over five sessions and 6bp
steeper over the month" in the same paragraph that calls the session a bear
steepening — three claims over three horizons. Testing all of them against one
number is how the gate used to withhold correct reads: `tenors[0]` is the 3M
bill for the US, which tracks the policy floor rather than the curve the prose
describes, and a day and a month routinely point opposite ways. So the check
uses the market's declared `key` pair (US 2s30s, UK 5s30s) and only objects when
the data contradicts the word at *every* horizon it could have been quoted over.

**The data window has two ends.** Publishers do not land together — the BoE GLC
file is regularly a session behind the others — so a read is current if it is
dated anywhere between the date all markets have data through and the freshest
date any market has. Only outside that window is it stale (or, dated ahead of
the data, impossible).

**A bad section costs you that section.** A figure the US read cannot justify
withholds the US lane and leaves the gilt and gold lanes standing, with a note
on the page saying what was dropped and why. Only a missing read, or one dated
outside the window, withholds the whole box behind the "Commentary withheld"
notice.

**Withholding is loud.** `write_commentary.py` reports `published`, `partial` or
`suppressed` as a step output; the workflow turns `suppressed` into a failed
`alert` job *after* the deploy, so the curves still publish but the run goes red
and GitHub mails you. Without that a wordless page ships under a green tick —
which is exactly what happened on 19 Aug 2026. Set `COMMENTARY_STRICT=1` to make
the script itself exit non-zero locally.

To hand-write the read, edit `commentary.json` and run
`python3 write_commentary.py --check` to reconcile it without overwriting.

## Recovering the toolkit from a built page

The whole toolkit is embedded in every built dashboard, so nothing else needs to
be stored anywhere:

```bash
python3 build_dashboard.py --extract bond_yield_monitor.html ./toolkit
```

(Or, without this script: read the `<script id="toolkit">` block, base64-decode
it, and untar the result.)

## Sources

| Market | Publisher | Endpoint | Tenors | Lag |
|---|---|---|---|---|
| US | US Treasury | daily par yield curve XML, one call per year | 1M–30Y | T+0 evening |
| UK | Bank of England | GLC nominal daily archive (`glcnominalddata.zip`, ~39MB) | 0.5Y–40Y | refreshed monthly |
| UK | Bank of England | `latest-yield-curve-data.zip`, current-month GLC nominal | 0.5Y–40Y | T+1 |
| UK | Bank of England | IADB `IUDSNPY`/`IUDMNPY`/`IUDLNPY` par yields — **`UK_BASIS=par` only, blocked from cloud IPs** | 5Y/10Y/20Y | T+1 |
| DE | Deutsche Bundesbank | BBSIS `D.I.ZST.ZI.EUR.S1311.B.A604.R{nn}XX.R.A.A._Z._Z.A` | 1Y–30Y | T+0 |
| JP | Japan MOF | `historical/jgbcme_all.csv` + `jgbcme.csv` | 1Y–40Y | T+0 |
| US real | US Treasury | daily **real** yield curve XML (TIPS), one call per year | 5Y–30Y | T+0 evening |
| Gold | LBMA | `https://prices.lbma.org.uk/json/gold_pm.json` (PM auction, USD/GBP/EUR) | — | T+0 |

Breakeven inflation is derived, not fetched: nominal par yield less real par yield
at the same tenor on the same date, both from the Treasury, so there is no
cross-publisher basis in it.

The GLC zip is cached locally for 7 days; delete it to force a re-download.

## UK methodology

**Default (`UK_BASIS=spot`).** The whole curve is the BoE Government Liability
Curve nominal *spot* curve, archive spliced with the current-month file so it runs
to T+1. This is a different basis from the US par curve: long-end gilt levels sit
a few bp off a par redemption yield, and cross-market 30y differentials carry that
basis. The page states the basis on the UK tile and in the commentary footnote.

**`UK_BASIS=par` (local runs only).**

The Bank of England publishes daily par yields for 5y, 10y and 20y only — there
is no official daily 2y or 30y gilt point. Those two are derived as:

```
2Y  = IUDSNPY + (GLC 2y  spot − GLC 5y  spot)
30Y = IUDLNPY + (GLC 30y spot − GLC 20y spot)
```

so the whole UK curve sits on one par basis and every movement column comes from
official data. Past the GLC archive's cut-off the last observed spread is carried
forward (stable to 1–2bp over a few weeks). Levels are **not** adjusted to screen
quotes; any basis versus a market redemption yield is reported in the footnote.

## Adding a market

1. Write `fetch_xx()` returning `{'YYYY-MM-DD': {tenor: yield_pct}}`.
2. Register it in `FETCHERS` and append an entry to `MARKETS` (code, name,
   tenors, key pair for the tile, spreads, source, basis).
3. Add a colour: `--m-XX` in both theme blocks of `template.html`. Use the next
   validated categorical slot — slot 5 is `#e87ba4` light / `#d55181` dark.
4. Add the policy rate to `policy_rates.json`.

Everything else — grids, spreads, cross-market differentials, curve panels,
percentiles, table view — picks the new market up automatically.

## Writing the commentary

`commentary.json` drives the box at the top. Structure:

```json
{"asof":"YYYY-MM-DD","kicker":"Read of the last session","headline":"one or two sentences",
 "sections":[{"key":"US","title":"US Treasuries",
              "metrics":[{"label":"30y","ref":"m.US.30Y","h":["1d","1m"]}],
              "body":["para one","para two","para three"]}],
 "footnote":"..."}
```

Every figure in a metric chip is **rendered from the data at load time**, never
typed — so the prose and the grids cannot drift apart. Reference grammar:

| Ref | Means |
|---|---|
| `m.US.30Y` | a market's tenor yield |
| `s.US.2Y.30Y` | a curve spread (second minus first) |
| `x.US.UK.30Y` | a cross-market differential (first minus second) |
| `c.usreal.30Y` · `c.breakeven.10Y` · `c.gold.USD` | context series |

`h` is any subset of `1d 5d 1m 3m 6m 1y 5y`. A `key` of US/UK/DE/JP colours the
lane automatically; anything else takes an explicit `"colour"` CSS variable.

Editorial line: interpretation **and** implications for positioning, stopping
short of buy/sell calls. Numbers quoted in the prose must match the chips. Three
lanes — US Treasuries, UK gilts, Gold.

## Monthly maintenance

- `policy_rates.json`: refresh after each Fed / MPC / ECB / BoJ decision. Nothing
  automates this, and the commentary quotes it — a stale Bank Rate will show up
  as a wrong spread-to-policy figure in the gilt lane.
- Check the BoE GLC archive has rolled forward (it publishes early each month).
  The current-month file covers the gap either way, so this is a check rather
  than a dependency.
- Re-test the IADB endpoint occasionally; if the block lifts, `UK_BASIS=par`
  restores the par basis and full comparability with the US curve.
