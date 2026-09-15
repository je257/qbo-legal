# ycharts-mcp

A local MCP (Model Context Protocol) server that connects Claude Desktop or
Claude Code to the **YCharts API using your own API key**.

Why this exists, when an official YCharts connector already ships with Claude:

1. **Your key, your entitlements.** The official connector runs on whatever
   API access YCharts provisioned for it. This server sends every request with
   the key *you* configure, so what you're licensed for is what you get.
2. **v3 per-security data.** The v4 API has no per-company data endpoint —
   stocks come back only as chart images. The older v3 API has
   `/v3/companies/{symbols}/points|series/{calc}` endpoints that return **raw
   numbers per stock** (price, P/E, market cap, ROIC, …), subject to the key's
   field licensing. This server exposes both APIs.
3. **A built-in entitlement diagnostic** (`ycharts_diagnose`), so the first
   call answers exactly what your key can and cannot access.

The key never leaves your machine except in requests to `api.ycharts.com`
(the client refuses any other destination). It is stored at
`~/.ycharts-mcp/config.json` with owner-only permissions, or read from the
`YCHARTS_API_KEY` environment variable (which takes precedence).

## Setup

```bash
cd ycharts-mcp
npm install
npm run build
node dist/index.js setup      # paste your YCharts API key (stored 0600)
node dist/index.js diagnose   # map what the key can access — run this first
node dist/index.js install    # add to Claude Desktop (also prints the Claude Code line)
```

For **Claude Code**, either run the one-liner that `install` prints:

```bash
claude mcp add ycharts -- node /absolute/path/to/qbo-legal/ycharts-mcp/dist/index.js
```

or open this repository directly — the repo-root `.mcp.json` already declares
the server (build it first; set `YCHARTS_API_KEY` in your environment or run
`setup` once).

For **Claude Code on the web / cloud sessions**: add `YCHARTS_API_KEY` as an
environment variable (or secret) in your environment settings, and make sure
the environment's network policy allows `api.ycharts.com` — the default
restricted policy blocks it.

## CLI commands

| Command | What it does |
|---|---|
| `serve` (default) | Run the MCP server on stdio |
| `setup` | Prompt for and store the API key |
| `status` | Show whether a key is configured (masked) and its source |
| `diagnose` | Run the live entitlement probes from the terminal |
| `install` | Register the server in Claude Desktop / print the Claude Code line |

## Tools

**Diagnostics** — `ycharts_status`, `ycharts_diagnose`

**Raw per-security data (v3)** — `ycharts_company_points`,
`ycharts_company_series`, `ycharts_company_info` (all take a `kind` of
`companies` | `mutual_funds` | `indices` | `indicators`, default `companies`)

**Screeners & universes (v4)** — `ycharts_screeners_list`, `ycharts_screener`,
`ycharts_security_lists`

**Funds (v4)** — `ycharts_fund_data`, `ycharts_fund_holdings`

**Model portfolios (v4)** — `ycharts_model_portfolios`,
`ycharts_model_portfolio_holdings` (target vs. current weights — the drift
primitive), `ycharts_model_portfolio_points`, `ycharts_model_portfolio_series`,
`ycharts_model_portfolio_status`, `ycharts_create_fixed_model_portfolio`,
`ycharts_update_fixed_model_portfolio`

**Escape hatch** — `ycharts_request` (any `/v3/…` or `/v4/…` path;
`api.ycharts.com` only)

## Notes on entitlements

Field-level licensing is enforced server-side by YCharts per API key. A
request touching an unlicensed field fails with
`Field 'X' is not available` — this server surfaces that as a clear error
naming the field. If `ycharts_diagnose` shows fundamentals blocked on both v3
and v4, the fix is a licensing request to YCharts, not a code change.

## Development

```bash
npm run build && npm run smoke   # offline smoke test (no API key needed)
```
