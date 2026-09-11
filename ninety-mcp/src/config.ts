import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  token: string;
  savedAt?: string;
}

export const DEFAULT_BASE_URL = "https://api.public.ninety.io";

export const configDir = process.env.NINETY_MCP_DIR ?? join(homedir(), ".ninety-mcp");
const configPath = join(configDir, "config.json");

export const DEVELOPER_SETTINGS_URL = "https://app.ninety.io/settings/user/developer-settings";

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function baseUrl(): string {
  return (process.env.NINETY_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Token precedence: NINETY_API_TOKEN env var, then ~/.ninety-mcp/config.json. */
export function loadToken(): string | undefined {
  const fromEnv = process.env.NINETY_API_TOKEN;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  return readJson<Partial<AppConfig>>(configPath)?.token;
}

export function tokenSource(): "env" | "file" | undefined {
  const fromEnv = process.env.NINETY_API_TOKEN;
  if (fromEnv && fromEnv.trim() !== "") return "env";
  if (readJson<Partial<AppConfig>>(configPath)?.token) return "file";
  return undefined;
}

export function saveToken(token: string): void {
  writeJson(configPath, { token, savedAt: new Date().toISOString() } satisfies AppConfig);
}
