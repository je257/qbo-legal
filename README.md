# qbo-legal

Private Claude connectors. Besides the QuickBooks connector described below,
this repo also contains [`ycharts-mcp/`](ycharts-mcp/README.md) — an MCP
server connecting Claude to the YCharts API (market data: points, series,
info, dividends, splits, securities discovery). See its README for setup.

A private QuickBooks Online connector for Claude, in two parts:

- **Static pages** (repo root, served by GitHub Pages) — the URLs an Intuit
  developer app requires:
  - [`privacy.html`](privacy.html) — privacy policy
  - [`eula.html`](eula.html) — end-user license agreement
  - [`callback.html`](callback.html) — OAuth redirect page that displays the
    authorization code for the terminal auth flow
- **`mcp/`** — `qbo-mcp`, a local MCP (Model Context Protocol) server that
  connects Claude Desktop or Claude Code to your QuickBooks Online company.

Tokens and credentials stay on your own machine (`~/.qbo-mcp/`, owner-only
file permissions). Nothing is hosted anywhere except these static pages.

> **New here?** Follow the step-by-step [beginner setup guide](SETUP.md) —
> it assumes no programming experience. The notes below are the condensed
> version for developers.

## One-time setup

### 1. Enable GitHub Pages

In this repo: **Settings → Pages → Deploy from a branch → `main` / (root)**.
The pages will be served at:

- `https://je257.github.io/qbo-legal/callback.html`
- `https://je257.github.io/qbo-legal/privacy.html`
- `https://je257.github.io/qbo-legal/eula.html`

### 2. Create the Intuit developer app

1. Sign in at [developer.intuit.com](https://developer.intuit.com) with the
   same Intuit account that owns your QuickBooks company.
2. Create an app → **QuickBooks Online and Payments**, scope
   **com.intuit.quickbooks.accounting**.
3. Under **Keys & credentials** (Production, or Development for sandbox
   testing), add the redirect URI:
   `https://je257.github.io/qbo-legal/callback.html`
4. Under the app's settings, set the privacy policy and EULA links to the
   Pages URLs above (Intuit requires them for production keys).
5. Copy the **Client ID** and **Client Secret**.

### 3. Install, authorize, and add to Claude

Requires Node.js 18+.

```sh
cd mcp
npm install     # also builds (prepare script)
node dist/index.js setup
```

`setup` runs two things in sequence:

- **`auth`** — prompts for the Client ID / Client Secret (stored in
  `~/.qbo-mcp/config.json`, mode 600), prints the Intuit authorization URL,
  and opens your browser. Sign in, pick your company, and approve. Intuit
  redirects to the callback page, which shows the full redirect URL — copy
  it and paste it back into the terminal. Tokens land in
  `~/.qbo-mcp/tokens.json`.
- **`install`** — registers the server in Claude Desktop's
  `claude_desktop_config.json` automatically (existing config is backed up
  first), then prints the equivalent `claude mcp add` one-liner for Claude
  Code users.

Each is also runnable on its own (`node dist/index.js auth` /
`node dist/index.js install`), and `node dist/index.js status` checks the
connection. After `install`, restart Claude Desktop.

Manual registration, if you prefer it — **Claude Code:**

```sh
claude mcp add qbo -- node /absolute/path/to/qbo-legal/mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "qbo": {
      "command": "node",
      "args": ["/absolute/path/to/qbo-legal/mcp/dist/index.js"]
    }
  }
}
```

Environment variables override the stored config if you prefer not to keep
credentials in `~/.qbo-mcp/config.json`: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
`QBO_ENV` (`production` | `sandbox`), `QBO_REDIRECT_URI`, `QBO_MCP_DIR`.

## Tools exposed to Claude

| Tool | What it does |
| --- | --- |
| `qbo_auth_status` | Connection, environment, and token expiry |
| `qbo_company_info` | Company profile (name, fiscal year, currency) |
| `qbo_query` | SQL-like queries (`SELECT * FROM Invoice WHERE ...`) |
| `qbo_get` | Fetch one record by entity type and Id |
| `qbo_report` | Built-in reports (ProfitAndLoss, BalanceSheet, AgedReceivables, ...) |
| `qbo_create` | Create a record from a QBO API JSON payload |
| `qbo_update` | Sparse-update a record (SyncToken fetched automatically) |
| `qbo_delete` | Delete a transaction record |

Access tokens auto-refresh; the refresh token itself expires ~100 days after
last use, after which `node dist/index.js auth` must be re-run.

## Maintenance

- **Revoke access:** QuickBooks Online → Settings → Apps → Manage connected
  apps, and/or delete `~/.qbo-mcp/`.
- **Rebuild after changing the source:** `cd mcp && npm run build`.

Independent integration built on the Intuit Developer platform. Not
affiliated with Intuit Inc.
