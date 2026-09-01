/**
 * QuickBooks Online — remote MCP connector for Claude.
 *
 * A single-file Cloudflare Worker with no dependencies and no build step,
 * so it can be pasted straight into the Cloudflare dashboard editor
 * (works from an iPad in Safari).
 *
 * Endpoints:
 *   GET  /                      Info page (public, no secrets)
 *   GET  /auth/<CONNECTOR_KEY>  Start the Intuit OAuth sign-in
 *   GET  /callback              Intuit OAuth redirect target
 *   GET  /status/<CONNECTOR_KEY> Connection status (no token values shown)
 *   POST /mcp/<CONNECTOR_KEY>   MCP endpoint (Streamable HTTP, JSON-RPC 2.0)
 *
 * Required bindings/secrets (Worker Settings):
 *   QBO_KV               KV namespace binding (token + OAuth-state storage)
 *   INTUIT_CLIENT_ID     secret — from developer.intuit.com Keys & credentials
 *   INTUIT_CLIENT_SECRET secret — same page
 *   CONNECTOR_KEY        secret — long random string; part of the URLs above
 * Optional:
 *   QBO_ENV              "production" (default) or "sandbox"
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "quickbooks-online", title: "QuickBooks Online", version: "1.0.0" };
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const OAUTH_SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";
const TOKENS_KEY = "qbo:tokens";
const MAX_RESULT_CHARS = 100000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "") return infoPage();
      if (path === "/callback") return handleCallback(env, url);

      let m;
      if ((m = path.match(/^\/auth\/([^/]+)$/))) {
        if (!(await keyMatches(env, m[1]))) return keyRejection(env);
        return handleAuthStart(env, url);
      }
      if ((m = path.match(/^\/status\/([^/]+)$/))) {
        if (!(await keyMatches(env, m[1]))) return keyRejection(env);
        return handleStatus(env);
      }
      if ((m = path.match(/^\/mcp\/([^/]+)$/))) {
        if (!(await keyMatches(env, m[1]))) return keyRejection(env);
        return handleMcp(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Server error: " + errMessage(err), { status: 500 });
    }
  },
};

/* ------------------------------------------------------------------ */
/* Access key                                                          */
/* ------------------------------------------------------------------ */

async function keyMatches(env, provided) {
  const key = env.CONNECTOR_KEY;
  if (typeof key !== "string" || key.length < 16) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(key)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function keyRejection(env) {
  const hint =
    typeof env.CONNECTOR_KEY === "string" && env.CONNECTOR_KEY.length >= 16
      ? "Wrong key in URL."
      : "CONNECTOR_KEY secret is not set (or is under 16 characters) in the Worker settings.";
  return new Response("Unauthorized. " + hint, { status: 401 });
}

/* ------------------------------------------------------------------ */
/* Intuit OAuth                                                        */
/* ------------------------------------------------------------------ */

function configProblems(env) {
  const problems = [];
  if (!env.QBO_KV) problems.push("KV namespace binding QBO_KV is missing (Worker Settings → Bindings).");
  if (!env.INTUIT_CLIENT_ID) problems.push("Secret INTUIT_CLIENT_ID is not set.");
  if (!env.INTUIT_CLIENT_SECRET) problems.push("Secret INTUIT_CLIENT_SECRET is not set.");
  return problems;
}

async function handleAuthStart(env, url) {
  const problems = configProblems(env);
  if (problems.length) return htmlPage("Setup incomplete", "<ul><li>" + problems.map(escapeHtml).join("</li><li>") + "</li></ul>", 500);

  const state = crypto.randomUUID();
  await env.QBO_KV.put("qbo:state:" + state, "1", { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.INTUIT_CLIENT_ID,
    response_type: "code",
    scope: OAUTH_SCOPE,
    redirect_uri: url.origin + "/callback",
    state,
  });
  return Response.redirect(AUTHORIZE_URL + "?" + params.toString(), 302);
}

async function handleCallback(env, url) {
  const problems = configProblems(env);
  if (problems.length) return htmlPage("Setup incomplete", "<ul><li>" + problems.map(escapeHtml).join("</li><li>") + "</li></ul>", 500);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  if (!code || !state) {
    return htmlPage(
      "No authorization code received",
      "<p>This page only works at the end of the QuickBooks sign-in. Start again from the <code>/auth/&lt;key&gt;</code> link.</p>",
      400
    );
  }
  const known = await env.QBO_KV.get("qbo:state:" + state);
  if (!known) {
    return htmlPage(
      "Sign-in expired",
      "<p>The sign-in attempt was not recognized (state mismatch or older than 10 minutes). Start again from the <code>/auth/&lt;key&gt;</code> link.</p>",
      400
    );
  }
  await env.QBO_KV.delete("qbo:state:" + state);

  const tok = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: url.origin + "/callback",
  });

  const existing = await env.QBO_KV.get(TOKENS_KEY, "json");
  await env.QBO_KV.put(
    TOKENS_KEY,
    JSON.stringify({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      realm_id: realmId || (existing && existing.realm_id) || null,
      expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
      refresh_expires_at: Date.now() + (tok.x_refresh_token_expires_in || 8640000) * 1000,
      connected_at: new Date().toISOString(),
    })
  );

  return htmlPage(
    "QuickBooks connected",
    "<p><strong>Done.</strong> This connector is now linked to company <code>" +
      escapeHtml(realmId || "(unknown realm)") +
      "</code>. You can close this tab.</p><p>If you haven't yet, add the connector in Claude: Settings → Connectors → Add custom connector, using your <code>/mcp/&lt;key&gt;</code> URL.</p>"
  );
}

