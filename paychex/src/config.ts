import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  /** Default Paychex company used when a tool call doesn't name one. */
  companyId?: string;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export const configDir = process.env.PAYCHEX_MCP_DIR ?? join(homedir(), ".paychex-mcp");
const configPath = join(configDir, "config.json");
const tokenPath = join(configDir, "token.json");

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
  const clientId = process.env.PAYCHEX_CLIENT_ID ?? stored.clientId;
  const clientSecret = process.env.PAYCHEX_CLIENT_SECRET ?? stored.clientSecret;
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId,
    clientSecret,
    companyId: process.env.PAYCHEX_COMPANY_ID ?? stored.companyId,
  };
}

export function saveConfig(config: AppConfig): void {
  writeJson(configPath, config);
}

export function loadToken(): CachedToken | undefined {
  return readJson<CachedToken>(tokenPath);
}

export function saveToken(token: CachedToken): void {
  writeJson(tokenPath, token);
}
