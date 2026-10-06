import { AppConfig, AuthTokens, DiToken, GarminDomain, OAuth1Token, OAuth2Token, saveConfig } from "./config.js";
import { oauth1Header } from "./oauth1.js";

/**
 * Garmin Connect sign-in, ported from the open-source python-garminconnect
 * (0.3.x) and garth (0.8) libraries:
 *
 *   1. Obtain a CAS service ticket from Garmin SSO. Four strategies are tried
 *      in turn, each in a different rate-limit bucket: the mobile app's JSON
 *      login (iOS client, then Android client), the embedded sign-in widget
 *      (HTML form), and the web portal's JSON login.
 *   2. Exchange the ticket for a "DI" OAuth2 bearer token + refresh token at
 *      diauth.garmin.com (what the current Garmin Connect app does). If that
 *      is refused, fall back to garth's OAuth1 -> OAuth2 exchange.
 *   3. Confirm connectapi.garmin.com actually accepts the token.
 */

export type AuthFailureKind = "credentials" | "mfa" | "rate-limit" | "blocked" | "rejected" | "transport";

export class GarminAuthError extends Error {
  constructor(
    message: string,
    readonly kind: AuthFailureKind = "transport",
  ) {
    super(message);
  }
}

export const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

const IOS_LOGIN_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_LOGIN_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OAUTH_USER_AGENT = "com.garmin.android.apps.connectmobile";
/** User-Agent garth sends with OAuth1-derived bearer tokens. */
export const GARTH_API_USER_AGENT = "GCM-iOS-5.22.1.4";
const NATIVE_API_USER_AGENT = "GCM-Android-5.23";
const NATIVE_X_GARMIN_USER_AGENT =
  "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0";
const DI_GRANT_TYPE = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
const DI_CLIENT_IDS = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI",
];
const PORTAL_CLIENT_ID = "GarminConnect";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const JSON_ACCEPT = "application/json, text/plain, */*";
const MFA_ATTEMPTS = 3;

/** Headers the native Garmin Connect Android app sends to the API tier. */
export function nativeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": NATIVE_API_USER_AGENT,
    "X-Garmin-User-Agent": NATIVE_X_GARMIN_USER_AGENT,
    "X-Garmin-Paired-App-Version": "10861",
    "X-Garmin-Client-Platform": "Android",
    "X-App-Ver": "10861",
    "X-Lang": "en",
    "X-GCExperience": "GC5",
    "Accept-Language": "en-US,en;q=0.9",
    ...extra,
  };
}

/** Request headers for connectapi calls, per token method. */
export function apiHeaders(auth: AuthTokens): Record<string, string> {
  if (auth.method === "di") {
    return nativeHeaders({ Authorization: `Bearer ${auth.di.accessToken}`, Accept: "application/json" });
  }
  return {
    Authorization: `Bearer ${auth.oauth2.access_token}`,
    "User-Agent": GARTH_API_USER_AGENT,
    Accept: "application/json",
  };
}

export function domainLabel(domain: GarminDomain): string {
  return domain === "garmin.cn" ? "China (garmin.cn)" : "Global (garmin.com)";
}

// ------------------------------------------------------------------ http

interface PageResponse {
  url: string;
  status: number;
  ok: boolean;
  text: string;
  json(): Record<string, unknown> | undefined;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
}

/** Minimal cookie-aware HTTP session with manual redirect handling. */
class CookieSession {
  private readonly cookies = new Map<string, StoredCookie>();
  lastUrl: string | undefined;

  async request(
    method: "GET" | "POST",
    url: URL,
    options: {
      headers?: Record<string, string>;
      form?: Record<string, string>;
      json?: unknown;
      referer?: boolean | string;
    } = {},
  ): Promise<PageResponse> {
    let current = url;
    let currentMethod: string = method;
    let body: string | undefined;
    let contentType: string | undefined;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      contentType = "application/x-www-form-urlencoded";
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      contentType = "application/json";
    }
    const referer = options.referer === true ? this.lastUrl : options.referer || undefined;

