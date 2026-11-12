import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  MIN_PASSWORD_LENGTH,
  OWNER_ID,
  SCOPE,
  allowedRedirectUris,
  apiBaseUrl,
  callerAddress,
  connectorPassword,
  isAllowedRedirect,
  isOn,
  ninetyToken,
  overLimit,
  passwordFingerprint,
  sameSecret,
  type ConnectionProps,
  type Env,
} from "./env.js";
import { messagePage, pageHeaders, signInPage, statusPage, type SignInView } from "./pages.js";

// Everything that is not the MCP endpoint or an OAuth protocol endpoint: the status page and the
// sign-in page. The OAuth library checks the request and stores the grant; this file decides who
// may sign in. There is exactly one user, the owner, who proves it with the connector password.

function html(status: number, page: string, headers?: Headers, security?: Parameters<typeof pageHeaders>[1]): Response {
  return new Response(page, { status, headers: pageHeaders(headers, security) });
}

function message(status: number, title: string, ...paragraphs: string[]): Response {
  return html(status, messagePage(title, paragraphs));
}

const START_AGAIN = "Go back to Claude and choose Connect again.";

/** Errors the OAuth helpers raise for a bad or expired request: shown on our page, never redirected blindly. */
function authorizationProblem(error: unknown, env: Env): Response | undefined {
  if (error instanceof AuthorizationError) {
    // The library sets these once the app and its exact registered address were validated. That
    // address is followed only if it is also one this connector accepts, so the connector can
    // never be used to bounce a browser to some other site.
    if (error.redirectTo && error.redirectUri && isAllowedRedirect(error.redirectUri, env)) {
      return Response.redirect(error.redirectTo, 302);
    }
    return message(400, "This sign-in request can't be used", error.description, START_AGAIN);
  }
  if (error instanceof CimdFetchError) {
    return message(400, "This app could not be verified", START_AGAIN);
  }
  return undefined;
}

function signInResponse(status: number, view: SignInView, env: Env, headers?: Headers): Response {
  // Browsers apply form-action to the redirect that follows the form, so the page must allow the
  // origins a successful sign-in can be sent to. They come from this connector's own allow-list,
  // never from the request.
  const formTargets = new Set<string>();
  for (const uri of allowedRedirectUris(env)) {
    try {
      formTargets.add(new URL(uri).origin);
    } catch {
      // an entry that is not a URL can never match a redirect, so it needs no form target
    }
  }
  return html(status, signInPage(view), headers, { formTargets: [...formTargets] });
}

async function showSignIn(request: Request, env: Env): Promise<Response> {
  if (await overLimit(env.LOGIN_LIMITER, `page:${callerAddress(request)}`)) {
    return message(429, "Too many requests", "Wait a minute, then choose Connect in Claude again.");
  }
  if (!connectorPassword(env)) {
    return message(
      503,
      "Sign-in is switched off",
      `This connector has no usable password yet. Its owner needs to add a secret named CONNECTOR_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) in the Cloudflare dashboard, then try again.`,
    );
  }

  const oauth = env.OAUTH_PROVIDER;
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    const problem = authorizationProblem(error, env);
    if (problem) return problem;
    throw error;
  }

  // The library has checked the address against what the app registered. This checks it against
  // what this connector accepts at all, so a look-alike app cannot receive a sign-in.
  if (!isAllowedRedirect(authRequest.redirectUri, env)) {
    return message(
      403,
      "This app is not allowed to connect",
      "This connector only signs in to Claude. Nothing was shared.",
    );
  }

  try {
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return signInResponse(
      200,
      {
        clientName: details.clientName,
        redirectHost: details.redirectHost,
        redirectIsLoopback: details.redirectIsLoopback,
        handle: consent.handle,
        signOutOthers: false,
      },
      env,
      consent.headers,
    );
  } catch (error) {
    const problem = authorizationProblem(error, env);
    if (problem) return problem;
    throw error;
  }
}

/**
 * One request may do about 1,000 storage operations, and ending a connection takes 3 plus one for
 * each of its live tokens. This many connections can be ended in one go.
 */
const MAX_SIGN_OUTS_PER_REQUEST = 200;

