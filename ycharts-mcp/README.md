# ycharts-mcp

A local MCP (Model Context Protocol) server that connects Claude Desktop or
Claude Code to the [YCharts API](https://ycharts.com/v4/docs), covering the
full API surface: point-in-time values, historical time series, security
info, dividends, splits, spinoffs, securities discovery, and a raw-request
escape hatch for anything else the API exposes.

Your API key stays on your own machine (`~/.ycharts-mcp/config.json`,
owner-only file permissions). Nothing is hosted anywhere.

## What you need

- **A YCharts API key.** API access is a YCharts subscription add-on — the
  key comes from your YCharts account manager or
  [sales@ycharts.com](mailto:sales@ycharts.com). Docs and sandbox:
  [ycharts.com/v4/docs](https://ycharts.com/v4/docs).
- **Node.js 18+** ([nodejs.org](https://nodejs.org), LTS version).

## Install, authorize, and add to Claude

```sh
cd ycharts-mcp
npm install     # also builds (prepare script)
node dist/index.js setup
```

`setup` runs two things in sequence:

- **`auth`** — prompts for your API key, verifies it live against the
  known YCharts API endpoints (v4 first, falling back to v3), and stores
  the key plus the working endpoint in `~/.ycharts-mcp/config.json`
  (mode 600).
- **`install`** — registers the server in Claude Desktop's
  `claude_desktop_config.json` automatically (existing config is backed up
  first), then prints the equivalent `claude mcp add` one-liner for Claude
  Code users.

Each is also runnable on its own (`node dist/index.js auth` /
`node dist/index.js install`), and `node dist/index.js status` checks the
connection. After `install`, fully restart Claude Desktop.

Manual registration, if you prefer it — **Claude Code:**

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

| Tool | What it does |
| --- | --- |
| `ycharts_status` | Key present? Probes the API endpoints and reports connectivity |
| `ycharts_reference` | Local cheat sheet: symbol conventions, common metric codes, filters, series params |
| `ycharts_list_securities` | Discover securities by type with filters (sector, category, region, ...) |
| `ycharts_points` | Latest or as-of-date values — up to 100 symbols × 100 metrics per call |
| `ycharts_series` | Historical series with resampling, fill, and aggregation options |
| `ycharts_info` | Descriptive fields (name, exchange, sector, fund family, ...) |
| `ycharts_dividends` | Dividend history for companies/ETFs and mutual funds |
| `ycharts_splits` | Stock split history |
| `ycharts_spinoffs` | Spinoff history |
| `ycharts_raw_request` | GET any API path — holdings, allocations, new v4 endpoints |

Security types and symbol conventions: `companies` covers stocks **and
ETFs** (`AAPL`, `SPY`), `mutual_funds` uses `M:` symbols (`M:VFINX`),
`indicators` uses `I:` symbols (`I:USICSA`), `indices` uses `^` symbols
(`^SPX`). Ask Claude to call `ycharts_reference` when in doubt.

## Good to know

- The YCharts API is **read-only**; every tool is a GET. There is nothing
  this connector can modify in your YCharts account.
- Metric ("calculation") codes vary by subscription. Bad codes fail
  per-item inside an otherwise successful response, so trying one is cheap.
  The authoritative list is your account's Export Metric Reference Guide
  and [ycharts.com/v4/docs](https://ycharts.com/v4/docs).
- Batch symbols/metrics into one call (up to 100 each) rather than looping —
  it is dramatically friendlier to YCharts rate limits.
- Per YCharts' API terms, data is for your internal use only;
  redistribution requires YCharts' written consent.
- **Revoke access:** rotate/disable the key with YCharts, and/or delete
  `~/.ycharts-mcp/`.
- **Rebuild after changing the source:** `cd ycharts-mcp && npm run build`.

Independent integration built against the YCharts API. Not affiliated with
YCharts, Inc.
