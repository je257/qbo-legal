// Helpers for testing the hosted build. The Worker runs locally in Cloudflare's own runtime
// (workerd, through wrangler's test harness): no Cloudflare account, nothing deployed, and the
// "Ninety API" it talks to is the local fake from harness.mjs.
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { FAKE_TOKEN } from "./harness.mjs";

export const PASSWORD = "correct-horse-battery-staple-42";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Boots the Worker. `secrets: null` leaves a secret out; by default both are set. The optional
 * tools are off unless a test switches them on, whatever wrangler.jsonc says for the deployment.
 */
export async function startWorker({ vars: testVars = {}, secrets = {} } = {}) {
  const vars = { ENABLE_DELETE_TOOLS: "false", ENABLE_RAW_REQUEST: "false", ...testVars };
  const allSecrets = { NINETY_API_TOKEN: FAKE_TOKEN, CONNECTOR_PASSWORD: PASSWORD, ...secrets };
  for (const [name, value] of Object.entries(allSecrets)) if (value === null) delete allSecrets[name];
  const server = createTestHarness({
    root: ROOT,
    workers: [{ configPath: "./wrangler.jsonc", vars, secrets: allSecrets }],
  });
  const { url } = await server.listen();
  return {
    server,
    origin: url.origin,
    close: () => server.close(),
    /** Reloads the Worker with some secrets changed, keeping what it has stored. */
    async changeSecrets(changes) {
      await server.update({
        root: ROOT,
        workers: [{ configPath: "./wrangler.jsonc", vars, secrets: { ...allSecrets, ...changes } }],
      });
    },
    /**
     * Swaps in the stand-in for the build from before a connection carried a password fingerprint
     * (test/support/earlier-build), on the same storage. changeSecrets({}) puts the real Worker back.
     */
    async useEarlierBuild() {
      await server.update({ root: ROOT, workers: [{ configPath: "./test/support/earlier-build/wrangler.jsonc" }] });
    },
  };
}

const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decodeEntities = (text) => text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Dynamic client registration, the way an MCP client introduces itself. */
export async function register(origin, redirectUris = [CLAUDE_REDIRECT], extra = {}, headers = {}) {
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** Opens the sign-in page for an authorization request. */
export async function openSignIn(origin, clientId, options = {}) {
  const { redirectUri = CLAUDE_REDIRECT, state = "state-123", challenge, scope = "ninety" } = options;
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    resource: `${origin}/mcp`,
  }).toString();
  return readSignInPage(await fetch(url, { redirect: "manual" }));
}

export async function readSignInPage(response) {
  const html = await response.text();
  const handle = /name="handle" value="([^"]*)"/.exec(html)?.[1];
  return {
    status: response.status,
    html,
    handle: handle === undefined ? undefined : decodeEntities(handle),
    cookie: cookieHeader(response),
    headers: response.headers,
    location: response.headers.get("location"),
  };
}

/** Posts the sign-in form the way a browser would: the hidden fields, the cookie, and what was typed. */
export async function submitSignIn(origin, page, fields) {
  const response = await fetch(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: page.cookie },
    body: new URLSearchParams({ handle: page.handle ?? "", client: "Claude", host: "claude.ai", loopback: "", ...fields }),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
    headers: response.headers,
  };
}

async function tokenRequest(origin, form) {
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export function exchangeCode(origin, clientId, code, verifier, redirectUri = CLAUDE_REDIRECT) {
  return tokenRequest(origin, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: `${origin}/mcp`,
  });
}

export function refreshTokens(origin, clientId, refreshToken) {
  return tokenRequest(origin, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

/** The whole sign-in: register (unless given a client), open the page, type the password, swap the code. */
export async function signIn(origin, options = {}) {
  const clientId = options.clientId ?? (await register(origin)).json.client_id;
  const { verifier, challenge } = pkce();
  const page = await openSignIn(origin, clientId, { challenge });
  if (page.status !== 200) throw new Error(`sign-in page returned ${page.status}: ${page.html.slice(0, 200)}`);
  const submitted = await submitSignIn(origin, page, {
    decision: "approve",
    password: options.password ?? PASSWORD,
    ...(options.signOutOthers ? { signOutOthers: "1" } : {}),
  });
  if (submitted.status !== 302) throw new Error(`sign-in returned ${submitted.status}: ${submitted.html.slice(0, 200)}`);
  const code = new URL(submitted.location).searchParams.get("code");
  const tokens = await exchangeCode(origin, clientId, code, verifier);
  if (tokens.status !== 200) throw new Error(`token exchange returned ${tokens.status}: ${JSON.stringify(tokens.json)}`);
  return { clientId, accessToken: tokens.json.access_token, refreshToken: tokens.json.refresh_token, tokens: tokens.json };
}

/**
 * Signs in while the earlier-build stand-in is running (see useEarlierBuild above). It asks for
 * nothing and stores the connection the way that build did: without a password fingerprint.
 */
export async function signInEarlierBuild(origin, clientId) {
  const { verifier, challenge } = pkce();
  const answer = await openSignIn(origin, clientId, { challenge });
  if (answer.status !== 302) throw new Error(`the earlier build returned ${answer.status}: ${answer.html.slice(0, 200)}`);
  const code = new URL(answer.location).searchParams.get("code");
  const tokens = await exchangeCode(origin, clientId, code, verifier);
  if (tokens.status !== 200) throw new Error(`token exchange returned ${tokens.status}: ${JSON.stringify(tokens.json)}`);
  return { clientId, accessToken: tokens.json.access_token, refreshToken: tokens.json.refresh_token };
}

/** One MCP request, as plain JSON-RPC over HTTP. */
export async function rpc(origin, token, method, params, options = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: options.httpMethod ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: (options.httpMethod ?? "POST") === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, json, text, headers: response.headers };
}

export async function callTool(origin, token, name, args = {}) {
  const response = await rpc(origin, token, "tools/call", { name, arguments: args });
  const result = response.json?.result;
  return {
    status: response.status,
    rpcError: response.json?.error,
    isError: Boolean(result?.isError),
    text: (result?.content ?? []).map((part) => part.text ?? "").join("\n"),
  };
}
