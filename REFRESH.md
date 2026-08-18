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

## The commentary gate

`write_commentary.py` composes the morning read from `rates.json` itself, so every
figure in the prose is computed from the same series the grids draw — auto-written
text cannot drift from the data by construction.

It then reconciles whatever is in `commentary.json` — its own output or something
written by hand — and **suppresses the box entirely** if any of these fail:

| Check | Catches |
|---|---|
| `asof` equals the latest data date | yesterday's read served against today's curve |
| every `x.xx%` figure matches a level, spread or policy rate in today's data | levels carried forward |
| every `NNbp` figure matches a change over 1d/5d/1m/3m/6m/1y, a spread, or a cross-market gap | stale move figures |
| steeper/flatter language agrees with the sign of the 1d spread change | direction reversed since writing |
| selloff/rally language agrees with the sign of the 1d long-end change | ditto |

Tolerance follows the precision quoted: `10.3%` is allowed half of its last
decimal place, `4.19%` far less. Suppression is visible — the page shows a
"Commentary withheld" notice with the reasons in place of the read, rather than
the box quietly vanishing.

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
