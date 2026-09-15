# YCharts API data-access map (verified 2026-09-16)

Every path to stock data in the YCharts API, verified against the live API and
the official v4 OpenAPI spec (all 37 paths enumerated). This is the build spec
for the stock-sleeve application's data layer.

## Numbers (machine-readable values)

| # | Path | Status on this account | Use |
|---|---|---|---|
| 1 | v3 `/companies/{syms}/points\|series\|info` | Endpoint live; key got HTTP 403 — v3 access not enabled | Raw per-stock metrics/history/info. PRIMARY adapter once YCharts enables it |
| 2 | v4 model-portfolio calcs (`points`/`series`, 1,151 codes) | WORKS | Portfolio aggregates (weighted avg P/E, sector exposure, drift, returns). Single-stock portfolios = per-stock numbers (batch-readable, multiple ids per call) |
| 3 | v4 `/funds/{syms}` + `/funds/{sym}/holdings` | WORKS | SPY top-25 exact weights; index-level weighted aggregates for benchmark comparison |
| 4 | v4 `/indicators` (points/series/info) | WORKS | Macro/economic series |
| 5 | v4 `/custom_pdf_reports/{id}/generate` + PDF parsing | WORKS (15 templates) | Last-resort: stock sections in PDFs, parsed programmatically. Fragile |

## Membership & structure (all WORK on this account)

- Screeners: list + re-run saved screens -> live ticker lists (identity fields
  ONLY — column values never returned by the API, proven on an entitled
  screener). Screens referencing unlicensed fields fail entirely on read.
  "S&P 500 Universe (API)" (id 1871434): 503 constituents incl. GOOG/GOOGL,
  FOX/FOXA, NWS/NWSA, BRK.B, BF.B.
- Security lists: universe discovery (e.g. index_sandp_500).
- Model portfolios: target vs current holdings weights (drift primitive),
  create fixed / update items (rebalance), status polling.
- Watchlists, quickflows, registrations, risk profiles, quick_extract
  (statement-holdings extraction from uploaded files).

## NOT available via API (confirmed against all 37 v4 paths)

- Comp tables and timeseries tables: no endpoints; CRUD tools disabled
  server-side. UI Excel export only. Existing tables usable only as
  screener universe filters.
- Screener column values (incl. custom scores): UI Excel export only.
- v4 per-company data endpoint: does not exist (charts are PNG-only;
  `data_format` is a series transform, not an output format).
- Full index constituent weights: fund holdings capped at top 25.
- CFRA / Morningstar star ratings: no fields anywhere in the 6,135-metric
  catalog (only Morningstar sector/style classification and YCharts' own
  Y-Rating / fractile scores).

## Field entitlements (enforced per API key, at read time)

Blocked on the official-connector key (six codes observed): market_cap,
pe_ratio, payout_ratio, return_on_invested_capital,
relative_pe_ratio_industry, quarterly_eps_actual. Entitled: price,
total returns, SMAs, highs/lows, dividend_yield, rating filters,
securitylist filters. This key's own profile: run `node dist/index.js
diagnose`.

## Application data waterfall

For each metric class, use the best available source, probing at startup
(diagnose) and degrading gracefully:

1. v3 raw points/series (when enabled)
2. v4 fundamental fields (when licensed)
3. v4 single-stock model-portfolio calcs (works today; valuation/dividend/
   return subset)
4. Screener UI Excel export ingest (carries ALL columns + the internal score)
5. Alpha Vantage (earnings calendar, market status, close cross-checks)

Benchmark weights: SPY top-25 exact + market-cap-proportional tail scaled to
the residual, dual-class apportioned by per-class shares; full precision once
market_cap unlocks via (1) or (2).