    for (let hop = 0; hop < 10; hop++) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      const cookie = this.cookieHeader(current.hostname);
      if (cookie) headers.Cookie = cookie;
      if (referer) headers.Referer = referer;
      if (body !== undefined && contentType) headers["Content-Type"] = contentType;

      const res = await fetch(current, { method: currentMethod, headers, body, redirect: "manual" });
      this.storeCookies(res, current.hostname);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        await res.arrayBuffer();
        if (!location) break;
        current = new URL(location, current);
        if (res.status !== 307 && res.status !== 308) {
          currentMethod = "GET";
          body = undefined;
          contentType = undefined;
        }
        continue;
      }

      const text = await res.text();
      this.lastUrl = current.toString();
      return {
        url: this.lastUrl,
        status: res.status,
        ok: res.ok,
        text,
        json: () => {
          try {
            const parsed: unknown = JSON.parse(text);
            return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
          } catch {
            return undefined;
          }
        },
      };
    }
    throw new GarminAuthError("Too many redirects during Garmin sign-in.");
  }

  cookieHeader(host: string): string {
    const pairs: string[] = [];
    for (const c of this.cookies.values()) {
      const matches = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
      if (matches) pairs.push(`${c.name}=${c.value}`);
    }
    return pairs.join("; ");
  }

  private storeCookies(res: Response, host: string): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie !== "function") {
      throw new GarminAuthError("This connector needs Node.js 20 or newer (Headers.getSetCookie is missing).");
    }
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = (pair ?? "").indexOf("=");
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      let domain = host;
      let hostOnly = true;
      let expired = false;
      for (const attr of attrs) {
        const [k, ...rest] = attr.trim().split("=");
        const v = rest.join("=").trim();
        const key = (k ?? "").toLowerCase();
        if (key === "domain" && v) {
          domain = v.replace(/^\./, "").toLowerCase();
          hostOnly = false;
        } else if (key === "max-age" && Number(v) <= 0) expired = true;
        else if (key === "expires" && !Number.isNaN(Date.parse(v)) && Date.parse(v) < Date.now()) expired = true;
      }
      const key = `${domain}|${name}`;
      if (value === "" || expired) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, domain, hostOnly });
    }
  }
}

function withParams(base: string, params: Record<string, string>): URL {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minSeconds: number, maxSeconds: number): number {
  return minSeconds + Math.random() * (maxSeconds - minSeconds);
}

function toAuthError(error: unknown): GarminAuthError {
  if (error instanceof GarminAuthError) return error;
  const message = error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
  return new GarminAuthError(`Network error: ${message}`, "transport");
}

// --------------------------------------------------------- login flows

export interface LoginOptions {
  promptMfa: (method: string) => Promise<string>;
  log?: (message: string) => void;
}

interface ServiceTicket {
  ticket: string;
  serviceUrl: string;
}

interface JsonLoginContext {
  session: CookieSession;
  sso: string;
  flowPath: "mobile" | "portal";
  params: Record<string, string>;
  headers: Record<string, string>;
  serviceUrl: string;
}