async function tokenRequest(env, params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(env.INTUIT_CLIENT_ID + ":" + env.INTUIT_CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Intuit token request failed (" + res.status + "): " + text);
  return JSON.parse(text);
}

async function getAccessToken(env, forceRefresh = false) {
  if (!env.QBO_KV) throw new Error("KV namespace binding QBO_KV is missing in the Worker settings.");
  const t = await env.QBO_KV.get(TOKENS_KEY, "json");
  if (!t || !t.refresh_token) {
    throw new Error(
      "Not connected to QuickBooks yet. Open https://<your-worker-url>/auth/<CONNECTOR_KEY> in a browser and sign in to Intuit."
    );
  }
  if (!forceRefresh && Date.now() < (t.expires_at || 0) - 120000) return t;

  let fresh;
  try {
    fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  } catch (err) {
    throw new Error(
      "QuickBooks token refresh failed — you may need to reconnect via /auth/<CONNECTOR_KEY>. Details: " + errMessage(err)
    );
  }
  const updated = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || t.refresh_token,
    realm_id: t.realm_id,
    expires_at: Date.now() + (fresh.expires_in || 3600) * 1000,
    refresh_expires_at: fresh.x_refresh_token_expires_in
      ? Date.now() + fresh.x_refresh_token_expires_in * 1000
      : t.refresh_expires_at,
    connected_at: t.connected_at,
  };
  await env.QBO_KV.put(TOKENS_KEY, JSON.stringify(updated));
  return updated;
}

/* ------------------------------------------------------------------ */
/* QuickBooks API                                                      */
/* ------------------------------------------------------------------ */

