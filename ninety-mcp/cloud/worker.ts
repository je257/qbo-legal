import { env as startupSettings } from "cloudflare:workers";
import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  SCOPE,
  allowedRedirectUris,
  callerAddress,
  isLoopbackHost,
  mayRegister,
  overLimit,
  passwordFingerprint,
  type ConnectionProps,
  type Env,
} from "./env.js";
import { mcpHandler } from "./mcp.js";
import { prepare } from "./pool.js";
import { siteHandler } from "./site.js";

// Entry point of the hosted Ninety connector (a Cloudflare Worker).
//
//   POST /mcp                 the MCP endpoint; needs a bearer token from the sign-in below
//   GET  /                    status page: what is set up, and the address to give Claude
//   GET/POST /authorize       the sign-in page (cloud/site.ts)
//   /oauth/token, /oauth/register, /.well-known/...   OAuth plumbing, served by the library
//
// The library is @cloudflare/workers-oauth-provider. It refuses every request to /mcp that does not
// carry a token it issued, and it only issues one after the owner has typed the connector password
// on the sign-in page. No secret ever appears in a URL.

const DAY = 24 * 60 * 60;
const REGISTER_PATH = "/oauth/register";
/** Claude's own registration is about 400 bytes. */
const MAX_REGISTRATION_BYTES = 4096;

// Build the first server while the Worker starts instead of on the first request (see pool.ts).
// Never fatal: if it fails the Worker still works, and the first request builds the server itself.
try {
  console.log(JSON.stringify({ event: "warmup", tools: await prepare(startupSettings as unknown as Env) }));
} catch (error) {
  console.warn(JSON.stringify({ event: "warmup_failed", message: error instanceof Error ? error.message : String(error) }));
}

type Provider = OAuthProvider<Env>;
const providers = new Map<string, Provider>();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/**
 * One provider per public address the Worker is reached at. The address is part of the OAuth
 * identity (issuer and resource), and it is not known until the Worker is deployed, so it is taken
 * from the request. Only the Worker's own https address (and a loopback address in tests) gets
 * this far; see the check at the top of fetch().
 */
function providerFor(origin: string, env: Env): Provider {
  const key = `${origin}|${env.ALLOWED_REDIRECT_URIS ?? ""}`;
  let provider = providers.get(key);
  if (provider) return provider;
  if (providers.size >= 8) providers.clear();

  const redirects = allowedRedirectUris(env);
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: siteHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Ninety connector",
    },
    // An access token lasts an hour; Claude renews it silently with the refresh token. A connection
    // that is used at least once every 30 days keeps going; an idle one ends and needs a new sign-in.
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * DAY,
    refreshTokenIdleTTL: 30 * DAY,
    // Apps register themselves before signing in. Only a small, plain registration whose every
    // redirect address is one this connector accepts (Claude's, by default) is stored at all.
    clientRegistrationCallback({ clientMetadata }) {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      const acceptable =
        uris.length > 0 &&
        uris.length <= 4 &&
        uris.every((uri) => typeof uri === "string" && redirects.includes(uri)) &&
        JSON.stringify(clientMetadata).length <= MAX_REGISTRATION_BYTES;
      if (!acceptable) {
        return {
          code: "access_denied",
          description: "This connector only accepts sign-ins from Claude.",
          status: 403,
        };
      }
    },
    // Runs when a sign-in is turned into tokens and at every renewal. A connection is tied to the
    // connector password it was made with, so changing the password ends every connection: the
    // renewal is refused and the library deletes the grant. A connection with no fingerprint at
    // all is refused too; it is never quietly tied to whatever the password is now.
    async tokenExchangeCallback({ props, env: settings }) {
      const current = await passwordFingerprint(settings);
      if (!current) {
        // No usable password is saved at the moment. That can be put right, so the connection is
        // kept ("temporarily unavailable") and not deleted ("invalid grant").
        throw new OAuthError("temporarily_unavailable", { description: "Sign-in is switched off.", statusCode: 503 });
      }
      if ((props as ConnectionProps | undefined)?.pw !== current) {
        throw new OAuthError("invalid_grant", { description: "This connection has ended. Connect again." });
      }
    },
    onError({ code, status, internal }) {
      console.warn(
        JSON.stringify({ event: "oauth_error", code, status, category: internal?.category, reason: internal?.reason }),
      );
    },
  });
  providers.set(key, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The connector has exactly one address: https on the default port. Cloudflare also accepts the
    // same hostname on a few other ports, and each would otherwise count as a separate OAuth identity.
    if (!isLoopbackHost(url.hostname) && (url.protocol !== "https:" || url.port !== "")) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === REGISTER_PATH && request.method === "POST") {
      // Claude registers from Anthropic's servers. Nobody else needs to, and every registration
      // is a write to storage that has a small daily allowance on Cloudflare's free plan.
      if (!mayRegister(request, env)) {
        console.warn(JSON.stringify({ event: "registration_refused", reason: "source" }));
        return json(403, { error: "access_denied", error_description: "Registration is only open to Claude." });
      }
      if (Number(request.headers.get("Content-Length") ?? "0") > MAX_REGISTRATION_BYTES) {
        return json(413, { error: "invalid_client_metadata", error_description: "The registration is too large." });
      }
      if (await overLimit(env.LOGIN_LIMITER, `register:${callerAddress(request)}`)) {
        return json(
          429,
          { error: "temporarily_unavailable", error_description: "Too many registrations. Try again in a minute." },
          { "Retry-After": "60" },
        );
      }
    }

    try {
      // The library attaches its helpers to the settings object it is given, once. A copy per
      // request keeps those helpers tied to the provider that is actually handling this request.
      return await providerFor(url.origin, env).fetch(request, { ...env }, ctx);
    } catch (error) {
      console.error(JSON.stringify({ event: "unhandled_error", message: error instanceof Error ? error.message : String(error) }));
      return new Response("Server error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
