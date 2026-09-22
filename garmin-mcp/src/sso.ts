import { AppConfig, GarminDomain, OAuth1Token, OAuth2Token } from "./config.js";
import { oauth1Header } from "./oauth1.js";

/**
 * Garmin Connect sign-in, implemented the same way the open-source `garth`
 * library does it: log in through Garmin SSO's embedded widget, trade the
 * resulting service ticket for a long-lived OAuth1 token, then exchange that
 * for the short-lived OAuth2 bearer token that connectapi.garmin.com accepts.
 */

export class GarminAuthError extends Error {}

/** Where garth publishes the mobile app's OAuth consumer credentials. */
export const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

const UA_SSO = "GCM-iOS-5.7.2.1";
const UA_MOBILE = "com.garmin.android.apps.connectmobile";

export async function fetchOAuthConsumer(): Promise<{ consumerKey: string; consumerSecret: string }> {
  const res = await fetch(OAUTH_CONSUMER_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new GarminAuthError(
      `Could not download the Garmin OAuth consumer credentials (${res.status}). ` +
        `Set GARMIN_OAUTH_CONSUMER_KEY and GARMIN_OAUTH_CONSUMER_SECRET instead.`,
    );
  }
  const json = (await res.json()) as { consumer_key?: string; consumer_secret?: string };
  if (!json.consumer_key || !json.consumer_secret) {
    throw new GarminAuthError("The OAuth consumer document was missing consumer_key / consumer_secret.");
  }
  return { consumerKey: json.consumer_key, consumerSecret: json.consumer_secret };
}

interface PageResponse {
  url: string;
  status: number;
  text: string;
}

/** Tiny cookie-aware HTTP session scoped to the Garmin SSO host. */
class SsoSession {
  private readonly cookies = new Map<string, string>();
  private lastUrl: string | undefined;

  constructor(private readonly host: string) {}

  async request(
    method: "GET" | "POST",
    url: URL,
    options: { form?: Record<string, string>; referer?: boolean } = {},
  ): Promise<PageResponse> {
    let current = url;
    let currentMethod: string = method;
    let body = options.form ? new URLSearchParams(options.form).toString() : undefined;
    const referer = options.referer ? this.lastUrl : undefined;

    for (let hop = 0; hop < 10; hop++) {
      const headers: Record<string, string> = {
        "User-Agent": UA_SSO,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };
      if (this.cookies.size > 0 && current.host === this.host) {
        headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      if (referer) headers.Referer = referer;
      if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";

      const res = await fetch(current, { method: currentMethod, headers, body, redirect: "manual" });
      if (current.host === this.host) this.storeCookies(res);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        await res.arrayBuffer();
        if (!location) break;
        current = new URL(location, current);
        if (res.status !== 307 && res.status !== 308) {
          currentMethod = "GET";
          body = undefined;
        }
        continue;
      }

      const text = await res.text();
      this.lastUrl = current.toString();
      return { url: this.lastUrl, status: res.status, text };
    }
    throw new GarminAuthError("Too many redirects during Garmin sign-in.");
  }

  private storeCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie !== "function") {
      throw new GarminAuthError("This connector needs Node.js 20 or newer (Headers.getSetCookie is missing).");
    }
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /expires=Thu, 01[ -]Jan[ -]1970/i.test(raw) || /max-age=0(;|$)/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

