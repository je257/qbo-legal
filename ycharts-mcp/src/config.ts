import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  apiKey: string;
  /** Host serving the v4 API, no trailing slash, e.g. "https://api.ycharts.com". */
  v4BaseUrl: string;
  /** Host serving the legacy v3 data API, no trailing slash (may differ from v4). */
  v3BaseUrl: string;
}

export const DEFAULT_V4_BASE_URL = "https://api.ycharts.com";
export const DEFAULT_V3_BASE_URL = "https://api.ycharts.com";

/**
 * Base/version combinations probed during `auth` and `status`. v4 is served
 * from api.ycharts.com (per its OpenAPI docs); the legacy v3 data API has
 * been served from both hosts, so both are probed. auth stores the working
 * host per API generation — v4 tools always request /v4/ paths and v3 tools
 * /v3/ paths, whatever the probe finds.
 */
export const BASE_CANDIDATES: ReadonlyArray<{ baseUrl: string; apiVersion: string }> = [
  { baseUrl: "https://api.ycharts.com", apiVersion: "v4" },
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

/** Env var read that treats empty/whitespace values as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(): AppConfig | undefined {
  const stored = readJson<Partial<AppConfig>>(configPath) ?? {};
  const apiKey = env("YCHARTS_API_KEY") ?? stored.apiKey;
  if (!apiKey) return undefined;
  const v4BaseUrl = stripSlash(env("YCHARTS_BASE_URL") ?? stored.v4BaseUrl ?? DEFAULT_V4_BASE_URL);
  return {
    apiKey,
    v4BaseUrl,
    v3BaseUrl: stripSlash(env("YCHARTS_V3_BASE_URL") ?? stored.v3BaseUrl ?? v4BaseUrl),
  };
}

export function saveConfig(config: AppConfig): void {
  writeJson(configPath, config);
}
