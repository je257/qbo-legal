import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_KEY = "qbo";
const SERVER_LABEL = "QuickBooks";
const TRY_PROMPT = "Use qbo_company_info to show my company profile.";

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

/** Best-effort check for a running Claude Desktop (Windows and macOS). */
function desktopRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Claude.exe", "/NH"], { encoding: "utf8", windowsHide: true });
      return /claude\.exe/i.test(out);
    }
    if (process.platform === "darwin") {
      execFileSync("pgrep", ["-x", "Claude"], { stdio: "ignore" });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function runInstall(): Promise<void> {
  const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const nodePath = process.execPath;
  const configPath = desktopConfigPath();
  const entry = { command: nodePath, args: [serverPath] };

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
  servers[SERVER_KEY] = entry;
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\nAdded the "${SERVER_KEY}" ${SERVER_LABEL} connector to Claude Desktop's config:`);
  console.log(`  ${configPath}`);
  if (desktopRunning()) {
    console.log(`\nClaude Desktop is running: quit it completely (system tray / menu bar icon -> Quit) and open it again.`);
  } else {
    console.log(`\nNow open Claude Desktop.`);
  }
  console.log(`The connector is listed under Settings -> Developer (not Connectors or Extensions).`);
  console.log(`Then try asking Claude: "${TRY_PROMPT}"`);

  // Claude Desktop does not always pick up an entry written from outside the
  // app. The edit it always honours is the one made through its own
  // Settings -> Developer -> Edit config button, so print that fallback.
  console.log(`\nIf "${SERVER_KEY}" is NOT listed under Settings -> Developer, add it there by hand:`);
  console.log(`  1. Settings -> Developer -> Edit config, then open claude_desktop_config.json in a text editor.`);
  console.log(`  2. Inside "mcpServers", add this entry (add a comma after the entry before it):\n`);
  console.log(`    "${SERVER_KEY}": ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n    ")}`);
  console.log(`\n  3. Save, then quit Claude Desktop completely and open it again.`);

  console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
  console.log(`  claude mcp add ${SERVER_KEY} -- "${nodePath}" "${serverPath}"`);
}
