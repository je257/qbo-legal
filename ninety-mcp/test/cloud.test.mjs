// Tests for the hosted (Cloudflare Worker) build. The Worker runs locally in Cloudflare's runtime;
// the "Ninety API" is a local fake. Nothing is deployed and no real token or account is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FAKE_TOKEN, startStubApi } from "./support/harness.mjs";
import {
  CLAUDE_REDIRECT,
  PASSWORD,
  callTool,
  exchangeCode,
  openSignIn,
  pkce,
  readSignInPage,
  refreshTokens,
  register,
  rpc,
  signIn,
  signInEarlierBuild,
  startWorker,
  submitSignIn,
} from "./support/cloud.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const DESKTOP_TOOLS = fixture("tools-v0.2.0.json").tools;
const OPTIONAL_TOOLS = [
  "ninety_todo_delete",
  "ninety_todo_unlink",
  "ninety_issue_delete",
  "ninety_rock_delete",
  "ninety_delete_score",
  "ninety_delete_note",
  "ninety_request",
];
const HEX_ID = "0123456789abcdef01234567";

describe("hosted connector: sign-in and the MCP endpoint", { timeout: 180_000 }, () => {
  let stub;
  let worker;
  let origin;
  let session; // one signed-in connection reused by the tests that only need a valid token

  before(async () => {
    stub = await startStubApi();
    worker = await startWorker({ vars: { NINETY_API_BASE_URL: stub.baseUrl } });
    origin = worker.origin;
  });
  after(async () => {
    await worker?.close();
    await stub?.close();
  });

  test("the status page shows what is set up and never the secrets", async () => {
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /NINETY_API_TOKEN<\/code>\): <span class="yes">saved/);
    assert.match(html, /CONNECTOR_PASSWORD<\/code>\): <span class="yes">saved/);
    assert.ok(html.includes(`${origin}/mcp`), "shows the address to give Claude");
    assert.ok(html.includes(`Ninety requests go to: <code>${stub.baseUrl}</code>`), "shows where Ninety requests are sent");
    assert.ok(!html.includes(PASSWORD) && !html.includes(FAKE_TOKEN), "no secret values in the page");
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("the MCP endpoint refuses a request with no token and says where to sign in", async () => {
    const response = await rpc(origin, undefined, "tools/list");
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate");
    assert.ok(challenge.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`));
    assert.ok(challenge.includes('scope="ninety"'));
    assert.equal(stub.take().length, 0, "nothing was sent to Ninety");
  });

  test("the MCP endpoint refuses a made-up token", async () => {
    const response = await rpc(origin, "owner:made-up:token", "tools/list");
    assert.equal(response.status, 401);
    assert.equal(stub.take().length, 0);
  });

  test("the discovery documents describe this server", async () => {
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [origin]);
    const server = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    assert.equal(server.issuer, origin);
    assert.equal(server.authorization_endpoint, `${origin}/authorize`);
    assert.equal(server.token_endpoint, `${origin}/oauth/token`);
    assert.equal(server.registration_endpoint, `${origin}/oauth/register`);
    assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  });

  test("an app that cannot receive the sign-in at Claude's address is not registered", async () => {
    const refused = await register(origin, ["https://evil.example/callback"]);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, "access_denied");
  });

  test("the full sign-in: wrong password is refused, right password connects, tools work", async () => {
    const registered = await register(origin);
    assert.equal(registered.status, 201);
    const clientId = registered.json.client_id;
    const { verifier, challenge } = pkce();

    const page = await openSignIn(origin, clientId, { challenge });
    assert.equal(page.status, 200);
    assert.ok(page.handle, "the page carries a one-time handle");
    assert.match(page.html, /<strong>Claude<\/strong> is asking to use this connector/);
    assert.match(page.html, /access is sent to <strong>claude\.ai<\/strong>/);
    assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai https:\/\/claude\.com/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");

    const wrong = await submitSignIn(origin, page, { decision: "approve", password: "not-the-password-at-all" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.location, null, "a wrong password is never redirected to the app");
    assert.match(wrong.html, /That password is not right/);
    assert.match(wrong.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai/);

    const empty = await submitSignIn(origin, page, { decision: "approve", password: "" });
    assert.equal(empty.status, 401);

    // The same page still works after a wrong attempt.
    const right = await submitSignIn(origin, page, { decision: "approve", password: `  ${PASSWORD}\n` });
    assert.equal(right.status, 302);
    const redirect = new URL(right.location);
    assert.equal(redirect.origin + redirect.pathname, CLAUDE_REDIRECT);
    assert.equal(redirect.searchParams.get("state"), "state-123");
    assert.equal(redirect.searchParams.get("iss"), origin);
    const code = redirect.searchParams.get("code");
    assert.ok(code);

    // The page cannot be used twice.
    const replayedPage = await submitSignIn(origin, page, { decision: "approve", password: PASSWORD });
    assert.equal(replayedPage.status, 400);
    assert.equal(replayedPage.location, null);
    assert.match(replayedPage.html, /expired/);

    // The code is useless without the matching PKCE secret.
    const badVerifier = await exchangeCode(origin, clientId, code, pkce().verifier);
    assert.equal(badVerifier.status, 400);

    // A code whose exchange failed stays dead (the library burns it), so sign in again for the rest.
    session = await signIn(origin, { clientId });
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken, "a refresh token is issued so Claude can stay connected");
    assert.equal(session.tokens.token_type.toLowerCase(), "bearer");
    assert.equal(session.tokens.scope, "ninety");
    assert.equal(session.tokens.expires_in, 3600);

    const init = await rpc(origin, session.accessToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, "ninety-mcp");
    assert.equal(init.json.result.protocolVersion, "2025-06-18");
    assert.match(init.json.result.instructions, /call ninety_teams once/);

    stub.take();
    const status = await callTool(origin, session.accessToken, "ninety_auth_status");
    assert.equal(status.isError, false);
    assert.match(status.text, /"connected":true/);
    assert.match(status.text, /Cloudflare Worker secret NINETY_API_TOKEN/);
    const [request] = stub.take();
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/teams");
    assert.equal(request.authorization, `Bearer ${FAKE_TOKEN}`, "Ninety is called with the Worker's token");
  });

  test("an authorization code works exactly once, and using it twice ends that connection", async () => {
    const { verifier, challenge } = pkce();
    const page = await openSignIn(origin, session.clientId, { challenge });
    const submitted = await submitSignIn(origin, page, { decision: "approve", password: PASSWORD });
    const code = new URL(submitted.location).searchParams.get("code");
    const first = await exchangeCode(origin, session.clientId, code, verifier);
    assert.equal(first.status, 200);
    assert.equal((await rpc(origin, first.json.access_token, "tools/list")).status, 200);
    const second = await exchangeCode(origin, session.clientId, code, verifier);
    assert.equal(second.status, 400);
    // A replayed code means it leaked, so the library withdraws the tokens that came from it.
    assert.equal((await rpc(origin, first.json.access_token, "tools/list")).status, 401);
    session = await signIn(origin, { clientId: session.clientId });
  });

  test("the hosted build offers 41 tools: everything except the deletes and the raw request", async () => {
    const response = await rpc(origin, session.accessToken, "tools/list");
    assert.equal(response.status, 200);
    const tools = response.json.result.tools;
    const expected = DESKTOP_TOOLS.filter((tool) => !OPTIONAL_TOOLS.includes(tool.name));
    assert.equal(tools.length, 41);
    assert.deepEqual(tools, expected, "same definitions and order as the desktop build, minus the seven");
  });

  test("a tool that is switched off cannot be called", async () => {
    stub.take();
    for (const name of ["ninety_todo_delete", "ninety_request"]) {
      const args = name === "ninety_request" ? { method: "DELETE", path: `/v1/todos/${HEX_ID}` } : { id: HEX_ID };
      const result = await callTool(origin, session.accessToken, name, args);
      assert.ok(result.isError || result.rpcError, `${name} is refused`);
    }
    assert.equal(stub.take().length, 0, "nothing was sent to Ninety");
  });

  test("completing a To-Do sends the same request the desktop build sends", async () => {
    stub.take();
    const result = await callTool(origin, session.accessToken, "ninety_todo_update", { id: HEX_ID, completed: true });
    assert.equal(result.isError, false);
    const [request] = stub.take();
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, `/v1/todos/${HEX_ID}`);
    assert.equal(request.body, JSON.stringify({ completed: true }));
  });

  test("clearing a score is refused while the delete tools are off; setting one still works", async () => {
    stub.take();
    const period = { kpiId: HEX_ID, periodStartDate: "2026-10-01" };
    for (const cleared of [{ value: null }, { note: null }, { goal: null }, { value: 5, note: null }, { goal: { value: null } }]) {
      const result = await callTool(origin, session.accessToken, "ninety_update_score", { ...period, ...cleared });
      assert.equal(result.isError, true, JSON.stringify(cleared));
      assert.match(result.text, /switched off on this connector/);
    }
    assert.equal(stub.take().length, 0, "nothing was sent to Ninety");
    const set = await callTool(origin, session.accessToken, "ninety_update_score", { ...period, value: 42, note: "on plan" });
    assert.equal(set.isError, false);
    const [request] = stub.take();
    assert.equal(`${request.method} ${request.url}`, `PATCH /v1/scorecard/kpis/${HEX_ID}/scores/2026-10-01`);
    assert.equal(request.body, JSON.stringify({ value: 42, note: "on plan" }));
  });

  test("a number too large to exist counts as clearing a score, because it would be sent as null", async () => {
    stub.take();
    // Written as text on purpose: JSON.stringify would already have turned the number into null.
    const send = (value) =>
      fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${session.accessToken}`,
        },
        body:
          '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ninety_update_score","arguments":' +
          `{"kpiId":"${HEX_ID}","periodStartDate":"2026-10-01","value":${value}}}}`,
      }).then((response) => response.json());
    for (const value of ["1e999", "-1e999"]) {
      const answer = await send(value);
      assert.equal(answer.result.isError, true, value);
      assert.match(answer.result.content[0].text, /switched off on this connector/);
    }
    assert.equal(stub.take().length, 0, "nothing was sent to Ninety");
    const real = await send("1e308");
    assert.equal(Boolean(real.result.isError), false, "the largest real numbers still go through");
    assert.equal(stub.take()[0].body, '{"value":1e+308}');
  });

  test("several messages in one request (a batch) are refused", async () => {
    const send = (count) =>
      fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify(Array.from({ length: count }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/list" }))),
      });
    stub.take();
    for (const count of [11, 2, 1, 0]) assert.equal((await send(count)).status, 400, `a batch of ${count}`);
    // A request and a cancellation of that same request, which a one-request server can never answer.
    const selfCancelling = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ninety_teams", arguments: {} } },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      ]),
    });
    assert.equal(selfCancelling.status, 400);
    assert.equal(stub.take().length, 0, "nothing was sent to Ninety");
    assert.equal((await rpc(origin, session.accessToken, "tools/list")).status, 200, "single messages still work");
  });

  test("only POST is accepted on the MCP endpoint", async () => {
    for (const httpMethod of ["GET", "DELETE"]) {
      const response = await rpc(origin, session.accessToken, "tools/list", undefined, { httpMethod });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    }
  });

  test("a refresh token gets a new access token, and the new one works", async () => {
    const refreshed = await refreshTokens(origin, session.clientId, session.refreshToken);
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json.access_token);
    assert.notEqual(refreshed.json.access_token, session.accessToken);
    const response = await rpc(origin, refreshed.json.access_token, "tools/list");
    assert.equal(response.status, 200);
    session = { ...session, accessToken: refreshed.json.access_token, refreshToken: refreshed.json.refresh_token };
  });

  test("choosing Cancel sends the app away with access_denied and no code", async () => {
    const page = await openSignIn(origin, session.clientId, { challenge: pkce().challenge });
    const denied = await submitSignIn(origin, page, { decision: "deny", password: PASSWORD });
    assert.equal(denied.status, 302);
    const redirect = new URL(denied.location);
    assert.equal(redirect.origin + redirect.pathname, CLAUDE_REDIRECT);
    assert.equal(redirect.searchParams.get("error"), "access_denied");
    assert.equal(redirect.searchParams.get("code"), null);
  });

  test("an app that lists another address next to Claude's is not registered", async () => {
    const sneaky = await register(origin, [CLAUDE_REDIRECT, "https://evil.example/callback"]);
    assert.equal(sneaky.status, 403);
    const loopback = await register(origin, [CLAUDE_REDIRECT, "http://localhost:31337/cb"]);
    assert.equal(loopback.status, 403);
  });

  test("only Claude's servers may register an app", async () => {
    const from = (address) => register(origin, [CLAUDE_REDIRECT], {}, { "CF-Connecting-IP": address });
    assert.equal((await from("203.0.113.9")).status, 403, "an address outside Anthropic's ranges");
    assert.equal((await from("2001:db8::1")).status, 403, "an IPv6 address");
    assert.equal((await from("160.79.103.255")).status, 403, "just below the first range");
    assert.equal((await from("160.79.112.0")).status, 403, "just above the first range");
    assert.equal((await from("160.79.104.10")).status, 201, "inside the first range");
    assert.equal((await from("153.61.223.255")).status, 201, "the last address of the second range");
  });

  test("an oversized registration is refused", async () => {
    const padded = await register(origin, [CLAUDE_REDIRECT], { client_name: "x".repeat(5000) });
    assert.ok([400, 403, 413].includes(padded.status), `status ${padded.status}`);
    const many = await register(origin, Array(5).fill(CLAUDE_REDIRECT));
    assert.equal(many.status, 403);
  });

  test("a sign-in request for an unknown app is shown as an error, not redirected", async () => {
    const page = await openSignIn(origin, "no-such-client", { challenge: pkce().challenge });
    assert.equal(page.status, 400);
    assert.equal(page.location, null);
    assert.equal(page.handle, undefined);
  });

  test("the sign-in form cannot be posted without the browser that opened the page", async () => {
    const page = await openSignIn(origin, session.clientId, { challenge: pkce().challenge });
    const stolen = await submitSignIn(origin, { ...page, cookie: "" }, { decision: "approve", password: PASSWORD });
    assert.equal(stolen.status, 400);
    assert.equal(stolen.location, null);
  });

  test("a standard MCP client can discover the server, register, sign in and list tools", async () => {
    const saved = {};
    let authorizationUrl;
    const authProvider = {
      get redirectUrl() {
        return CLAUDE_REDIRECT;
      },
      get clientMetadata() {
        return {
          client_name: "Standard MCP client",
          redirect_uris: [CLAUDE_REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      clientInformation: () => saved.client,
      saveClientInformation: (client) => void (saved.client = client),
      tokens: () => saved.tokens,
      saveTokens: (tokens) => void (saved.tokens = tokens),
      redirectToAuthorization: (url) => void (authorizationUrl = url),
      saveCodeVerifier: (verifier) => void (saved.verifier = verifier),
      codeVerifier: () => saved.verifier,
    };
    const endpoint = new URL(`${origin}/mcp`);

    const first = new StreamableHTTPClientTransport(endpoint, { authProvider });
    await assert.rejects(new Client({ name: "sdk", version: "0" }).connect(first), UnauthorizedError);
    assert.ok(authorizationUrl, "the client was sent to the sign-in page");
    assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${origin}/authorize`);

    const page = await readSignInPage(await fetch(authorizationUrl, { redirect: "manual" }));
    assert.equal(page.status, 200);
    const submitted = await submitSignIn(origin, page, { decision: "approve", password: PASSWORD });
    assert.equal(submitted.status, 302);
    await first.finishAuth(new URL(submitted.location).searchParams.get("code"));

    const client = new Client({ name: "sdk", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }));
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 41);
      stub.take();
      const result = await client.callTool({ name: "ninety_teams", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(stub.take()[0].url, "/v1/teams");
    } finally {
      await client.close();
    }
  });

  test("ticking 'sign out every other connection' ends the earlier connections", async () => {
    const before = await rpc(origin, session.accessToken, "tools/list");
    assert.equal(before.status, 200);
    const other = await register(origin);
    const fresh = await signIn(origin, { clientId: other.json.client_id, signOutOthers: true });
    const old = await rpc(origin, session.accessToken, "tools/list");
    assert.equal(old.status, 401, "the earlier connection is signed out");
    const oldRefresh = await refreshTokens(origin, session.clientId, session.refreshToken);
    assert.notEqual(oldRefresh.status, 200, "and it cannot renew itself");
    const current = await rpc(origin, fresh.accessToken, "tools/list");
    assert.equal(current.status, 200, "the new connection works");
    session = fresh;
  });

  describe("how the hosted build treats a slow or failing Ninety API", () => {
    const quick = async (action) => {
      const startedAt = Date.now();
      const result = await action();
      return { result, ms: Date.now() - startedAt };
    };
    after(() => {
      stub.respond = undefined;
    });

    test("a long rate-limit pause is reported at once instead of waited out", async () => {
      stub.take();
      stub.respond = () => ({ status: 429, headers: { "Retry-After": "30" }, body: '{"message":"Too Many Requests"}' });
      const { result, ms } = await quick(() => callTool(origin, session.accessToken, "ninety_teams"));
      assert.equal(result.isError, true);
      assert.match(result.text, /wait 30 seconds/);
      assert.equal(stub.take().length, 1, "one request, no retries");
      assert.ok(ms < 5000, `answered in ${ms} ms`);
    });

    test("a short rate-limit pause is waited out and the call succeeds", async () => {
      stub.take();
      stub.respond = (_request, count) =>
        count === 1 ? { status: 429, headers: { "Retry-After": "1" }, body: "{}" } : { status: 200, body: '[{"name":"Team One"}]' };
      stub.requests.length = 0;
      const result = await callTool(origin, session.accessToken, "ninety_teams");
      assert.equal(result.isError, false);
      assert.match(result.text, /Team One/);
      assert.equal(stub.take().length, 2);
    });

    test("a failed create is not re-sent, because the first attempt may have gone through", async () => {
      stub.take();
      stub.respond = () => ({ status: 500, body: '{"message":"Internal error"}' });
      const result = await callTool(origin, session.accessToken, "ninety_todo_create", { title: "Call the bank" });
      assert.equal(result.isError, true);
      assert.match(result.text, /not retried automatically/);
      assert.match(result.text, /Internal error"\}\nThis request creates something new/, "the note starts on its own line");
      assert.equal(stub.take().length, 1, "exactly one POST");
    });

    test("a rate-limited create is re-sent, because Ninety refused it before doing anything", async () => {
      stub.take();
      stub.requests.length = 0;
      stub.respond = (_request, count) =>
        count === 1 ? { status: 429, headers: { "Retry-After": "1" }, body: "{}" } : { status: 200, body: '{"_id":"abc"}' };
      const result = await callTool(origin, session.accessToken, "ninety_todo_create", { title: "Call the bank" });
      assert.equal(result.isError, false);
      assert.equal(stub.take().length, 2);
    });

    test("a failing read is tried three times, then reported", async () => {
      stub.take();
      stub.respond = () => ({ status: 503, body: '{"message":"Service Unavailable"}' });
      const { result, ms } = await quick(() => callTool(origin, session.accessToken, "ninety_teams"));
      assert.equal(result.isError, true);
      assert.match(result.text, /failed \(503\)/);
      assert.equal(stub.take().length, 3);
      assert.ok(ms < 15_000, `answered in ${ms} ms`);
    });

    test("an expired Ninety token is explained with the Cloudflare fix, not the desktop one", async () => {
      stub.take();
      stub.respond = () => ({ status: 401, body: '{"message":"Unauthorized"}' });
      const result = await callTool(origin, session.accessToken, "ninety_teams");
      assert.equal(result.isError, true);
      assert.match(result.text, /replace the NINETY_API_TOKEN secret/);
      assert.doesNotMatch(result.text, /node dist\/index\.js/);
      assert.equal(stub.take().length, 1, "a 401 is not retried");
    });

    test("an oversized response is cut to the limit with a clear notice", async () => {
      const big = Array.from({ length: 4000 }, (_, i) => ({ _id: `id-${i}`, title: "x".repeat(80) }));
      stub.respond = () => ({ status: 200, body: JSON.stringify(big) });
      const result = await callTool(origin, session.accessToken, "ninety_teams");
      assert.equal(result.isError, false);
      assert.ok(result.text.startsWith("[TRUNCATED"), "starts with the truncation notice");
      assert.ok(result.text.length <= 100_000, `${result.text.length} characters`);
      stub.take();
    });

    test("an error that quotes a huge response is cut to the same limit", async () => {
      // Two paddings shift where the cut falls, so one of them lands inside a two-part character.
      for (const pad of ["", "p"]) {
        stub.take();
        stub.respond = () => ({ status: 400, body: JSON.stringify({ message: pad + "\u{1F600}".repeat(150_000) }) });
        const result = await callTool(origin, session.accessToken, "ninety_teams");
        assert.equal(result.isError, true);
        assert.match(result.text, /failed \(400\)/);
        assert.match(result.text, /\n\[The error text was \d+ characters; only the first part is shown\.\]$/);
        assert.ok(result.text.length <= 100_000, `${result.text.length} characters`);
        assert.ok(result.text.isWellFormed(), "the text is valid");
        assert.equal(stub.take().length, 1, "a refusal is not retried");
      }
    });

    test("a cut-off response never ends on half a character", async () => {
      // Five paddings shift where the cut falls, so at least one lands inside a two-part character.
      for (let pad = 1; pad <= 5; pad++) {
        const body = JSON.stringify({ pad: "p".repeat(pad), items: Array.from({ length: 30_000 }, () => "\u{1F600}") });
        stub.respond = () => ({ status: 200, body });
        const result = await callTool(origin, session.accessToken, "ninety_teams");
        assert.ok(result.text.startsWith("[TRUNCATED"));
        assert.ok(result.text.length <= 100_000);
        assert.ok(result.text.isWellFormed(), `padding ${pad}: the text is valid`);
      }
      stub.take();
    });

    test("answers cut off part-way: a create is not re-sent, a refusal stays a refusal, a read is retried", { timeout: 90_000 }, async () => {
      // The fake API sends the status and half the body, then drops the connection. The three cases
      // run together because each one waits out the 20-second limit on a single request.
      stub.take();
      const teams = JSON.stringify([{ name: "Team One" }, { name: "Team Two" }]);
      let teamReads = 0;
      stub.respond = (request) => {
        if (request.method === "POST" && request.url === "/v1/todos") {
          return { status: 200, dropMidBody: true, body: JSON.stringify({ _id: "abc", title: "Call the bank" }) };
        }
        if (request.method === "POST" && request.url === "/v1/issues") {
          return { status: 404, dropMidBody: true, body: JSON.stringify({ message: "Team not found" }) };
        }
        teamReads++;
        return { status: 200, body: teams, dropMidBody: teamReads === 1 };
      };
      const [created, refused, read] = await Promise.all([
        callTool(origin, session.accessToken, "ninety_todo_create", { title: "Call the bank" }),
        callTool(origin, session.accessToken, "ninety_issue_create", { title: "Late invoices", teamId: HEX_ID }),
        callTool(origin, session.accessToken, "ninety_teams"),
      ]);
      const requests = stub.take();
      const sent = (method, url) => requests.filter((request) => request.method === method && request.url === url).length;

      assert.equal(created.isError, true);
      assert.match(created.text, /\nNinety received this request and may well have carried it out/);
      assert.equal(sent("POST", "/v1/todos"), 1, "the create was sent exactly once");

      assert.equal(refused.isError, true);
      assert.match(refused.text, /failed \(404\)/);
      assert.doesNotMatch(refused.text, /may well have carried it out/);
      assert.equal(sent("POST", "/v1/issues"), 1, "a refusal is final");

      assert.equal(read.isError, false);
      assert.match(read.text, /Team One/);
      assert.equal(sent("GET", "/v1/teams"), 2, "the read was tried again");
    });

    test("a response that only fits without indentation is returned whole", async () => {
      const medium = Array.from({ length: 1000 }, (_, i) => ({ _id: `id-${i}`, title: "y".repeat(60) }));
      assert.ok(JSON.stringify(medium, null, 2).length > 100_000 && JSON.stringify(medium).length < 100_000);
      stub.respond = () => ({ status: 200, body: JSON.stringify(medium) });
      const result = await callTool(origin, session.accessToken, "ninety_teams");
      assert.deepEqual(JSON.parse(result.text), medium);
      stub.take();
    });
  });

  test("the one-time set-up work ran while the Worker started, not on a request", async () => {
    const logs = JSON.stringify(worker.server.getLogs());
    assert.ok(logs.includes('\\"event\\":\\"warmup\\",\\"tools\\":41') || logs.includes('"event":"warmup","tools":41'), "the first server was built, with its 41 tools, at start-up");
    assert.ok(!logs.includes("warmup_failed"));
  });

  describe("servers are reused between requests without mixing them up", () => {
    after(() => {
      stub.respond = undefined;
    });

    test("twelve calls at the same moment each get their own answer", async () => {
      // The fake API answers slowly and echoes the address it was asked for, so the calls overlap
      // and a mixed-up answer would show.
      stub.respond = (request) => ({ status: 200, delayMs: 250, body: JSON.stringify({ echo: request.url }) });
      const ids = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, "0")}aaaaaaaaaaaaaaaaaaaaaa`);
      const results = await Promise.all(ids.map((id) => callTool(origin, session.accessToken, "ninety_user_get", { id })));
      results.forEach((result, i) => {
        assert.equal(result.isError, false, `call ${i} succeeded`);
        assert.deepEqual(JSON.parse(result.text), { echo: `/v1/users/${ids[i]}` }, `call ${i} got its own answer`);
      });
      stub.take();
    });

    test("thirty calls one after another all work, and the tool list never changes", async () => {
      stub.respond = undefined;
      const first = await rpc(origin, session.accessToken, "tools/list");
      for (let i = 0; i < 30; i++) {
        const result = await callTool(origin, session.accessToken, "ninety_teams");
        assert.equal(result.isError, false, `call ${i}`);
      }
      const again = await rpc(origin, session.accessToken, "tools/list");
      assert.equal(again.status, 200);
      assert.deepEqual(again.json.result, first.json.result);
      assert.equal(again.json.result.tools.length, 41);
      stub.take();
    });

    test("a request cut off part-way does not break the ones after it", async () => {
      stub.respond = () => ({ status: 200, delayMs: 1500, body: "[]" });
      for (let i = 0; i < 8; i++) {
        const cut = new AbortController();
        const pending = fetch(`${origin}/mcp`, {
          method: "POST",
          signal: cut.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "ninety_teams", arguments: {} } }),
        }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        cut.abort();
        await pending;
      }
      stub.respond = () => ({ status: 200, body: '[{"name":"Team One"}]' });
      for (let i = 0; i < 10; i++) {
        const result = await callTool(origin, session.accessToken, "ninety_teams");
        assert.equal(result.isError, false, `call ${i} after the cut-off requests`);
        assert.match(result.text, /Team One/);
      }
      stub.take();
    });

    test("a JSON-RPC id of any kind comes back unchanged on a tool list served from memory", async () => {
      for (const id of [7, "abc-123", 0]) {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
        });
        const json = await response.json();
        assert.equal(json.id, id);
        assert.equal(json.result.tools.length, 41);
      }
    });
  });

  test("the Worker's logs name tools and outcomes but hold no secrets or tokens", async () => {
    const logs = JSON.stringify(worker.server.getLogs());
    assert.ok(logs.includes("tools/call:ninety_teams"), "tool calls are logged by name");
    assert.ok(logs.includes('\\"event\\":\\"sign_in\\"') || logs.includes('"event":"sign_in"'), "sign-ins are logged");
    for (const secret of [PASSWORD, FAKE_TOKEN, session.accessToken, session.refreshToken]) {
      assert.ok(!logs.includes(secret), "no secret appears in the logs");
    }
  });
});