function qboApiBase(env) {
  return String(env.QBO_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

async function qboFetch(env, buildPath) {
  let t = await getAccessToken(env);
  const doFetch = (tok) =>
    fetch(qboApiBase(env) + buildPath(tok.realm_id), {
      headers: { Authorization: "Bearer " + tok.access_token, Accept: "application/json" },
    });
  let res = await doFetch(t);
  if (res.status === 401) {
    t = await getAccessToken(env, true);
    res = await doFetch(t);
  }
  const text = await res.text();
  if (!res.ok) throw new Error("QuickBooks API error " + res.status + ": " + text);
  return text;
}

/* ------------------------------------------------------------------ */
/* MCP (Streamable HTTP, JSON-RPC 2.0)                                 */
/* ------------------------------------------------------------------ */

async function handleMcp(request, env) {
  if (request.method === "GET") {
    // No server-initiated stream; clients fall back to plain request/response.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && msg.id !== undefined && msg.id !== null) {
        responses.push({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Invalid request" } });
      }
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue; // notification — no response
    responses.push(await handleRpc(env, msg));
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return jsonResponse(Array.isArray(body) ? responses : responses[0], 200);
}

async function handleRpc(env, msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only access to QuickBooks Online. Use qbo_report for financial statements " +
          "(ProfitAndLoss, BalanceSheet, CashFlow, ...), qbo_query for entity lookups with a " +
          "SQL-like SELECT syntax, qbo_company_info for company details, and qbo_auth_status " +
          "to check the connection. Dates are YYYY-MM-DD.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (typeof name !== "string") return fail(-32602, "tools/call requires params.name");
      try {
        const text = await callTool(env, name, args);
        return reply({ content: [{ type: "text", text: truncate(text) }], isError: false });
      } catch (err) {
        if (err instanceof UnknownToolError) return fail(-32602, err.message);
        return reply({ content: [{ type: "text", text: errMessage(err) }], isError: true });
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, "Method not found: " + msg.method);
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "qbo_report",
    title: "Run a QuickBooks report",
    description:
      "Run a QuickBooks Online report and return its JSON. Common reports: ProfitAndLoss, " +
      "ProfitAndLossDetail, BalanceSheet, CashFlow, TrialBalance, GeneralLedger, TransactionList, " +
      "AgedReceivables, AgedPayables, CustomerIncome, VendorExpenses. Common params: start_date, " +
      "end_date (YYYY-MM-DD), date_macro (e.g. 'Last Month'), accounting_method (Cash|Accrual), " +
      "summarize_column_by (Month|Quarter|Year|Total).",
    inputSchema: {
      type: "object",
      properties: {
        report: { type: "string", description: "Report name, e.g. ProfitAndLoss" },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Report query parameters, e.g. {"start_date":"2026-01-01","end_date":"2026-06-30","accounting_method":"Accrual"}',
        },
      },
      required: ["report"],
    },
  },
  {
    name: "qbo_query",
    title: "Query QuickBooks entities",
    description:
      "Run a QuickBooks Online SQL-like query and return the JSON results. Example: " +
      "SELECT * FROM Invoice WHERE TxnDate >= '2026-01-01' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 100. " +
      "Queryable entities include Account, Bill, BillPayment, Customer, Deposit, Employee, Estimate, Invoice, " +
      "Item, JournalEntry, Payment, Purchase, SalesReceipt, Vendor. Use SELECT COUNT(*) FROM <Entity> for counts. " +
      "MAXRESULTS caps at 1000; page with STARTPOSITION.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The QuickBooks query statement" },
      },
      required: ["query"],
    },
  },
  {
    name: "qbo_company_info",
    title: "Get company info",
    description: "Return the connected QuickBooks company's profile (name, address, fiscal year start, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "qbo_auth_status",
    title: "Check connection status",
    description:
      "Report whether the connector is linked to QuickBooks: company realm ID, environment, and token expiry times. " +
      "Never returns token values.",
    inputSchema: { type: "object", properties: {} },
  },
];

class UnknownToolError extends Error {}

