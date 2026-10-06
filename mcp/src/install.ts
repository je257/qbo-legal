import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
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

/**
 * Claude Desktop keeps its own settings in the same config file and rewrites
 * the whole file from memory when it quits, which silently erases any entry
 * added while it is running. So the entry must be written while Desktop is
 * closed.
 */
async function ensureDesktopClosed(): Promise<boolean> {
  if (!desktopRunning()) return true;
  console.log(
    "\nClaude Desktop is running. It rewrites its config file when it quits, which would erase this change.",
  );
  if (!process.stdin.isTTY) {
    console.log("Writing anyway (no terminal to wait in). If the connector does not appear, quit Claude Desktop and run `install` again.");
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const answer = (
        await rl.question(
          "Quit Claude Desktop completely (right-click its icon in the system tray / menu bar and choose Quit), " +
            "then press Enter to continue, or type s to skip: ",
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "s" || answer === "skip") return false;
      if (!desktopRunning()) return true;
      console.log("Claude Desktop still appears to be running (look for 'Claude' in Task Manager or Activity Monitor).");
    }
  } finally {
    rl.close();
  }
  return false;
}

function printManualInstructions(configPath: string, entry: unknown): void {
  console.log(`\nNot written. To add it by hand: quit Claude Desktop, open Settings → Developer → Edit Config`);
  console.log(`(the file is ${configPath}) and add this inside "mcpServers":\n`);
  console.log(`  "${SERVER_KEY}": ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n  ")}`);
  console.log(`\nThen start Claude Desktop. Or quit Claude Desktop and run: node dist/index.js install`);
}

export async function runInstall(): Promise<void> {
  const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const nodePath = process.execPath;
  const configPath = desktopConfigPath();
  const entry = { command: nodePath, args: [serverPath] };

  if (!(await ensureDesktopClosed())) {
    printManualInstructions(configPath, entry);
    console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
    console.log(`  claude mcp add ${SERVER_KEY} -- "${nodePath}" "${serverPath}"`);
    return;
  }

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

  console.log(`\nAdded the "${SERVER_KEY}" ${SERVER_LABEL} connector to Claude Desktop:`);
  console.log(`  ${configPath}`);
  console.log(`\nNow open Claude Desktop. It appears under Settings → Developer.`);
  console.log(`Then try asking Claude: "${TRY_PROMPT}"`);
  console.log(`\nUsing Claude Code instead? Copy and run this one line:`);
  console.log(`  claude mcp add ${SERVER_KEY} -- "${nodePath}" "${serverPath}"`);
}
