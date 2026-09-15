import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = process.env.YCHARTS_MCP_DIR ?? join(homedir(), ".ycharts-mcp");
export const configPath = join(configDir, "config.json");

interface StoredConfig {
  apiKey?: string;
}

export function loadApiKey(): string | undefined {
  const fromEnv = process.env.YCHARTS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(configPath)) return undefined;
  try {
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as StoredConfig;
    const key = stored.apiKey?.trim();
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}

export function keySource(): "env" | "file" | "none" {
  if (process.env.YCHARTS_API_KEY?.trim()) return "env";
  if (loadApiKey()) return "file";
  return "none";
}

export function saveApiKey(apiKey: string): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({ apiKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return configPath;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
