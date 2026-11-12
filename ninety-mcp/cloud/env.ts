import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { DEFAULT_BASE_URL } from "../src/constants.js";

// Settings of the hosted connector. Secrets are set in the Cloudflare dashboard (or with
// `wrangler secret put`); plain variables live in wrangler.jsonc.

export interface Env {
  /** Storage for sign-ins: registered apps, grants and tokens (stored as hashes). */
  OAUTH_KV: KVNamespace;
  /** Added by the OAuth library for the pages it does not own (the sign-in page). */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Per-address limit on sign-in attempts, sign-in page views and app registrations. */
  LOGIN_LIMITER?: RateLimit;
  /** Limit on sign-in attempts from all addresses together. */
  LOGIN_LIMITER_GLOBAL?: RateLimit;

  /** SECRET. The Ninety Personal Access Token the connector acts with. */
  NINETY_API_TOKEN?: string;
  /** SECRET. What the owner types on the sign-in page. At least 16 characters. */
  CONNECTOR_PASSWORD?: string;

  /** "true" offers the six delete tools. Off unless set. */
  ENABLE_DELETE_TOOLS?: string;
  /** "true" offers ninety_request, the raw "any endpoint" tool. Off unless set. */
  ENABLE_RAW_REQUEST?: string;
  /** Comma-separated exact redirect addresses allowed to receive a sign-in, replacing the default. */
  ALLOWED_REDIRECT_URIS?: string;
  /**
   * Comma-separated IPv4 ranges (like 160.79.104.0/21) that may register an app, replacing the
   * default (Anthropic's published ranges). "*" lets anyone register.
   */
  REGISTRATION_SOURCES?: string;
  /** For tests only: send API calls to a local fake instead of Ninety. */
  NINETY_API_BASE_URL?: string;
}

/** The single permission this connector grants. */
export const SCOPE = "ninety";
/** The one user: whoever knows the connector password. */
export const OWNER_ID = "owner";
export const MIN_PASSWORD_LENGTH = 16;

/** Where Claude's hosted apps (web, desktop, mobile) receive the sign-in result. */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export function isOn(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function allowedRedirectUris(env: Pick<Env, "ALLOWED_REDIRECT_URIS">): string[] {
  const configured = (env.ALLOWED_REDIRECT_URIS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return configured.length > 0 ? configured : DEFAULT_REDIRECT_URIS;
}

/** Exact match only: no prefixes, no wildcards. */
export function isAllowedRedirect(uri: string, env: Pick<Env, "ALLOWED_REDIRECT_URIS">): boolean {
  return allowedRedirectUris(env).includes(uri);
}

/** The connector password, or undefined when it is missing or too short to be allowed. */
export function connectorPassword(env: Pick<Env, "CONNECTOR_PASSWORD">): string | undefined {
  const password = (env.CONNECTOR_PASSWORD ?? "").trim();
  return password.length >= MIN_PASSWORD_LENGTH ? password : undefined;
}

export function ninetyToken(env: Pick<Env, "NINETY_API_TOKEN">): string | undefined {
  const token = (env.NINETY_API_TOKEN ?? "").trim();
  return token === "" ? undefined : token;
}

/** Ninety's API, unless a test points the Worker at a fake on this machine. */
export function apiBaseUrl(env: Pick<Env, "NINETY_API_BASE_URL">): string {
  const override = (env.NINETY_API_BASE_URL ?? "").trim();
  if (override === "") return DEFAULT_BASE_URL;
  try {
    const url = new URL(override);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // The token is sent to this address, so only a local test fake may replace the real API.
    if (url.protocol === "http:" && loopback) return override.replace(/\/+$/, "");
  } catch {
    // fall through
  }
  return DEFAULT_BASE_URL;
}

/** Constant-time comparison of two secrets, by comparing their SHA-256 digests. */
export async function sameSecret(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/** True when this caller has used up its allowance. Without the binding there is no limit. */
export async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

export function callerAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The addresses Claude's servers call from, as Anthropic publishes them for allow-listing
 * (https://platform.claude.com/docs/en/api/ip-addresses). Claude's registrations, token requests
 * and tool calls come from inside them.
 */
export const ANTHROPIC_SOURCES = ["160.79.104.0/21", "153.61.208.0/20"];

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

function insideRange(address: string, range: string): boolean {
  const [base, bitsText = "32"] = range.split("/");
  // An empty or malformed size must match nothing. Number("") is 0, which would mean "everyone".
  if (!/^\d{1,2}$/.test(bitsText.trim())) return false;
  const value = ipv4ToNumber(address);
  const network = ipv4ToNumber(base);
  const bits = Number(bitsText);
  if (value === undefined || network === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(network / size);
}

/**
 * May this caller register an app? Only Claude's servers need to. Each registration is a write to
 * storage, and the free plan allows 1,000 writes a day, so letting anyone register would let anyone
 * use that up and stop the connector renewing its sign-in.
 */
export function mayRegister(request: Request, env: Pick<Env, "REGISTRATION_SOURCES">): boolean {
  const configured = (env.REGISTRATION_SOURCES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const sources = configured.length > 0 ? configured : ANTHROPIC_SOURCES;
  if (sources.includes("*")) return true;
  const address = request.headers.get("CF-Connecting-IP");
  // Cloudflare always names the caller, and never as this machine. Without a caller, or with this
  // machine as the caller, it is a local test: allowed only when the Worker itself is local.
  if (!address || address === "127.0.0.1" || address === "::1") {
    return isLoopbackHost(new URL(request.url).hostname);
  }
  return sources.some((range) => insideRange(address, range));
}

/** What a connection carries from the moment it is made. */
export interface ConnectionProps {
  owner?: boolean;
  /** Fingerprint of the connector password the connection was made with. */
  pw?: string;
}

const fingerprints = new Map<string, string>();

/**
 * A short fingerprint of the connector password, stored with each connection. A connection whose
 * fingerprint no longer matches the saved password is refused, so changing the password ends every
 * connection at once. Undefined when no usable password is saved.
 */
export async function passwordFingerprint(env: Pick<Env, "CONNECTOR_PASSWORD">): Promise<string | undefined> {
  const password = connectorPassword(env);
  if (!password) return undefined;
  let fingerprint = fingerprints.get(password);
  if (!fingerprint) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`ninety-connector/password-fingerprint/v1:${password}`),
    );
    fingerprint = btoa(String.fromCharCode(...new Uint8Array(digest).slice(0, 16)));
    if (fingerprints.size >= 4) fingerprints.clear();
    fingerprints.set(password, fingerprint);
  }
  return fingerprint;
}
