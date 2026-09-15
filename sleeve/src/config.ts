import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Reuses the key store written by ycharts-mcp's `setup` command.
const keyConfigPath = join(process.env.YCHARTS_MCP_DIR ?? join(homedir(), ".ycharts-mcp"), "config.json");

function realKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key || (key.startsWith("${") && key.endsWith("}"))) return undefined;
  return key;
}

export function loadApiKey(): string | undefined {
  const fromEnv = realKey(process.env.YCHARTS_API_KEY);
  if (fromEnv) return fromEnv;
  if (!existsSync(keyConfigPath)) return undefined;
  try {
    const stored = JSON.parse(readFileSync(keyConfigPath, "utf8")) as { apiKey?: string };
    return realKey(stored.apiKey);
  } catch {
    return undefined;
  }
}

export interface DriftBand {
  minTargetWeightPct: number;
  maxRelativeDriftPct: number;
}

export interface SleeveSettings {
  portfolioId: number | null;
  universeScreenerId: number;
  benchmark: { fundProxy: string; indexSymbol: string };
  sectorBandPct: number;
  maxActiveSharePct: number;
  driftBands: DriftBand[];
  characteristicsCalcs: string[];
  sectorCalcs: string[];
}

export function loadSettings(): SleeveSettings {
  const path = fileURLToPath(new URL("../sleeve.config.json", import.meta.url));
  const settings = JSON.parse(readFileSync(path, "utf8")) as SleeveSettings;
  settings.driftBands.sort((a, b) => b.minTargetWeightPct - a.minTargetWeightPct);
  return settings;
}
