// Offline smoke test: verifies tool registration over real stdio MCP framing,
// and exercises the HTTP client's URL building and error mapping with a stubbed fetch.
// Run after `npm run build`: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}

// ---- 1. stdio server: initialize + tools/list ----
async function testServer() {
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "serve"], {
    env: { ...process.env, YCHARTS_API_KEY: "smoke-test-key" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    },
  });
  await waitFor(() => messages.some((m) => m.id === 1));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitFor(() => messages.some((m) => m.id === 2));
  child.kill();

  const initReply = messages.find((m) => m.id === 1);
  check("server initializes", initReply?.result?.serverInfo?.name === "ycharts-mcp");
  const tools = messages.find((m) => m.id === 2)?.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "ycharts_company_info",
    "ycharts_company_points",
    "ycharts_company_series",
    "ycharts_create_fixed_model_portfolio",
    "ycharts_diagnose",
    "ycharts_fund_data",
    "ycharts_fund_holdings",
    "ycharts_model_portfolio_holdings",
    "ycharts_model_portfolio_points",
    "ycharts_model_portfolio_series",
    "ycharts_model_portfolio_status",
    "ycharts_model_portfolios",
    "ycharts_request",
    "ycharts_screener",
    "ycharts_screeners_list",
    "ycharts_security_lists",
    "ycharts_status",
    "ycharts_update_fixed_model_portfolio",
  ];
  check(
    `all ${expected.length} tools registered`,
    JSON.stringify(names) === JSON.stringify(expected),
    `got ${names.length}: ${names.join(", ")}`,
  );
}

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for server reply"));
      }
    }, 25);
  });
}

// ---- 2. client with stubbed fetch ----
async function testClient() {
  const { YchartsClient, YchartsError } = await import("../dist/ycharts.js");
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path.includes("pe_ratio")) {
      return new Response(
        JSON.stringify({ meta: { status: "error", error_message: "Field 'pe_ratio' is not available." } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ meta: { status: "ok" }, response: { AAPL: { results: { price: { data: [["2026-09-15", 234.5]] } } } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new YchartsClient("fake-key");

  const points = await client.v3Points("companies", ["AAPL", "BRK.B"], ["price"], "2026-09-12");
  check("v3 points returns parsed JSON", points?.meta?.status === "ok");
  const url = new URL(calls[0].url);
  check(
    "v3 URL built correctly (encoding + date param)",
    url.pathname === "/v3/companies/AAPL,BRK.B/points/price" && url.searchParams.get("date") === "2026-09-12",
    url.toString(),
  );
  check("auth header attached", calls[0].init.headers["X-YCHARTSAUTHORIZATION"] === "fake-key");

  let entitlementError;
  try {
    await client.v3Points("companies", ["AAPL"], ["pe_ratio"]);
  } catch (err) {
    entitlementError = err;
  }
  check(
    "field-entitlement 400 mapped to a clear error",
    entitlementError instanceof YchartsError &&
      entitlementError.blockedField === "pe_ratio" &&
      entitlementError.message.includes("not licensed"),
    String(entitlementError?.message),
  );

  let pathError;
  try {
    await client.request("GET", "/etc/passwd");
  } catch (err) {
    pathError = err;
  }
  check("non-API paths refused", pathError instanceof YchartsError, String(pathError?.message));

  // retry on 500 then succeed
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt++;
    if (attempt === 1) return new Response("oops", { status: 500 });
    return new Response(JSON.stringify({ meta: { status: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const retried = await client.request("GET", "/v4/securitylists");
  check("retries once on 500 then succeeds", attempt === 2 && retried?.meta?.status === "ok");
}

await testServer();
await testClient();
console.log(failures === 0 ? "\nSmoke test: all checks passed." : `\nSmoke test: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