function withParams(base: string, params: Record<string, string>): URL {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

export function extractTitle(html: string): string | undefined {
  return /<title>\s*(.*?)\s*<\/title>/is.exec(html)?.[1];
}

export function extractCsrf(html: string): string | undefined {
  return /name="_csrf"\s+value="(.+?)"/i.exec(html)?.[1];
}

export function extractTicket(html: string, finalUrl?: string): string | undefined {
  const fromHtml = /embed\?ticket=([^"'&\\]+)/.exec(html)?.[1];
  if (fromHtml) return fromHtml;
  if (finalUrl) {
    try {
      return new URL(finalUrl).searchParams.get("ticket") ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractErrorMessage(html: string): string | undefined {
  const m = /class="[^"]*\berror\b[^"]*"[^>]*>([\s\S]*?)<\//i.exec(html);
  const text = m?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

export interface LoginResult {
  oauth1: OAuth1Token;
  oauth2: OAuth2Token;
}

/**
 * Signs in with email/password (prompting for an MFA code if the account
 * requires one) and returns the OAuth1 + OAuth2 token pair.
 */
export async function login(
  config: AppConfig,
  email: string,
  password: string,
  promptMfa: () => Promise<string>,
): Promise<LoginResult> {
  const SSO = `https://sso.${config.domain}/sso`;
  const SSO_EMBED = `${SSO}/embed`;
  const embedParams = { id: "gauth-widget", embedWidget: "true", gauthHost: SSO };
  const signinParams = {
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: SSO_EMBED,
    service: SSO_EMBED,
    source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  };

  const session = new SsoSession(`sso.${config.domain}`);

  // 1. Prime cookies.
  const embed = await session.request("GET", withParams(SSO_EMBED, embedParams));
  if (embed.status >= 400) throw statusError("reach Garmin SSO", embed.status);

  // 2. Fetch the sign-in form for its CSRF token.
  const signinUrl = withParams(`${SSO}/signin`, signinParams);
  const form = await session.request("GET", signinUrl, { referer: true });
  if (form.status >= 400) throw statusError("load the Garmin sign-in page", form.status);
  const csrf = extractCsrf(form.text);
  if (!csrf) throw new GarminAuthError("Could not find the CSRF token on the Garmin sign-in page.");

  // 3. Submit credentials.
  let page = await session.request("POST", signinUrl, {
    referer: true,
    form: { username: email, password, embed: "true", _csrf: csrf },
  });
  if (page.status === 429) throw statusError("sign in", page.status);
  let title = extractTitle(page.text) ?? "";

  // 4. Handle multi-factor authentication.
  if (/MFA/i.test(title)) {
    const mfaCsrf = extractCsrf(page.text);
    if (!mfaCsrf) throw new GarminAuthError("Garmin asked for an MFA code but the page had no CSRF token.");
    const code = (await promptMfa()).trim();
    if (!code) throw new GarminAuthError("No MFA code entered.");
    page = await session.request("POST", withParams(`${SSO}/verifyMFA/loginEnterMfaCode`, signinParams), {
      referer: true,
      form: { "mfa-code": code, embed: "true", _csrf: mfaCsrf, fromPage: "setupEnterMfaCode" },
    });
    title = extractTitle(page.text) ?? "";
  }

  if (title !== "Success") {
    const detail = extractErrorMessage(page.text);
    throw new GarminAuthError(
      `Garmin sign-in did not succeed (page title: "${title || "unknown"}"` +
        (page.status !== 200 ? `, HTTP ${page.status}` : "") +
        `).` +
        (detail ? ` Garmin said: ${detail}` : " Check the email address and password.") +
        (/MFA/i.test(title) ? " The MFA code may have been wrong or expired." : ""),
    );
  }

  const ticket = extractTicket(page.text, page.url);
  if (!ticket) throw new GarminAuthError("Signed in, but no service ticket was found in Garmin's response.");

  const oauth1 = await getOAuth1Token(config, ticket);
  const oauth2 = await exchangeForOAuth2(config, oauth1);
  return { oauth1, oauth2 };
}

function statusError(action: string, status: number): GarminAuthError {
  if (status === 429) {
    return new GarminAuthError(
      `Garmin rate-limited the sign-in attempt (HTTP 429). Wait a while (often an hour) and try again.`,
    );
  }
  if (status === 403) {
    return new GarminAuthError(
      `Garmin blocked the request (HTTP 403). This can happen temporarily; try again later or from a different network.`,
    );
  }
  return new GarminAuthError(`Could not ${action} (HTTP ${status}).`);
}

async function getOAuth1Token(config: AppConfig, ticket: string): Promise<OAuth1Token> {
  const url = new URL(`https://connectapi.${config.domain}/oauth-service/oauth/preauthorized`);
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("login-url", `https://sso.${config.domain}/sso/embed`);
  url.searchParams.set("accepts-mfa-tokens", "true");

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA_MOBILE,
      Authorization: oauth1Header({
        method: "GET",
        url,
        consumerKey: config.consumerKey,
        consumerSecret: config.consumerSecret,
      }),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new GarminAuthError(`OAuth1 token request failed (${res.status}): ${text}`);
  const parsed = Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new GarminAuthError(`OAuth1 token response was missing fields: ${text}`);
  }
  const token: OAuth1Token = {
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
  };
  if (parsed.mfa_token) token.mfa_token = parsed.mfa_token;
  if (parsed.mfa_expiration_timestamp) token.mfa_expiration_timestamp = parsed.mfa_expiration_timestamp;
  return token;
}

interface ExchangeResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  jti?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

/**
 * Exchanges the OAuth1 token for a fresh OAuth2 bearer token. This is also
 * how the token is "refreshed" once it expires (roughly hourly).
 */
export async function exchangeForOAuth2(
  config: Pick<AppConfig, "domain" | "consumerKey" | "consumerSecret">,
  oauth1: OAuth1Token,
): Promise<OAuth2Token> {
  const url = new URL(`https://connectapi.${config.domain}/oauth-service/oauth/exchange/user/2.0`);
  const bodyParams: Record<string, string> = oauth1.mfa_token ? { mfa_token: oauth1.mfa_token } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA_MOBILE,
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: oauth1Header({
        method: "POST",
        url,
        consumerKey: config.consumerKey,
        consumerSecret: config.consumerSecret,
        token: oauth1.oauth_token,
        tokenSecret: oauth1.oauth_token_secret,
        bodyParams,
      }),
    },
    body: new URLSearchParams(bodyParams).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminAuthError(
      `OAuth2 exchange failed (${res.status}): ${text || res.statusText}. ` +
        `If this keeps happening, run \`node dist/index.js auth\` from the garmin-mcp folder to sign in again.`,
    );
  }
  const json = JSON.parse(text) as ExchangeResponse;
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope,
    jti: json.jti,
    expires_at: now + json.expires_in,
    refresh_token_expires_at:
      json.refresh_token_expires_in !== undefined ? now + json.refresh_token_expires_in : undefined,
  };
}

export function domainLabel(domain: GarminDomain): string {
  return domain === "garmin.cn" ? "China (garmin.cn)" : "Global (garmin.com)";
}
