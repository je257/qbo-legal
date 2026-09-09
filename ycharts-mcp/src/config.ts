import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  apiKey: string;
  /** API host, no trailing slash, e.g. "https://api.ycharts.com" */
  baseUrl: string;
  /** API version path segment, e.g. "v4" */
  apiVersion: string;
}

export const DEFAULT_BASE_URL = "https://api.ycharts.com";
export const DEFAULT_API_VERSION = "v4";

/**
 * Base/version combinations probed during `auth` and `status`, most likely
 * first. YCharts has served the API from both hosts across versions, so the
 * auth flow discovers which combination the account's key actually works
 * against and stores it.
 */
export const BASE_CANDIDATES: ReadonlyArray<{ baseUrl: string; apiVersion: string }> = [
  { baseUrl: "https://api.ycharts.com", apiVersion: "v4" },
  { baseUrl: "https://ycharts.com/api", apiVersion: "v4" },
  { baseUrl: "https://api.ycharts.com", apiVersion: "v3" },
  { baseUrl: "https://ycharts.com/api", apiVersion: "v3" },
];

export const configDir = process.env.YCHARTS_MCP_DIR ?? join(homedir(), ".ycharts-mcp");
const configPath = join(configDir, "config.json");

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
  const apiKey = process.env.YCHARTS_API_KEY ?? stored.apiKey;
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: (process.env.YCHARTS_BASE_URL ?? stored.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiVersion: process.env.YCHARTS_API_VERSION ?? stored.apiVersion ?? DEFAULT_API_VERSION,
  };
}

export function saveConfig(config: AppConfig): void {
  writeJson(configPath, config);
}