/** Interprets the JSON body Garmin's /api/login and /api/mfa/verifyCode return. */
function readJsonLoginResponse(
  res: PageResponse,
  label: string,
): { ticket: string } | { mfaMethod: string } {
  if (res.status === 429) {
    throw new GarminAuthError(`${label}: Garmin rate-limited the request (HTTP 429).`, "rate-limit");
  }
  if (res.status === 403) {
    throw new GarminAuthError(`${label}: Garmin blocked the request (HTTP 403, bot challenge).`, "blocked");
  }
  const json = res.json();
  if (!json) {
    throw new GarminAuthError(`${label}: Garmin returned a non-JSON page (HTTP ${res.status}), probably a bot challenge.`, "blocked");
  }
  const status = (json.responseStatus ?? {}) as { type?: string; message?: string };
  const type = status.type;
  if (type === "SUCCESSFUL") {
    const ticket = json.serviceTicketId;
    if (typeof ticket !== "string" || !ticket) throw new GarminAuthError(`${label}: sign-in succeeded but no service ticket was returned.`);
    return { ticket };
  }
  if (type === "MFA_REQUIRED") {
    const info = (json.customerMfaInfo ?? {}) as { mfaLastMethodUsed?: string };
    return { mfaMethod: info.mfaLastMethodUsed || "email" };
  }
  if (type === "INVALID_USERNAME_PASSWORD") {
    throw new GarminAuthError("Garmin rejected the email address or password.", "credentials");
  }
  const error = (json.error ?? {}) as { ["status-code"]?: string };
  if (error["status-code"] === "429") {
    throw new GarminAuthError(`${label}: Garmin rate-limited the request (429 in response body).`, "rate-limit");
  }
  if (type === "CAPTCHA_REQUIRED") {
    throw new GarminAuthError(`${label}: Garmin is asking for a CAPTCHA (bot challenge).`, "blocked");
  }
  if (type === "ACCOUNT_LOCKED" || /locked/i.test(status.message ?? "")) {
    throw new GarminAuthError(`Garmin reports the account is locked: ${status.message ?? type}`, "credentials");
  }
  throw new GarminAuthError(`${label}: unexpected response (HTTP ${res.status}, status ${type ?? "unknown"}${status.message ? `: ${status.message}` : ""}).`);
}

/** Completes MFA for the JSON (mobile / portal) flows. */
async function verifyMfaJson(ctx: JsonLoginContext, mfaMethod: string, opts: LoginOptions): Promise<string> {
  const alt: Pick<JsonLoginContext, "flowPath" | "params"> =
    ctx.flowPath === "mobile"
      ? { flowPath: "portal", params: { clientId: PORTAL_CLIENT_ID, locale: "en-US", service: `https://connect.${new URL(ctx.sso).hostname.replace(/^sso\./, "")}/app` } }
      : { flowPath: "mobile", params: { clientId: "GCM_IOS_DARK", locale: "en-US", service: ctx.serviceUrl.replace(/\/gcm\/\w+$/, "/gcm/ios").replace(/^https:\/\/connect\./, "https://mobile.integration.") } };

  for (let attempt = 1; attempt <= MFA_ATTEMPTS; attempt++) {
    const code = (await opts.promptMfa(mfaMethod)).trim();
    if (!code) throw new GarminAuthError("No MFA code entered.", "mfa");
    const body = {
      mfaMethod,
      mfaVerificationCode: code,
      rememberMyBrowser: true,
      reconsentList: [],
      mfaSetup: false,
    };
    const failures: string[] = [];
    let wrongCode = false;
    for (const target of [ctx, { ...ctx, ...alt }]) {
      let res: PageResponse;
      try {
        res = await ctx.session.request("POST", withParams(`${ctx.sso}/${target.flowPath}/api/mfa/verifyCode`, target.params), {
          headers: ctx.headers,
          json: body,
        });
      } catch (error) {
        failures.push(`${target.flowPath}: ${toAuthError(error).message}`);
        continue;
      }
      try {
        const outcome = readJsonLoginResponse(res, `MFA (${target.flowPath})`);
        if ("ticket" in outcome) return outcome.ticket;
        failures.push(`${target.flowPath}: MFA still required`);
      } catch (error) {
        const err = toAuthError(error);
        if (err.kind === "credentials") throw err;
        failures.push(err.message);
        // A plain non-success JSON answer means the code itself was wrong.
        if (err.kind === "transport" && res.json()) wrongCode = true;
      }
    }
    if (!wrongCode) throw new GarminAuthError(`MFA verification failed: ${failures.join("; ")}`, "mfa");
    if (attempt < MFA_ATTEMPTS) opts.log?.("That code was not accepted. Try again.");
  }
  throw new GarminAuthError(`MFA verification failed after ${MFA_ATTEMPTS} attempts.`, "mfa");
}