describe("hosted connector: optional tools switched on", { timeout: 120_000 }, () => {
  test("with both switches on, the hosted build offers exactly the desktop build's 48 tools", async () => {
    const stub = await startStubApi();
    const worker = await startWorker({
      vars: { NINETY_API_BASE_URL: stub.baseUrl, ENABLE_DELETE_TOOLS: "true", ENABLE_RAW_REQUEST: "true" },
    });
    try {
      const session = await signIn(worker.origin);
      const response = await rpc(worker.origin, session.accessToken, "tools/list");
      assert.deepEqual(response.json.result.tools, DESKTOP_TOOLS);
      const result = await callTool(worker.origin, session.accessToken, "ninety_todo_delete", { id: HEX_ID });
      assert.equal(result.isError, false);
      const [request] = stub.take();
      assert.equal(`${request.method} ${request.url}`, `DELETE /v1/todos/${HEX_ID}`);
      // With the delete tools on, clearing a score is allowed again.
      const cleared = await callTool(worker.origin, session.accessToken, "ninety_update_score", {
        kpiId: HEX_ID,
        periodStartDate: "2026-10-01",
        value: null,
      });
      assert.equal(cleared.isError, false);
      assert.equal(stub.take()[0].body, JSON.stringify({ value: null }));
    } finally {
      await worker.close();
      await stub.close();
    }
  });

  test("a delete is reported as what happened, not as what a second try found", { timeout: 90_000 }, async () => {
    const stub = await startStubApi();
    const worker = await startWorker({ vars: { NINETY_API_BASE_URL: stub.baseUrl, ENABLE_DELETE_TOOLS: "true" } });
    try {
      const session = await signIn(worker.origin);
      // Ninety answers "done" and the connection drops before the rest arrives. The delete is
      // reported as done and is not sent again, because a second try could only say "not found".
      stub.respond = () => ({ status: 200, dropMidBody: true, body: JSON.stringify({ deleted: true, pad: "x".repeat(200) }) });
      const lost = await callTool(worker.origin, session.accessToken, "ninety_todo_delete", { id: HEX_ID });
      assert.equal(lost.isError, false);
      assert.equal(lost.text, '{"ok":true,"status":200}');
      assert.equal(stub.take().length, 1, "the delete was sent exactly once");

      // A first try fails with no clear answer and the second says "not found": the error says
      // that the first try may have done the deleting.
      stub.respond = (_request, count) =>
        count === 1 ? { status: 503, body: "{}" } : { status: 404, body: '{"message":"Not found"}' };
      const gone = await callTool(worker.origin, session.accessToken, "ninety_todo_delete", { id: HEX_ID });
      assert.equal(gone.isError, true);
      assert.match(gone.text, /failed \(404\): Not found\nAn earlier attempt at this delete/);
      assert.equal(stub.take().length, 2);

      // A plain "not found" on the first try carries no such note.
      stub.respond = () => ({ status: 404, body: '{"message":"Not found"}' });
      const never = await callTool(worker.origin, session.accessToken, "ninety_todo_delete", { id: HEX_ID });
      assert.equal(never.isError, true);
      assert.doesNotMatch(never.text, /earlier attempt/);
    } finally {
      await worker.close();
      await stub.close();
    }
  });
});

