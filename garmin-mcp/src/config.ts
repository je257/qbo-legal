import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Garmin region. "garmin.com" for everyone outside mainland China. */
export type GarminDomain = "garmin.com" | "garmin.cn";

export interface AppConfig {
  domain: GarminDomain;
  /** OAuth1 consumer key/secret used by the Garmin Connect mobile app. */
  consumerKey: string;
  consumerSecret: string;
}

/** Long-lived (about a year) OAuth1 token returned by Garmin SSO. */
export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
  mfa_expiration_timestamp?: string;
}

/** Short-lived (about an hour) bearer token used for connectapi calls. */
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

export interface Profile {
  /** The UUID-like identifier Garmin uses in many API paths. */
  displayName: string;
  userName?: string;
  fullName?: string;
  profileId?: number;
  userProfileId?: number;
}

export interface TokenSet {
  domain: GarminDomain;
  email?: string;
  oauth1: OAuth1Token;
  oauth2: OAuth2Token;
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

/**
 * Loads the app configuration. Environment variables win over the stored
 * file. Returns undefined when the OAuth consumer credentials are not yet
 * known (they are fetched on the first `auth` run).
 */
export function loadConfig(): AppConfig | undefined {
  const stored = readJson<Partial<AppConfig>>(configPath) ?? {};
  const consumerKey = process.env.GARMIN_OAUTH_CONSUMER_KEY ?? stored.consumerKey;
  const consumerSecret = process.env.GARMIN_OAUTH_CONSUMER_SECRET ?? stored.consumerSecret;
  if (!consumerKey || !consumerSecret) return undefined;
  return {
    domain: resolveDomain(process.env.GARMIN_DOMAIN ?? stored.domain),
    consumerKey,
    consumerSecret,
  };
}

export function loadStoredDomain(): GarminDomain | undefined {
  const stored = readJson<Partial<AppConfig>>(configPath);
  return stored?.domain ? resolveDomain(stored.domain) : undefined;
}

export function saveConfig(config: AppConfig): void {
  writeJson(configPath, config);
}

export function loadTokens(): TokenSet | undefined {
  return readJson<TokenSet>(tokenPath);
}

export function saveTokens(tokens: TokenSet): void {
  writeJson(tokenPath, tokens);
}