/**
 * Ends the owner's existing connections. Used when they tick "sign out every other connection".
 * `more` is true if some were left because the limit above was reached; changing the connector
 * password ends every connection whatever their number (see the fingerprint in env.ts).
 */
async function revokeAllGrants(env: Env): Promise<{ revoked: number; more: boolean }> {
  const oauth = env.OAUTH_PROVIDER;
  let revoked = 0;
  let cursor: string | undefined;
  for (;;) {
    const list = await oauth.listUserGrants(OWNER_ID, { limit: 50, cursor });
    for (const grant of list.items) {
      if (revoked >= MAX_SIGN_OUTS_PER_REQUEST) return { revoked, more: true };
      await oauth.revokeGrant(grant.id, OWNER_ID);
      revoked++;
    }
    cursor = list.cursor;
    if (!cursor) return { revoked, more: false };
  }
}

async function submitSignIn(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return message(400, "This sign-in request can't be used", START_AGAIN);
  }
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const handle = field("handle");

  try {
    if (field("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Shown again if the password is wrong. Display only: the real request is kept by the server
    // under the handle and nothing here is trusted.
    const view: SignInView = {
      clientName: field("client").slice(0, 200) || "An app",
      redirectHost: field("host").slice(0, 200) || "the app",
      redirectIsLoopback: field("loopback") === "1",
      handle,
      // Kept when the form is shown again, so a mistyped password does not quietly drop the choice.
      signOutOthers: field("signOutOthers") === "1",
    };

    const expected = connectorPassword(env);
    if (!expected) {
      return message(
        503,
        "Sign-in is switched off",
        `This connector has no usable password. Its owner needs to add a secret named CONNECTOR_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) in the Cloudflare dashboard.`,
      );
    }

    const tooMany =
      (await overLimit(env.LOGIN_LIMITER, `login:${callerAddress(request)}`)) ||
      (await overLimit(env.LOGIN_LIMITER_GLOBAL, "login"));
    if (tooMany) {
      return signInResponse(429, { ...view, error: "Too many attempts. Wait a minute, then try again." }, env);
    }

    if (!(await sameSecret(field("password").trim(), expected))) {
      console.warn(JSON.stringify({ event: "sign_in_failed" }));
      return signInResponse(401, { ...view, error: "That password is not right. Try again." }, env);
    }

    // The password was right. Everything below uses the request the server stored, not the form.
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    if (!isAllowedRedirect(approved.request.redirectUri, env)) {
      return message(403, "This app is not allowed to connect", "Nothing was shared.");
    }
    const signedOut = view.signOutOthers ? await revokeAllGrants(env) : { revoked: 0, more: false };
    // The connection carries a fingerprint of the password it was made with (see env.ts).
    const props: ConnectionProps = { owner: true, pw: await passwordFingerprint(env) };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: { signedInAt: new Date().toISOString() },
      scope: [SCOPE],
      props,
    });
    console.log(JSON.stringify({ event: "sign_in", signedOutOthers: signedOut.revoked, moreLeft: signedOut.more }));
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && !error.redirectTo) {
      // The page was open too long, was already used, or was opened in a different browser.
      return message(400, "This sign-in page has expired", START_AGAIN);
    }
    const problem = authorizationProblem(error, env);
    if (problem) return problem;
    throw error;
  }
}

function showStatus(request: Request, env: Env): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const rawPassword = (env.CONNECTOR_PASSWORD ?? "").trim();
  return html(
    200,
    statusPage({
      mcpUrl: `${new URL(request.url).origin}/mcp`,
      apiAddress: apiBaseUrl(env),
      tokenSet: ninetyToken(env) !== undefined,
      passwordSet: connectorPassword(env) !== undefined,
      passwordTooShort: rawPassword !== "" && rawPassword.length < MIN_PASSWORD_LENGTH,
      storageBound: Boolean(env.OAUTH_KV),
      deleteTools: isOn(env.ENABLE_DELETE_TOOLS),
      rawRequest: isOn(env.ENABLE_RAW_REQUEST),
      minPasswordLength: MIN_PASSWORD_LENGTH,
      scriptNonce: nonce,
    }),
    undefined,
    { scriptNonce: nonce },
  );
}

export const siteHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") {
      if (request.method === "GET") return showSignIn(request, env);
      if (request.method === "POST") return submitSignIn(request, env);
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return showStatus(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
