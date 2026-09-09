# ycharts-mcp

A local MCP (Model Context Protocol) server that connects Claude Desktop or
Claude Code to the **YCharts API v4** (`https://api.ycharts.com/v4`, docs at
[ycharts.com/v4/docs](https://ycharts.com/v4/docs)), built against its
OpenAPI 3.1 spec. It covers every v4 endpoint — funds, economic indicators,
rendered Fundamental Charts, model portfolios, screeners, watchlists,
security lists, timeseries tables, custom PDF reports, registrations, risk
profiles, Quick Extract, quickflows, integrations, background jobs — plus
the legacy **v3 data API** (raw stock/fund/index points, series, info,
dividends, splits, spinoffs) and a raw-request escape hatch.

Your API key stays on your own machine (`~/.ycharts-mcp/config.json`,
owner-only file permissions). Nothing is hosted anywhere.

## What you need

- **A YCharts API key** with the API V4 Add-On — find/regenerate it at
  [ycharts.com/api_v4](https://ycharts.com/api_v4). (The v3 data tools need
  v3 API access, a separate entitlement; `ycharts_status` reports which of
  the two your key can reach.)
- **Node.js 18+** ([nodejs.org](https://nodejs.org), LTS version).

## Install, authorize, and add to Claude

```sh
cd ycharts-mcp
npm install     # also builds (prepare script)
node dist/index.js setup
```

`setup` runs two things in sequence:

- **`auth`** — prompts for your API key, verifies it live against
  api.ycharts.com (v4, then the v3 fallbacks), and stores the key plus the
  working endpoint in `~/.ycharts-mcp/config.json` (mode 600).
- **`install`** — registers the server in Claude Desktop's
  `claude_desktop_config.json` automatically (existing config is backed up
  first), then prints the equivalent `claude mcp add` one-liner for Claude
  Code users.

Each is also runnable on its own (`node dist/index.js auth` /
`node dist/index.js install`), and `node dist/index.js status` checks the
connection. After `install`, fully restart Claude Desktop.

Manual registration — **Claude Code:**

```sh
claude mcp add ycharts -- node /absolute/path/to/qbo-legal/ycharts-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "ycharts": {
      "command": "node",
      "args": ["/absolute/path/to/qbo-legal/ycharts-mcp/dist/index.js"]
    }
  }
}
```

Environment variables override the stored config: `YCHARTS_API_KEY`,
`YCHARTS_BASE_URL` (default `https://api.ycharts.com`),
`YCHARTS_API_VERSION` (default `v4`), `YCHARTS_MCP_DIR`.

## Tools exposed to Claude

**Meta**

| Tool | What it does |
| --- | --- |
| `ycharts_status` | Verifies the key against v4 and v3, reports what works |
| `ycharts_reference` | Local cheat sheet: endpoint catalog, security-id conventions, filter/body formats |
| `ycharts_raw_request` | GET any API path (v4 or v3) — the escape hatch |

**Market data**

| Tool | What it does |
| --- | --- |
| `ycharts_funds` / `ycharts_fund_holdings` | Fund/ETF default data (1–25 symbols) and top-25 holdings |
| `ycharts_indicators_search` | Discover economic indicator codes by region/source/category/report |
| `ycharts_indicator_info` / `_points` / `_series` | Indicator fields, latest values, and time series (resampling, fill, aggregation) |
| `ycharts_fundamental_chart` | **Renders a real YCharts Fundamental Chart as a PNG** — shown inline in Claude, saved to a temp file, optional shareable download URL; supports ratio/spread/correlation overlays |
| `ycharts_v3_*` (7 tools) | Legacy v3 raw data: stock/ETF/fund/index points, series, info, dividends, splits, spinoffs, and securities discovery |

**Portfolios, screens & lists**

| Tool | What it does |
| --- | --- |
| `ycharts_model_portfolios_list` / `_get` / `_data` | Browse portfolios; get detail/calc status; bulk info, point & series calcs (e.g. `level`, `one_year_total_return`), holdings |
| `ycharts_model_portfolio_create` / `_update` | Create model/client/household/benchmark portfolios; replace items or currency |
| `ycharts_screeners_list` / `_get` / `_create` / `_update` / `_to_watchlist` | Saved stock & fund screeners: run them, build them from metric/universe filters, save matches as a watchlist |
| `ycharts_security_lists` | Search all universe-filter lists (catalog, YCharts Proprietary, your own) |
| `ycharts_watchlists_list` / `_get` / `_create` / `_update` | Watchlists (multi-security and indicator) |
| `ycharts_timeseries_tables_list` / `_get` / `_create` / `_update` | Saved data grids of metrics × securities over time — the closest v4 gets to bulk raw data |
| `ycharts_quickflows` / `_update` | Read or replace the quickflows list |

**Advisor workflow**

| Tool | What it does |
| --- | --- |
| `ycharts_custom_pdf_reports` / `ycharts_generate_pdf_report` | List report templates, inspect required parameters, generate the PDF (link or file) |
| `ycharts_registrations` / `_search` / `_create` / `_update` / `_import` | Client registrations & households, incl. integration-partner search/import |
| `ycharts_risk_profiles` | Risk profiles with targets and ranges |
| `ycharts_quick_extract` / `_status` | Parse a local statement/holdings file into accounts + holdings |
| `ycharts_background_job` | Poll background jobs (e.g. imports) |

## Good to know

- Symbol conventions: stocks/ETFs `AAPL`/`SPY`, mutual funds `M:VFIAX`,
  indices `^SPX`, indicators `I:USGDP`, portfolios `P:12345`, cash `cash`
  (never bare `CASH` — that's a real ticker). `ycharts_reference` has the
  full list plus the packed-filter (`key:::value,,,key:::value`) format.
- Responses are wrapped in `{response, meta:{status,url}}`; bulk endpoints
  return per-symbol/per-code errors inline, so partial failures still
  return data.
- Write tools (create/update portfolios, screeners, watchlists, tables,
  registrations, quickflows) are marked as such for permission prompting;
  everything else is read-only.
- Per YCharts' API terms, data is for your internal use only;
  redistribution requires YCharts' written consent.
- **Revoke access:** rotate/disable the key at
  [ycharts.com/api_v4](https://ycharts.com/api_v4), and/or delete
  `~/.ycharts-mcp/`.
- **Rebuild after changing the source:** `cd ycharts-mcp && npm run build`.
- Handy: drop the API's `openapi.json`
  (https://api.ycharts.com/v4/openapi.json) into this folder for offline
  reference; it is the source of truth this server was built against.

Independent integration built against the YCharts API. Not affiliated with
YCharts, Inc.