describe("hosted connector: unfinished setup fails closed", { timeout: 120_000 }, () => {
  test("with no usable password nobody can sign in, and the status page says why", async () => {
    const worker = await startWorker({ secrets: { CONNECTOR_PASSWORD: "too-short" } });
    try {
      const html = await (await fetch(`${worker.origin}/`)).text();
      assert.match(html, /too short, needs at least 16 characters/);
      assert.match(html, /not finished setting up/);
      const client = await register(worker.origin);
      const page = await openSignIn(worker.origin, client.json.client_id, { challenge: pkce().challenge });
      assert.equal(page.status, 503);
      assert.equal(page.handle, undefined);
      // Even a forged form post with the short password is refused.
      const forged = await submitSignIn(worker.origin, { handle: "anything", cookie: "" }, { decision: "approve", password: "too-short" });
      assert.equal(forged.status, 503);
      assert.equal(forged.location, null);
    } finally {
      await worker.close();
    }
  });

  test("with no password at all, an empty password does not sign in", async () => {
    const worker = await startWorker({ secrets: { CONNECTOR_PASSWORD: null } });
    try {
      const forged = await submitSignIn(worker.origin, { handle: "anything", cookie: "" }, { decision: "approve", password: "" });
      assert.equal(forged.status, 503);
    } finally {
      await worker.close();
    }
  });

  test("with no Ninety token the tools explain what to add instead of failing obscurely", async () => {
    const stub = await startStubApi();
    const worker = await startWorker({ vars: { NINETY_API_BASE_URL: stub.baseUrl }, secrets: { NINETY_API_TOKEN: null } });
    try {
      const session = await signIn(worker.origin);
      const status = await callTool(worker.origin, session.accessToken, "ninety_auth_status");
      assert.match(status.text, /"connected":false/);
      assert.match(status.text, /secret named NINETY_API_TOKEN/);
      const teams = await callTool(worker.origin, session.accessToken, "ninety_teams");
      assert.equal(teams.isError, true);
      assert.match(teams.text, /no Ninety token yet/);
      assert.equal(stub.take().length, 0);
    } finally {
      await worker.close();
      await stub.close();
    }
  });

  test("while the password is unusable a renewal is put off, not ended: the connection is still there afterwards", async () => {
    const worker = await startWorker();
    try {
      const session = await signIn(worker.origin);
      await worker.changeSecrets({ CONNECTOR_PASSWORD: "too-short" });
      assert.equal((await rpc(worker.origin, session.accessToken, "tools/list")).status, 401, "nothing works meanwhile");
      const during = await refreshTokens(worker.origin, session.clientId, session.refreshToken);
      assert.equal(during.status, 503);
      assert.equal(during.json.error, "temporarily_unavailable");

      // The same password is saved again: the connection was kept, and it renews.
      await worker.changeSecrets({});
      assert.equal((await rpc(worker.origin, session.accessToken, "tools/list")).status, 200);
      const renewed = await refreshTokens(worker.origin, session.clientId, session.refreshToken);
      assert.equal(renewed.status, 200);
      assert.equal((await rpc(worker.origin, renewed.json.access_token, "tools/list")).status, 200);
    } finally {
      await worker.close();
    }
  });

  test("a registration range with its size left off lets nobody register, not everybody", async () => {
    const worker = await startWorker({ vars: { REGISTRATION_SOURCES: "160.79.104.0/, 153.61.208.0/20" } });
    try {
      const from = (address) => register(worker.origin, [CLAUDE_REDIRECT], {}, { "CF-Connecting-IP": address });
      assert.equal((await from("203.0.113.9")).status, 403, "an outside address");
      assert.equal((await from("160.79.104.10")).status, 403, "an address inside the mistyped range");
      assert.equal((await from("153.61.208.1")).status, 201, "the range that is written properly still works");
    } finally {
      await worker.close();
    }
  });

  test("an API address that is not a local test fake is ignored", async () => {
    // No tool is called, so nothing is sent anywhere: the status page reports the address in use.
    const worker = await startWorker({ vars: { NINETY_API_BASE_URL: "https://attacker.example" } });
    try {
      const html = await (await fetch(`${worker.origin}/`)).text();
      assert.ok(html.includes("Ninety requests go to: <code>https://api.public.ninety.io</code>"));
      assert.ok(!html.includes("attacker.example"));
    } finally {
      await worker.close();
    }
  });
});

