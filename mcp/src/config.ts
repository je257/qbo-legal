import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  environment: "production" | "sandbox";
  redirectUri: string;
}

export interface TokenSet {
  realmId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export const DEFAULT_REDIRECT_URI = "https://je257.github.io/qbo-legal/callback.html";

export const configDir = process.env.QBO_MCP_DIR ?? join(homedir(), ".qbo-mcp");
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

export function loadConfig(): AppConfig | undefined {
  const stored = readJson<Partial<AppConfig>>(configPath) ?? {};
  const clientId = process.env.QBO_CLIENT_ID ?? stored.clientId;
  const clientSecret = process.env.QBO_CLIENT_SECRET ?? stored.clientSecret;
  if (!clientId || !clientSecret) return undefined;
  const env = (process.env.QBO_ENV ?? stored.environment) === "sandbox" ? "sandbox" : "production";
  return {
    clientId,
    clientSecret,
    environment: env,
    redirectUri: process.env.QBO_REDIRECT_URI ?? stored.redirectUri ?? DEFAULT_REDIRECT_URI,
  };
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
