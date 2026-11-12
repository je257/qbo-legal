// TEST FIXTURE. Never deploy this.
//
// It stands in for the hosted connector as it was before a connection carried a fingerprint of the
// connector password: a sign-in here is stored with no fingerprint at all. The tests sign in
// through it, then put the real Worker back on the same storage, and check that the real Worker
// refuses that connection.
//
// It asks for no password, so it must never have a public address. It therefore has its own Worker
// name (see wrangler.jsonc next to this file) and answers only on this machine.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

const THIS_MACHINE = ["localhost", "127.0.0.1", "[::1]"];
const providers = new Map();

const signInWithoutAsking = {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: "owner",
      metadata: {},
      scope: ["ninety"],
      // What the earlier build stored with a connection: no "pw" (password fingerprint).
      props: { owner: true },
    });
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  },
};

function providerFor(origin) {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: { fetch: () => new Response("earlier build") },
      defaultHandler: signInWithoutAsking,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["ninety"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 30 * 24 * 60 * 60,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!THIS_MACHINE.includes(url.hostname)) return new Response("Not found", { status: 404 });
    return providerFor(url.origin).fetch(request, { ...env }, ctx);
  },
};
