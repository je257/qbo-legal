import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function desktopConfigPath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export function runInstall(): void {
  const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const nodePath = process.execPath;
  const configPath = desktopConfigPath();

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    if (raw.trim() !== "") {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Your Claude Desktop config file has invalid JSON, so it was left untouched:\n` +
            `  ${configPath}\n` +
            `Fix or delete that file, then run this command again.`,
        );
      }
    }
    copyFileSync(configPath, `${configPath}.backup`);
    console.log(`Backed up existing config to ${configPath}.backup`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.ninety = { command: nodePath, args: [serverPath] };
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\nAdded the "ninety" connector to Claude Desktop:`);
  console.log(`  ${configPath}`);
  console.log(`\nNow fully quit Claude Desktop and open it again.`);
  console.log(`Then try asking Claude: "Use ninety_teams to list my Ninety teams."`);
  console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
  console.log(`  claude mcp add ninety -- "${nodePath}" "${serverPath}"`);
}
