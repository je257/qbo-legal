import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Desktop reads its config only at launch and can REWRITE the file on
// exit from its in-memory state, wiping entries added while it was running.
// Detecting a running instance lets install warn about that clobber.
export function claudeDesktopRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/NH"], {
        encoding: "utf8",
      });
      return /claude\.exe/i.test(out);
    }
    const out = execFileSync("pgrep", ["-x", "Claude"], { encoding: "utf8" });
    return out.trim() !== "";
  } catch {
    // pgrep exits non-zero on no match; any other failure means "unknown" — stay quiet.
    return false;
  }
}

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
  servers.qbo = { command: nodePath, args: [serverPath] };
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Read it back: if the existing config had an unexpected shape (e.g. "mcpServers"
  // as an array), JSON.stringify can silently drop the new entry.
  const check = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  if (!check.mcpServers?.qbo) {
    throw new Error(
      `Verification failed: ${configPath} does not contain the qbo entry.\n` +
        `That file has an unexpected structure. Open it and fix (or remove) its "mcpServers" ` +
        `section — or delete the whole file if Claude Desktop has no other connectors — then ` +
        `run \`node dist/index.js install\` again.`,
    );
  }

  console.log(`\nAdded the "qbo" QuickBooks connector to Claude Desktop:`);
  console.log(`  ${configPath}`);
  if (claudeDesktopRunning()) {
    console.log(`\n*** IMPORTANT: Claude Desktop is RUNNING right now. ***`);
    console.log(`When it exits, it can rewrite its config file and WIPE the entry just added.`);
    console.log(`Do this, in this order:`);
    console.log(`  1. Quit Claude Desktop completely (Windows: system-tray icon -> Quit, or`);
    console.log(`     Task Manager -> End task on every Claude entry. Mac: Cmd+Q).`);
    console.log(`  2. With Claude Desktop closed, run \`node dist/index.js install\` again.`);
    console.log(`  3. Only then open Claude Desktop.`);
  } else {
    console.log(`\nNow open Claude Desktop.`);
    console.log(`(If it turns out it was already running: fully quit it — system-tray icon -> Quit`);
    console.log(`on Windows, Cmd+Q on Mac — run this install again, then reopen it.)`);
  }
  console.log(`\nCheck it worked: Claude Desktop Settings -> Developer should list "qbo".`);
  console.log(`If anything is off, run: node dist/index.js doctor`);
  console.log(`Then try asking Claude: "Use qbo_company_info to show my company profile."`);
  console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
  console.log(`  claude mcp add qbo -- "${nodePath}" "${serverPath}"`);
}