async function jsonLogin(ctx: JsonLoginContext, loginPath: string, email: string, password: string, opts: LoginOptions): Promise<ServiceTicket> {
  const res = await ctx.session.request("POST", withParams(`${ctx.sso}${loginPath}`, ctx.params), {
    headers: ctx.headers,
    json: { username: email, password, rememberMe: true, captchaToken: "" },
  });
  const outcome = readJsonLoginResponse(res, "Sign-in");
  if ("ticket" in outcome) return { ticket: outcome.ticket, serviceUrl: ctx.serviceUrl };
  opts.log?.(`Garmin wants a verification code (${outcome.mfaMethod}).`);
  return { ticket: await verifyMfaJson(ctx, outcome.mfaMethod, opts), serviceUrl: ctx.serviceUrl };
}

/** Strategy 1/2: the mobile app's JSON login. */
async function mobileLogin(domain: GarminDomain, variant: "ios" | "android", email: string, password: string, opts: LoginOptions): Promise<ServiceTicket> {
  const sso = `https://sso.${domain}`;
  const serviceUrl = `https://mobile.integration.${domain}/gcm/${variant}`;
  const ctx: JsonLoginContext = {
    session: new CookieSession(),
    sso,
    flowPath: "mobile",
    params: { clientId: variant === "ios" ? "GCM_IOS_DARK" : "GCM_ANDROID_DARK", locale: "en-US", service: serviceUrl },
    headers: { "User-Agent": variant === "ios" ? IOS_LOGIN_UA : ANDROID_LOGIN_UA, Accept: JSON_ACCEPT, Origin: sso },
    serviceUrl,
  };
  return jsonLogin(ctx, "/mobile/api/login", email, password, opts);
}

