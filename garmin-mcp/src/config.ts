import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Garmin region. "garmin.com" for everyone outside mainland China. */
export type GarminDomain = "garmin.com" | "garmin.cn";

export interface AppConfig {
  domain: GarminDomain;
  /**
   * OAuth1 consumer key/secret of the Garmin Connect mobile app. Only needed
   * for the fallback token exchange; fetched and cached on first use.
   */
  consumerKey?: string;
  consumerSecret?: string;
}

/** Garmin "DI" OAuth2 bearer token (primary method; refreshes indefinitely). */
export interface DiToken {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  /** Unix seconds, from the JWT's exp claim. */
  expiresAt?: number;
}

/** Long-lived (about a year) OAuth1 token (fallback method). */
export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
  mfa_expiration_timestamp?: string;
}

/** Short-lived bearer token derived from the OAuth1 token (fallback method). */
export interface OAuth2Token {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  jti?: string;
  /** Unix seconds */
  expires_at: number;
  /** Unix seconds */
  refresh_token_expires_at?: number;
}

export type AuthTokens =
  | { method: "di"; di: DiToken }
  | { method: "oauth1"; oauth1: OAuth1Token; oauth2: OAuth2Token };

export interface Profile {
  /** The identifier Garmin uses in many API paths. */
  displayName: string;
  userName?: string;
  fullName?: string;
  profileId?: number;
  userProfileId?: number;
}

export interface TokenSet {
  domain: GarminDomain;
  email?: string;
  auth: AuthTokens;
  profile?: Profile;
  createdAt: number;
}

export const configDir = process.env.GARMIN_MCP_DIR ?? join(homedir(), ".garmin-mcp");
export const downloadsDir = join(configDir, "downloads");
const configPath = join(configDir, "config.json");
const tokenPath = join(configDir, "tokens.json");

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveDomain(value: string | undefined): GarminDomain {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "garmin.cn" || v === "cn" || v === "china") return "garmin.cn";
  return "garmin.com";
}

/** Loads the app configuration. Environment variables win over the stored file. */
export function loadConfig(): AppConfig {
  const stored = readJson<Partial<AppConfig>>(configPath) ?? {};
  return {
    domain: resolveDomain(process.env.GARMIN_DOMAIN ?? stored.domain),
    consumerKey: process.env.GARMIN_OAUTH_CONSUMER_KEY ?? stored.consumerKey,
    consumerSecret: process.env.GARMIN_OAUTH_CONSUMER_SECRET ?? stored.consumerSecret,
  };
}

export function hasStoredDomain(): boolean {
  return Boolean(readJson<Partial<AppConfig>>(configPath)?.domain);
}

export function saveConfig(config: AppConfig): void {
  writeJson(configPath, config);
}

export function loadTokens(): TokenSet | undefined {
  const tokens = readJson<Partial<TokenSet>>(tokenPath);
  if (!tokens?.auth?.method) return undefined;
  return tokens as TokenSet;
}

export function saveTokens(tokens: TokenSet): void {
  writeJson(tokenPath, tokens);
}

/**
 * Garmin returns mfa_expiration_timestamp as a naive datetime string such as
 * "2027-10-06 12:34:56.789" (garth's recorded responses). Returns epoch
 * milliseconds, or undefined when absent or unparseable.
 */
export function parseMfaExpiry(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return v.length >= 13 ? n : n * 1000;
  }
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? v.replace(" ", "T") + "Z" : v;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}