describe("hosted connector: changing the connector password ends every connection", { timeout: 180_000 }, () => {
  test("a restart keeps connections; a new password ends them and their renewal", async () => {
    const stub = await startStubApi();
    const worker = await startWorker({ vars: { NINETY_API_BASE_URL: stub.baseUrl } });
    try {
      const first = await signIn(worker.origin);
      assert.equal((await rpc(worker.origin, first.accessToken, "tools/list")).status, 200);

      // Control: the Worker restarts with nothing changed, and the connection is still there.
      await worker.changeSecrets({});
      assert.equal((await rpc(worker.origin, first.accessToken, "tools/list")).status, 200, "storage survives a restart");

      const NEW_PASSWORD = "a-different-password-9876543210";
      await worker.changeSecrets({ CONNECTOR_PASSWORD: NEW_PASSWORD });
      const ended = await rpc(worker.origin, first.accessToken, "tools/list");
      assert.equal(ended.status, 401, "the old connection is refused");
      assert.match(ended.headers.get("www-authenticate"), /invalid_token/);
      const renewal = await refreshTokens(worker.origin, first.clientId, first.refreshToken);
      assert.equal(renewal.status, 400, "and it cannot renew itself");
      assert.equal(renewal.json.error, "invalid_grant");
      assert.equal(stub.take().length, 0, "nothing reached Ninety");

      // The old password no longer signs in; the new one does, and that connection works.
      const page = await openSignIn(worker.origin, first.clientId, { challenge: pkce().challenge });
      const old = await submitSignIn(worker.origin, page, { decision: "approve", password: PASSWORD });
      assert.equal(old.status, 401);
      const fresh = await signIn(worker.origin, { clientId: first.clientId, password: NEW_PASSWORD });
      assert.equal((await rpc(worker.origin, fresh.accessToken, "tools/list")).status, 200);
      const renewed = await refreshTokens(worker.origin, fresh.clientId, fresh.refreshToken);
      assert.equal(renewed.status, 200, "a connection made with the current password renews normally");
    } finally {
      await worker.close();
      await stub.close();
    }
  });

  test("a connection that carries no password fingerprint is refused, and is not quietly given one", async () => {
    const stub = await startStubApi();
    const worker = await startWorker({ vars: { NINETY_API_BASE_URL: stub.baseUrl } });
    try {
      const client = await register(worker.origin);
      // A connection as an earlier build stored it: made without the fingerprint.
      await worker.useEarlierBuild();
      const earlier = await signInEarlierBuild(worker.origin, client.json.client_id);
      const there = await fetch(`${worker.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${earlier.accessToken}` } });
      assert.equal(there.status, 200, "the earlier build accepts the connection it made");
      await worker.changeSecrets({}); // the real Worker again, on the same storage

      const refused = await rpc(worker.origin, earlier.accessToken, "tools/list");
      assert.equal(refused.status, 401);
      assert.match(refused.json.error.message, /This connection has ended/, "stopped by the fingerprint check, not as an unknown token");
      const renewal = await refreshTokens(worker.origin, earlier.clientId, earlier.refreshToken);
      assert.equal(renewal.status, 400);
      assert.equal(renewal.json.error, "invalid_grant");
      assert.match(renewal.json.error_description, /This connection has ended/);
      // That refusal removed it for good.
      const again = await refreshTokens(worker.origin, earlier.clientId, earlier.refreshToken);
      assert.equal(again.status, 400);
      assert.equal((await rpc(worker.origin, earlier.accessToken, "tools/list")).status, 401);
      assert.equal(stub.take().length, 0, "nothing reached Ninety");

      // Signing in with the password still works, and that connection renews.
      const fresh = await signIn(worker.origin, { clientId: client.json.client_id });
      assert.equal((await rpc(worker.origin, fresh.accessToken, "tools/list")).status, 200);
      assert.equal((await refreshTokens(worker.origin, fresh.clientId, fresh.refreshToken)).status, 200);
    } finally {
      await worker.close();
      await stub.close();
    }
  });
});