/** Strategy 4: the web portal's JSON login (desktop browser flow). */
async function portalLogin(domain: GarminDomain, email: string, password: string, opts: LoginOptions): Promise<ServiceTicket> {
  const sso = `https://sso.${domain}`;
  const serviceUrl = `https://connect.${domain}/app`;
  const session = new CookieSession();
  const signinUrl = withParams(`${sso}/portal/sso/en-US/sign-in`, { clientId: PORTAL_CLIENT_ID, service: serviceUrl });
  const page = await session.request("GET", signinUrl, {
    headers: { "User-Agent": DESKTOP_UA, Accept: HTML_ACCEPT, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (page.status === 429) throw new GarminAuthError("Portal sign-in page: rate-limited (HTTP 429).", "rate-limit");

  const delay = randomBetween(10, 20);
  opts.log?.(`Waiting ${Math.round(delay)}s before submitting (Garmin flags instant form posts as bots)...`);
  await sleep(delay * 1000);

  const ctx: JsonLoginContext = {
    session,
    sso,
    flowPath: "portal",
    params: { clientId: PORTAL_CLIENT_ID, locale: "en-US", service: serviceUrl },
    headers: {
      "User-Agent": DESKTOP_UA,
      Accept: JSON_ACCEPT,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: sso,
      Referer: signinUrl.toString(),
    },
    serviceUrl,
  };
  return jsonLogin(ctx, "/portal/api/login", email, password, opts);
}

export function extractTitle(html: string): string {
  return /<title>\s*(.*?)\s*<\/title>/is.exec(html)?.[1] ?? "";
}

export function extractCsrf(html: string): string | undefined {
  return /name="_csrf"\s+value="(.+?)"/i.exec(html)?.[1];
}

export function extractTicket(html: string): string | undefined {
  return /\?ticket=(ST-[^"&\s\\]+)/.exec(html)?.[1];
}

export function parseWidgetMfaVars(html: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /var\s+(customerGuid|mfaMethod|locale|clientId|codeSentTo)\s*=\s*"([^"]*)"\s*;/g;
  for (const m of html.matchAll(re)) vars[m[1]!] = m[2]!;
  return vars;
}

/** Strategy 3: the embedded sign-in widget (HTML form; separate rate-limit bucket). */
async function widgetLogin(domain: GarminDomain, email: string, password: string, opts: LoginOptions): Promise<ServiceTicket> {
  const sso = `https://sso.${domain}`;
  const ssoBase = `${sso}/sso`;
  const ssoEmbed = `${ssoBase}/embed`;
  const embedParams = { id: "gauth-widget", embedWidget: "true", gauthHost: ssoBase };
  const signinParams = {
    ...embedParams,
    gauthHost: ssoEmbed,
    service: ssoEmbed,
    source: ssoEmbed,
    redirectAfterAccountLoginUrl: ssoEmbed,
    redirectAfterAccountCreationUrl: ssoEmbed,
  };
  const headers = { "User-Agent": DESKTOP_UA, Accept: HTML_ACCEPT, "Accept-Language": "en-US,en;q=0.9" };
  const session = new CookieSession();

  const embed = await session.request("GET", withParams(ssoEmbed, embedParams), { headers });
  if (embed.status === 429) throw new GarminAuthError("Widget embed page: rate-limited (HTTP 429).", "rate-limit");
  if (!embed.ok) throw new GarminAuthError(`Widget embed page returned HTTP ${embed.status}.`);

  const form = await session.request("GET", withParams(`${ssoBase}/signin`, signinParams), { headers, referer: ssoEmbed });
  if (form.status === 429) throw new GarminAuthError("Widget sign-in page: rate-limited (HTTP 429).", "rate-limit");
  const csrf = extractCsrf(form.text);
  if (!csrf) throw new GarminAuthError("Widget sign-in page had no CSRF token.");

  const delay = randomBetween(3, 8);
  opts.log?.(`Waiting ${Math.round(delay)}s before submitting...`);
  await sleep(delay * 1000);

  let page = await session.request("POST", withParams(`${ssoBase}/signin`, signinParams), {
    headers,
    referer: true,
    form: { username: email, password, embed: "true", _csrf: csrf },
  });
  if (page.status === 429) throw new GarminAuthError("Widget sign-in: rate-limited (HTTP 429).", "rate-limit");

  let title = extractTitle(page.text);
  const lower = title.toLowerCase();
  if (["bad gateway", "service unavailable", "cloudflare", "502", "503"].some((h) => lower.includes(h))) {
    throw new GarminAuthError(`Widget sign-in: server error "${title}".`);
  }
  if (["locked", "invalid", "incorrect", "account error"].some((h) => lower.includes(h))) {
    throw new GarminAuthError(`Garmin rejected the sign-in: "${title}".`, "credentials");
  }
  if (lower.includes("unable to sign in") || lower.includes("unable to login")) {
    throw new GarminAuthError(`Widget sign-in: "${title}" (child/family accounts cannot use web sign-in).`);
  }

  const mfaVars = parseWidgetMfaVars(page.text);
  const mfaMethod = (mfaVars.mfaMethod ?? "").toLowerCase();
  if (lower.includes("mfa") || (lower.includes("authentication application") && mfaMethod)) {
    if ((mfaMethod === "email" || mfaMethod === "sms") && !mfaVars.codeSentTo) {
      const sent = await session.request("POST", withParams(`${ssoBase}/verifyMFA/mfaCode`, { clientId: mfaVars.clientId ?? "" }), {
        headers: { ...headers, Accept: JSON_ACCEPT },
        referer: true,
        json: { customerGuid: mfaVars.customerGuid ?? "", mfaMethod: mfaVars.mfaMethod ?? "", locale: mfaVars.locale ?? "" },
      });
      if (sent.status === 429) throw new GarminAuthError("Widget MFA code request: rate-limited (HTTP 429).", "rate-limit");
      if (!sent.ok) throw new GarminAuthError(`Widget MFA code request returned HTTP ${sent.status}.`);
    }
    opts.log?.(`Garmin wants a verification code (${mfaMethod || "mfa"}).`);
    const mfaCsrf = extractCsrf(page.text);
    if (!mfaCsrf) throw new GarminAuthError("Widget MFA page had no CSRF token.", "mfa");
    const code = (await opts.promptMfa(mfaMethod || "email")).trim();
    if (!code) throw new GarminAuthError("No MFA code entered.", "mfa");
    page = await session.request("POST", withParams(`${ssoBase}/verifyMFA/loginEnterMfaCode`, signinParams), {
      headers,
      referer: true,
      form: { "mfa-code": code, embed: "true", _csrf: mfaCsrf, fromPage: "setupEnterMfaCode" },
    });
    if (page.status === 429) throw new GarminAuthError("Widget MFA verify: rate-limited (HTTP 429).", "rate-limit");
    title = extractTitle(page.text);
    if (title !== "Success") throw new GarminAuthError(`MFA verification failed ("${title}").`, "mfa");
  } else if (title !== "Success") {
    throw new GarminAuthError(`Widget sign-in: unexpected page "${title || "untitled"}".`);
  }

  const ticket = extractTicket(page.text);
  if (!ticket) throw new GarminAuthError("Widget sign-in succeeded but no service ticket was found.");
  return { ticket, serviceUrl: ssoEmbed };
}

// ------------------------------------------------------- token exchange

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string };
    if (header.alg === "none") return undefined;
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function basicAuth(clientId: string): string {
  return "Basic " + Buffer.from(`${clientId}:`).toString("base64");
}

function diTokenFromResponse(data: Record<string, unknown>, fallbackClientId: string, previous?: DiToken): DiToken {
  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new GarminAuthError("DI token response had no access_token.");
  const payload = decodeJwtPayload(accessToken) ?? {};
  const exp = Number(payload.exp);
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken,
    clientId: typeof payload.client_id === "string" && payload.client_id ? payload.client_id : fallbackClientId,
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp : undefined,
  };
}

/** Exchanges a CAS service ticket for a DI bearer token (+ refresh token). */
export async function exchangeTicketForDi(domain: GarminDomain, ticket: ServiceTicket): Promise<DiToken> {
  const url = `https://diauth.${domain}/di-oauth2-service/oauth/token`;
  const failures: string[] = [];
  for (const clientId of DI_CLIENT_IDS) {
    const res = await fetch(url, {
      method: "POST",
      headers: nativeHeaders({
        Authorization: basicAuth(clientId),
        Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      }),
      body: new URLSearchParams({
        client_id: clientId,
        service_ticket: ticket.ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: ticket.serviceUrl,
      }).toString(),
    });
    const text = await res.text();
    if (res.status === 429) throw new GarminAuthError("DI token exchange: rate-limited (HTTP 429).", "rate-limit");
    if (!res.ok) {
      failures.push(`${clientId}: HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      continue;
    }
    try {
      return diTokenFromResponse(JSON.parse(text) as Record<string, unknown>, clientId);
    } catch (error) {
      failures.push(`${clientId}: ${toAuthError(error).message}`);
    }
  }
  throw new GarminAuthError(`DI token exchange failed for every client id: ${failures.join(" | ")}`, "rejected");
}

/** Refreshes a DI bearer token using its refresh token. */
export async function refreshDiToken(domain: GarminDomain, di: DiToken): Promise<DiToken> {
  if (!di.refreshToken) throw new GarminAuthError("No refresh token is stored; sign in again.", "rejected");
  const res = await fetch(`https://diauth.${domain}/di-oauth2-service/oauth/token`, {
    method: "POST",
    headers: nativeHeaders({
      Authorization: basicAuth(di.clientId),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    }),
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: di.clientId, refresh_token: di.refreshToken }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminAuthError(
      `Garmin refused to refresh the sign-in token (HTTP ${res.status}). Run \`node dist/index.js auth\` from the garmin-mcp folder to sign in again.`,
      "rejected",
    );
  }
  return diTokenFromResponse(JSON.parse(text) as Record<string, unknown>, di.clientId, di);
}

export async function fetchOAuthConsumer(): Promise<{ consumerKey: string; consumerSecret: string }> {
  const res = await fetch(OAUTH_CONSUMER_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new GarminAuthError(`Could not download the OAuth consumer credentials (HTTP ${res.status}).`);
  const json = (await res.json()) as { consumer_key?: string; consumer_secret?: string };
  if (!json.consumer_key || !json.consumer_secret) throw new GarminAuthError("The OAuth consumer document was missing consumer_key / consumer_secret.");
  return { consumerKey: json.consumer_key, consumerSecret: json.consumer_secret };
}

type ConsumerConfig = { domain: GarminDomain; consumerKey: string; consumerSecret: string };

async function getOAuth1Token(config: ConsumerConfig, ticket: ServiceTicket): Promise<OAuth1Token> {
  const url = new URL(`https://connectapi.${config.domain}/oauth-service/oauth/preauthorized`);
  url.searchParams.set("ticket", ticket.ticket);
  url.searchParams.set("login-url", ticket.serviceUrl);
  url.searchParams.set("accepts-mfa-tokens", "true");
  const res = await fetch(url, {
    headers: {
      "User-Agent": OAUTH_USER_AGENT,
      Authorization: oauth1Header({ method: "GET", url, consumerKey: config.consumerKey, consumerSecret: config.consumerSecret }),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new GarminAuthError(`OAuth1 token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`, "rejected");
  const parsed = Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
  if (!parsed.oauth_token || !parsed.oauth_token_secret) throw new GarminAuthError(`OAuth1 token response was missing fields: ${text.slice(0, 200)}`, "rejected");
  const token: OAuth1Token = { oauth_token: parsed.oauth_token, oauth_token_secret: parsed.oauth_token_secret };
  if (parsed.mfa_token) token.mfa_token = parsed.mfa_token;
  if (parsed.mfa_expiration_timestamp) token.mfa_expiration_timestamp = parsed.mfa_expiration_timestamp;
  return token;
}

/**
 * Exchanges the OAuth1 token for an OAuth2 bearer token (fallback method).
 * Also how that token is refreshed once it expires.
 */
export async function exchangeForOAuth2(config: ConsumerConfig, oauth1: OAuth1Token, options: { login?: boolean } = {}): Promise<OAuth2Token> {
  const url = new URL(`https://connectapi.${config.domain}/oauth-service/oauth/exchange/user/2.0`);
  const bodyParams: Record<string, string> = {};
  if (options.login) bodyParams.audience = "GARMIN_CONNECT_MOBILE_ANDROID_DI";
  if (oauth1.mfa_token) bodyParams.mfa_token = oauth1.mfa_token;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": OAUTH_USER_AGENT,
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
      `OAuth2 exchange failed (HTTP ${res.status}): ${text.slice(0, 200) || res.statusText}. Run \`node dist/index.js auth\` from the garmin-mcp folder to sign in again.`,
      "rejected",
    );
  }
  const json = JSON.parse(text) as { access_token: string; refresh_token?: string; token_type?: string; scope?: string; jti?: string; expires_in: number; refresh_token_expires_in?: number };
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope,
    jti: json.jti,
    expires_at: now + json.expires_in,
    refresh_token_expires_at: json.refresh_token_expires_in !== undefined ? now + json.refresh_token_expires_in : undefined,
  };
}

async function consumerConfig(config: AppConfig): Promise<ConsumerConfig> {
  if (config.consumerKey && config.consumerSecret) return { domain: config.domain, consumerKey: config.consumerKey, consumerSecret: config.consumerSecret };
  const fetched = await fetchOAuthConsumer();
  saveConfig({ ...config, ...fetched });
  return { domain: config.domain, ...fetched };
}

/** Turns a service ticket into API tokens: DI first, garth's OAuth1 path as fallback. */
async function establishSession(config: AppConfig, ticket: ServiceTicket, opts: LoginOptions): Promise<AuthTokens> {
  try {
    return { method: "di", di: await exchangeTicketForDi(config.domain, ticket) };
  } catch (error) {
    const err = toAuthError(error);
    if (err.kind === "rate-limit") throw err;
    opts.log?.(`Primary token exchange failed (${err.message}); trying the OAuth1 exchange instead...`);
  }
  const cc = await consumerConfig(config);
  const oauth1 = await getOAuth1Token(cc, ticket);
  const oauth2 = await exchangeForOAuth2(cc, oauth1, { login: true });
  return { method: "oauth1", oauth1, oauth2 };
}

/** Checks that connectapi accepts the token. Only a definite 401/403 counts as rejection. */
export async function verifyToken(domain: GarminDomain, auth: AuthTokens): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`https://connectapi.${domain}/userprofile-service/socialProfile`, {
      headers: { ...apiHeaders(auth), ...(domain === "garmin.cn" ? { "di-backend": "connectapi.garmin.cn" } : {}) },
    });
    await res.arrayBuffer();
    return { ok: res.status !== 401 && res.status !== 403, status: res.status };
  } catch {
    return { ok: true, status: 0 };
  }
}