async function callTool(env, name, args) {
  switch (name) {
    case "qbo_query": {
      if (typeof args.query !== "string" || !args.query.trim()) throw new Error("'query' (string) is required.");
      const qs = new URLSearchParams({ query: args.query, minorversion: MINOR_VERSION });
      return qboFetch(env, (realm) => "/v3/company/" + encodeURIComponent(realm) + "/query?" + qs.toString());
    }
    case "qbo_report": {
      if (typeof args.report !== "string" || !args.report.trim()) throw new Error("'report' (string) is required.");
      const qs = new URLSearchParams({ minorversion: MINOR_VERSION });
      for (const [k, v] of Object.entries(args.params || {})) qs.set(k, String(v));
      return qboFetch(
        env,
        (realm) =>
          "/v3/company/" + encodeURIComponent(realm) + "/reports/" + encodeURIComponent(args.report.trim()) + "?" + qs.toString()
      );
    }
    case "qbo_company_info": {
      const qs = new URLSearchParams({ minorversion: MINOR_VERSION });
      return qboFetch(
        env,
        (realm) => "/v3/company/" + encodeURIComponent(realm) + "/companyinfo/" + encodeURIComponent(realm) + "?" + qs.toString()
      );
    }
    case "qbo_auth_status": {
      const t = env.QBO_KV ? await env.QBO_KV.get(TOKENS_KEY, "json") : null;
      return JSON.stringify(
        {
          connected: Boolean(t && t.refresh_token),
          environment: String(env.QBO_ENV || "production").toLowerCase(),
          realm_id: (t && t.realm_id) || null,
          connected_at: (t && t.connected_at) || null,
          access_token_expires: t && t.expires_at ? new Date(t.expires_at).toISOString() : null,
          refresh_token_expires: t && t.refresh_expires_at ? new Date(t.refresh_expires_at).toISOString() : null,
          note: t
            ? "Access tokens refresh automatically. If the refresh token has expired, re-run the /auth/<key> sign-in."
            : "Not connected. Open /auth/<CONNECTOR_KEY> on this Worker in a browser and sign in to Intuit.",
        },
        null,
        2
      );
    }
    default:
      throw new UnknownToolError("Unknown tool: " + name);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function truncate(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    "\n\n[Truncated: full response was " +
    text.length +
    " characters. Narrow the request (WHERE clause, MAXRESULTS, shorter date range, or summarize_column_by=Total) to see the rest.]"
  );
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function infoPage() {
  const suggestion = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  return htmlPage(
    "QuickBooks connector for Claude",
    "<p>This Worker is a private QuickBooks Online connector (remote MCP server).</p>" +
      "<ol>" +
      "<li>Set the <code>QBO_KV</code> binding and the <code>INTUIT_CLIENT_ID</code>, <code>INTUIT_CLIENT_SECRET</code>, and <code>CONNECTOR_KEY</code> secrets in the Worker settings.</li>" +
      "<li>Add <code>&lt;this URL&gt;/callback</code> as a redirect URI in your Intuit developer app.</li>" +
      "<li>Open <code>&lt;this URL&gt;/auth/&lt;CONNECTOR_KEY&gt;</code> and sign in to QuickBooks.</li>" +
      "<li>In Claude, add a custom connector with URL <code>&lt;this URL&gt;/mcp/&lt;CONNECTOR_KEY&gt;</code>.</li>" +
      "</ol>" +
      "<p>Need a value for <code>CONNECTOR_KEY</code>? Here's a freshly generated random one (not stored anywhere; reload for another):</p>" +
      "<p><code style='word-break:break-all'>" + suggestion + "</code></p>"
  );
}

async function handleStatus(env) {
  const problems = configProblems(env);
  const t = env.QBO_KV ? await env.QBO_KV.get(TOKENS_KEY, "json") : null;
  const rows = [
    ["Configuration", problems.length ? escapeHtml(problems.join(" ")) : "OK"],
    ["Environment", escapeHtml(String(env.QBO_ENV || "production"))],
    ["Connected to QuickBooks", t && t.refresh_token ? "Yes" : "No"],
    ["Company (realm ID)", escapeHtml((t && t.realm_id) || "—")],
    ["Connected at", escapeHtml((t && t.connected_at) || "—")],
    ["Access token expires", t && t.expires_at ? new Date(t.expires_at).toISOString() : "—"],
    ["Refresh token expires", t && t.refresh_expires_at ? new Date(t.refresh_expires_at).toISOString() : "—"],
  ];
  return htmlPage(
    "Connector status",
    "<table>" + rows.map(([k, v]) => "<tr><th>" + k + "</th><td>" + v + "</td></tr>").join("") + "</table>" +
      "<p>To (re)connect QuickBooks, open <code>/auth/&lt;CONNECTOR_KEY&gt;</code> on this Worker.</p>"
  );
}

function htmlPage(title, bodyHtml, status = 200) {
  const html =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<title>" + escapeHtml(title) + "</title>" +
    "<style>" +
    ":root{--ground:#FBFBFC;--surface:#FFF;--ink:#1B2330;--muted:#5B6573;--hairline:#E5E8EC;--accent:#26456B;}" +
    "@media (prefers-color-scheme: dark){:root{--ground:#14171D;--surface:#1B1F27;--ink:#EAEDF2;--muted:#98A2B3;--hairline:#2A2F39;--accent:#7FA6D9;}}" +
    "body{margin:0;background:var(--ground);color:var(--ink);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:clamp(2rem,6vw,5rem) 1.25rem;box-sizing:border-box;}" +
    ".card{width:100%;max-width:640px;background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:clamp(1.5rem,4vw,2.5rem);}" +
    "h1{font-family:Georgia,serif;font-weight:600;font-size:clamp(1.4rem,4vw,1.9rem);margin:0 0 .75rem;}" +
    "p,li{line-height:1.6;color:var(--muted);}p strong{color:var(--ink);}" +
    "code{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.85em;color:var(--accent);}" +
    "table{border-collapse:collapse;width:100%;}th,td{text-align:left;padding:.4rem .5rem;border-top:1px solid var(--hairline);" +
    "font-size:.9rem;color:var(--muted);}th{color:var(--ink);white-space:nowrap;}" +
    "</style></head><body><div class='card'><h1>" + escapeHtml(title) + "</h1>" + bodyHtml + "</div></body></html>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
