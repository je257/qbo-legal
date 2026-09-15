import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function desktopConfigPath(): string {
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
  servers.paychex = { command: nodePath, args: [serverPath] };
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Read it back: if the existing config had an unexpected shape (e.g. "mcpServers"
  // as an array), JSON.stringify can silently drop the new entry.
  const check = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  if (!check.mcpServers?.paychex) {
    throw new Error(
      `Verification failed: ${configPath} does not contain the paychex entry.\n` +
        `That file has an unexpected structure. Open it and fix (or remove) its "mcpServers" ` +
        `section — or delete the whole file if Claude Desktop has no other connectors — then ` +
        `run \`node dist/index.js install\` again.`,
    );
  }

  console.log(`\nAdded the "paychex" Paychex Flex connector to Claude Desktop:`);
  console.log(`  ${configPath}`);
  console.log(`\nNow fully quit Claude Desktop and open it again`);
  console.log(`(Windows: system-tray Claude icon -> Quit. Mac: Cmd+Q. Closing the window is not enough).`);
  console.log(`Check it worked: Claude Desktop Settings -> Developer should list "paychex".`);
  console.log(`If anything is off, run: node dist/index.js doctor`);
  console.log(`Then try asking Claude: "Use paychex_companies to list my payroll companies."`);
  console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
  console.log(`  claude mcp add paychex -- "${nodePath}" "${serverPath}"`);
}