/**
 * Signs in with email/password (prompting for an MFA code if needed) and
 * returns API tokens that connectapi has confirmed it accepts.
 */
export async function login(config: AppConfig, email: string, password: string, opts: LoginOptions): Promise<AuthTokens> {
  const strategies: { name: string; run: () => Promise<ServiceTicket> }[] = [
    { name: "mobile app sign-in (iOS)", run: () => mobileLogin(config.domain, "ios", email, password, opts) },
    { name: "mobile app sign-in (Android)", run: () => mobileLogin(config.domain, "android", email, password, opts) },
    { name: "embedded sign-in widget", run: () => widgetLogin(config.domain, email, password, opts) },
    { name: "web portal sign-in", run: () => portalLogin(config.domain, email, password, opts) },
  ];
  const failures: string[] = [];
  let rateLimited = 0;

  for (const strategy of strategies) {
    opts.log?.(`Trying ${strategy.name}...`);
    let ticket: ServiceTicket;
    try {
      ticket = await strategy.run();
    } catch (error) {
      const err = toAuthError(error);
      if (err.kind === "credentials" || err.kind === "mfa") throw err;
      if (err.kind === "rate-limit") rateLimited++;
      failures.push(`${strategy.name}: ${err.message}`);
      continue;
    }

    let auth: AuthTokens;
    try {
      auth = await establishSession(config, ticket, opts);
    } catch (error) {
      const err = toAuthError(error);
      if (err.kind === "rate-limit") rateLimited++;
      failures.push(`${strategy.name}: ${err.message}`);
      continue;
    }

    const check = await verifyToken(config.domain, auth);
    if (!check.ok) {
      failures.push(`${strategy.name}: Garmin issued a token that its API then rejected (HTTP ${check.status}).`);
      continue;
    }
    return auth;
  }

  if (rateLimited > 0 && rateLimited === strategies.length) {
    throw new GarminAuthError(
      "Garmin rate-limited every sign-in method (HTTP 429). Wait an hour or so, or try from another network, then run the command again.",
      "rate-limit",
    );
  }
  throw new GarminAuthError(`Every sign-in method failed:\n  - ${failures.join("\n  - ")}`, "transport");
}
