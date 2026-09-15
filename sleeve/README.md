# hw-sleeve

Manager for the HW stock sleeve (~50 S&P 500 stocks, passively-active,
active share < 40%, sector weights within ±5% of the index): daily drift
monitoring against per-position bands, benchmark characteristics comparison,
and universe/weights plumbing — all on the YCharts API.

Data sources follow the waterfall in
[`../ycharts-mcp/DATA-ACCESS.md`](../ycharts-mcp/DATA-ACCESS.md). Uses the
same API key as `ycharts-mcp` (run its `setup` once; or set
`YCHARTS_API_KEY`).

## Setup

```bash
cd sleeve
npm install
npm run build
node dist/index.js portfolios      # find the sleeve's model-portfolio id
# put that id in sleeve.config.json as portfolioId, then:
node dist/index.js drift
```

## Commands

| Command | What it does |
|---|---|
| `portfolios [name]` | List your YCharts model portfolios (id, benchmark, perf date) |
| `drift [id]` | Target vs current weights, relative drift per position, tiered band check, trade-back-to-target amounts |
| `characteristics [id]` | Sleeve vs SPY: weighted P/E, P/B, avg market cap, concentration, returns, sector exposures |
| `universe` | Current S&P 500 constituents (503, incl. GOOG/GOOGL etc.) from the "S&P 500 Universe (API)" screener |
| `spy-top` | Exact top-25 index weights via SPY holdings |

## Configuration (`sleeve.config.json`)

- `portfolioId` — the sleeve's YCharts model portfolio id (**required**)
- `driftBands` — tiers by TARGET weight; relative drift = (current − target)
  ÷ target. Defaults: ≥5% target → 20% band, ≥2% → 35%, ≥1% → 50%,
  rest → 75%. **Edit to the desk's actual tiers.**
- `sectorBandPct` (±5), `maxActiveSharePct` (40) — used by the checks as
  they come online
- `characteristicsCalcs` / `sectorCalcs` — YCharts model-portfolio calc codes

## Testing

`npm run smoke` — offline engine tests (band tiers, drift math, breach
flags, untargeted positions, report formatting). No key or network needed.

## Roadmap

1. ✅ Drift monitor + characteristics + universe/weights plumbing
2. Screener-export ingest (`ingest <export.xlsx>`): metric columns + the
   internal score for the ~275-name universe; ratings overlay from
   Equity_Ratings.xlsx
3. Benchmark weight vector (SPY top-25 exact + market-cap tail), active
   share, sector deltas vs the index
4. Selection & rebalance: score → ~50 names → validate (sector bands,
   active share, index-relative sizing) → push target weights to the
   model portfolio via the API
5. Earnings watch (Alpha Vantage calendar) + daily scheduled run/alerts
