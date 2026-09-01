# qbo-legal

Support files for a private QuickBooks Online connector for Claude.

## Contents

- **`worker.js`** — a self-contained Cloudflare Worker that acts as a remote
  MCP server for QuickBooks Online: it handles the Intuit OAuth sign-in,
  stores and auto-refreshes tokens in Cloudflare KV, and exposes read-only
  tools (`qbo_report`, `qbo_query`, `qbo_company_info`, `qbo_auth_status`)
  to Claude as a custom connector. No dependencies, no build step — it can be
  pasted into the Cloudflare dashboard editor from any device, including an
  iPad.
- **`SETUP-IPAD.md`** — step-by-step setup done entirely from Safari on an
  iPad (no terminal or computer needed).
- **`wrangler.jsonc`** — optional config for deploying with the wrangler CLI
  instead of the dashboard.
- **`eula.html` / `privacy.html`** — legal pages referenced by the Intuit
  developer app listing.
- **`callback.html`** — legacy OAuth callback page used by the old local
  `qbo-mcp` CLI flow (superseded by the Worker's built-in `/callback` route;
  kept for reference).