describe("hosted connector: sign-in page details", { timeout: 120_000 }, () => {
  test("the 'sign out every other connection' tick survives a mistyped password", async () => {
    const worker = await startWorker();
    try {
      const client = await register(worker.origin);
      const page = await openSignIn(worker.origin, client.json.client_id, { challenge: pkce().challenge });
      assert.ok(!/name="signOutOthers" value="1" checked/.test(page.html), "unticked to begin with");
      const wrong = await submitSignIn(worker.origin, page, {
        decision: "approve",
        password: "not-the-password-at-all",
        signOutOthers: "1",
      });
      assert.equal(wrong.status, 401);
      assert.match(wrong.html, /name="signOutOthers" value="1" checked/);
      // The same page then signs in with the right password and the tick still set.
      const right = await submitSignIn(worker.origin, page, { decision: "approve", password: PASSWORD, signOutOthers: "1" });
      assert.equal(right.status, 302);
    } finally {
      await worker.close();
    }
  });
});

describe("hosted connector: one address only", { timeout: 120_000 }, () => {
  test("a visit under another address first does not break sign-in under the real one", async () => {
    const worker = await startWorker();
    try {
      const other = worker.origin.includes("127.0.0.1")
        ? worker.origin.replace("127.0.0.1", "localhost")
        : worker.origin.replace("localhost", "127.0.0.1");
      const visit = await fetch(`${other}/`).catch(() => undefined);
      assert.ok(visit, "the Worker answers under its other local name");
      const session = await signIn(worker.origin);
      assert.equal((await rpc(worker.origin, session.accessToken, "tools/list")).status, 200);
      // A token belongs to the address it was issued under.
      const crossed = await rpc(other, session.accessToken, "tools/list");
      assert.equal(crossed.status, 401);
    } finally {
      await worker.close();
    }
  });
});

describe("hosted connector: password guessing is rate limited", { timeout: 120_000 }, () => {
  test("after ten attempts in a minute, further attempts are refused, even with the right password", async () => {
    const worker = await startWorker();
    try {
      const client = await register(worker.origin);
      const page = await openSignIn(worker.origin, client.json.client_id, { challenge: pkce().challenge });
      // The local limiter counts per clock minute, so do not start just before one ends.
      const leftInMinute = 60_000 - (Date.now() % 60_000);
      if (leftInMinute < 5_000) await new Promise((resolve) => setTimeout(resolve, leftInMinute + 250));
      const statuses = [];
      for (let attempt = 1; attempt <= 12; attempt++) {
        const wrong = await submitSignIn(worker.origin, page, { decision: "approve", password: `guess-number-${attempt}-xxxxxxxx` });
        statuses.push(wrong.status);
      }
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401), "the first ten are answered");
      assert.deepEqual(statuses.slice(10), [429, 429], "the rest are refused");
      const right = await submitSignIn(worker.origin, page, { decision: "approve", password: PASSWORD });
      assert.equal(right.status, 429, "the right password is refused too while the limit applies");
      assert.equal(right.location, null);
    } finally {
      await worker.close();
    }
  });
});
