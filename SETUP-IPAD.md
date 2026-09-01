# QuickBooks → Claude connector: iPad-only setup

This guide rebuilds your QuickBooks connector so it runs **in the cloud** instead
of on a computer. Everything below is done in Safari on the iPad — no terminal,
no laptop. When you're finished, Claude (the iPad app or claude.ai) talks to a
small private server on Cloudflare, and that server talks to QuickBooks Online.

The old setup ran `qbo-mcp` locally on the stolen computer, which an iPad can't
do. This replaces it.

> **Quicker alternative first:** Claude now has an official QuickBooks connector
> (claude.ai → Connectors → search "QuickBooks" → Connect, US accounts). If that
> covers what you need, you can skip this whole guide. The custom connector below
> is for when you want your own Intuit app, your own tool set, and no dependence
> on the official connector's feature set.

---

## Step 0 — Secure the old connector (do this first)

Your computer was stolen and it held QuickBooks credentials (refresh tokens, and
possibly the app's client secret).

1. In Safari, go to **developer.intuit.com** and sign in.
2. Open your app (the one the old connector used) → **Keys & credentials** →
   **Production keys**.
3. **Regenerate the Client Secret.** This immediately makes the stolen refresh
   token useless — QuickBooks token refreshes require the client secret, and
   access tokens themselves expire within an hour.
4. While you're on this page, copy the **Client ID** and the **new Client
   Secret** somewhere safe (you'll paste them in Step 3).

Also worth doing: change your Intuit account password if it may have been saved
in the stolen computer's browser.

## Step 1 — Create the Cloudflare Worker

Cloudflare's free plan is enough for this.

1. Go to **dash.cloudflare.com** (create a free account if needed).
2. In the left sidebar: **Compute (Workers)** → **Workers & Pages** →
   **Create** → **Create Worker** (the "Hello World" starter).
3. Name it `qbo-mcp` (or anything) and tap **Deploy**.
4. Tap **Edit code**. Delete the starter code and paste in the full contents of
   [`worker.js`](./worker.js) from this repo (open the file on GitHub, tap
   **Raw**, select all, copy).
5. Tap **Save and deploy**.
6. Note your Worker URL — it looks like
   `https://qbo-mcp.<your-subdomain>.workers.dev`. Everything below calls it
   `<WORKER-URL>`.

## Step 2 — Create the token store (KV)

1. Cloudflare dashboard → **Storage & Databases** → **KV** →
   **Create a namespace** → name it `QBO_KV`.
2. Go back to your Worker → **Settings** → **Bindings** → **Add** →
   **KV namespace**:
   - Variable name: `QBO_KV`
   - KV namespace: the one you just created

## Step 3 — Add the secrets

Worker → **Settings** → **Variables and Secrets** → **Add**. Create these,
choosing type **Secret** for each:

| Name | Value |
|---|---|
| `INTUIT_CLIENT_ID` | Client ID from Step 0 |
| `INTUIT_CLIENT_SECRET` | The **new** Client Secret from Step 0 |
| `CONNECTOR_KEY` | A long random string, 32+ characters (see below) |

`CONNECTOR_KEY` is the password baked into your connector's URLs — anyone who
has it can read your QuickBooks data, so make it long and random. Easy way on
the iPad: open `<WORKER-URL>/` in Safari — the page generates a fresh random
key suggestion on every load (it isn't stored anywhere). Copy it into the
secret **and** into a note/password manager; you'll need it in Steps 5 and 6.

Optional: add a plaintext variable `QBO_ENV` = `sandbox` if you want to test
against a sandbox company first (default is `production`).

## Step 4 — Register the redirect URI with Intuit

1. Back at **developer.intuit.com** → your app → **Keys & credentials**
   (production side).
2. Under **Redirect URIs**, add:
   `‎<WORKER-URL>/callback`
   (for example `https://qbo-mcp.yoursubdomain.workers.dev/callback`)
3. Save.

## Step 5 — Connect the Worker to QuickBooks

1. In Safari, open: `<WORKER-URL>/auth/<CONNECTOR_KEY>`
2. Sign in to Intuit, pick your company, and approve access.
3. You should land on a "QuickBooks connected" page. Done — tokens are stored
   in your Cloudflare KV and refresh automatically from now on.

You can check the connection anytime at `<WORKER-URL>/status/<CONNECTOR_KEY>`.

## Step 6 — Add the connector to Claude

1. Open **claude.ai** in Safari (or Settings in the Claude app) →
   **Settings** → **Connectors** → **Add custom connector**.
2. Name: `QuickBooks`
   URL: `<WORKER-URL>/mcp/<CONNECTOR_KEY>`
3. Add it. No OAuth fields are needed — the key in the URL is the credential.
4. In a new chat, make sure the connector is enabled (tools/search menu), then
   try: *"Check my QuickBooks connection"* → Claude should call
   `qbo_auth_status` and report the company realm ID.

## What Claude can do with it

| Tool | What it does |
|---|---|
| `qbo_report` | Any QuickBooks report: ProfitAndLoss, BalanceSheet, CashFlow, TrialBalance, GeneralLedger, TransactionList, AgedReceivables, ... |
| `qbo_query` | SQL-like queries over entities (Invoice, Bill, Customer, Vendor, Purchase, JournalEntry, ...) |
| `qbo_company_info` | Company profile |
| `qbo_auth_status` | Connection health, token expiry |

It's read-only by design — no tools can create or modify QuickBooks records.

## Troubleshooting

- **"Unauthorized" opening /auth or /mcp** — the key in the URL doesn't match
  the `CONNECTOR_KEY` secret, or the secret isn't set / is under 16 characters.
- **Intuit error about redirect URI** — the URI in Step 4 must match
  `<WORKER-URL>/callback` exactly (https, no trailing slash).
- **"Not connected to QuickBooks yet"** from Claude — run Step 5.
- **"Token refresh failed"** — QuickBooks refresh tokens expire after ~100 days
  of disuse, and rotating the Intuit client secret invalidates them; re-run
  Step 5 to reconnect.
- **Claude can't reach the connector** — confirm the `/mcp/<key>` URL is right
  by checking `<WORKER-URL>/status/<CONNECTOR_KEY>` loads, and that you saved
  and deployed the Worker after adding bindings/secrets.

## Security notes

- The `CONNECTOR_KEY` is the only thing protecting your books — treat the
  full `/mcp/...` URL like a password. To rotate it: change the secret in
  Cloudflare, then update the connector URL in Claude.
- QuickBooks tokens live only in your Cloudflare KV namespace, never on a
  device — nothing to lose if hardware is lost or stolen again.
- If a device with the connector URL is ever lost, rotating `CONNECTOR_KEY`
  (and, belt-and-suspenders, the Intuit client secret) cuts off all access.
