import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDir, loadConfig, loadTokens } from "./config.js";
import { desktopConfigPath } from "./install.js";
import { QboClient, QboError } from "./qbo.js";

const SERVER_KEY = "qbo";

let failures = 0;

function ok(message: string): void {
  console.log(`  [ok]   ${message}`);
}

function warn(message: string): void {
  console.log(`  [warn] ${message}`);
}

function fail(message: string, fix: string): void {
  failures += 1;
  console.log(`  [FAIL] ${message}`);
  console.log(`         Fix: ${fix}`);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

async function checkQboApi(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    fail(
      "No QuickBooks app credentials saved",
      "Run `node dist/index.js auth` and enter the Client ID and Client Secret from " +
        "developer.intuit.com.",
    );
    return;
  }
  ok(
    `Credentials saved in ${configDir} (Client ID ...${config.clientId.slice(-6)}, ` +
      `${config.environment})`,
  );

  const tokens = loadTokens();
  if (!tokens) {
    fail(
      "No QuickBooks company is connected",
      "Run `node dist/index.js auth` to sign in and authorize your company.",
    );
    return;
  }
  if (Date.now() > tokens.refreshTokenExpiresAt) {
    fail(
      `The connection expired on ${new Date(tokens.refreshTokenExpiresAt).toDateString()} ` +
        "(the refresh token lapses after ~100 days of no use)",
      "Run `node dist/index.js auth` to reconnect.",
    );
    return;
  }
  ok(
    `Company ${tokens.realmId} connected (renewable until ` +
      `${new Date(tokens.refreshTokenExpiresAt).toDateString()})`,
  );

  try {
    const info = (await QboClient.load().companyInfo()) as {
      CompanyInfo?: { CompanyName?: string };
    };
    const name = info.CompanyInfo?.CompanyName;
    ok(`QuickBooks answered${name ? `: ${name}` : ""}`);
  } catch (error) {
    fail(
      `QuickBooks API check failed: ${firstLine(error)}`,
      error instanceof QboError
        ? "Follow the message above (usually `node dist/index.js auth` to reconnect)."
        : "Check the internet connection and retry.",
    );
  }
}

function checkClaudeDesktop(): void {
  const desktopPath = desktopConfigPath();
  const thisServer = fileURLToPath(new URL("./index.js", import.meta.url));

  if (!existsSync(desktopPath)) {
    fail(
      `Claude Desktop config not found (${desktopPath})`,
      "Run `node dist/index.js install`. If Claude Desktop isn't installed on this machine, " +
        "install it first from claude.ai/download.",
    );
    return;
  }

  let desktop: { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  try {
    desktop = JSON.parse(readFileSync(desktopPath, "utf8")) as typeof desktop;
  } catch {
    fail(
      `Claude Desktop config has invalid JSON (${desktopPath})`,
      "Fix or delete that file, then run `node dist/index.js install`.",
    );
    return;
  }

  const entry = desktop.mcpServers?.[SERVER_KEY];
  if (!entry) {
    fail(
      `"${SERVER_KEY}" is not registered in Claude Desktop — this is why the tools are missing`,
      "Run `node dist/index.js install`, then fully quit and reopen Claude Desktop.",
    );
    return;
  }

  const target = entry.args?.[0];
  if (!target || !existsSync(target)) {
    fail(
      `Claude Desktop points at a file that doesn't exist: ${target ?? "(none)"}`,
      "The project folder was moved, renamed, or deleted. Run `node dist/index.js install` " +
        "from this folder to re-register.",
    );
  } else if (target !== thisServer) {
    warn(
      `Claude Desktop runs a different copy of the connector:\n` +
        `           registered: ${target}\n` +
        `           this folder: ${thisServer}\n` +
        `         If this folder is the one you maintain, run \`node dist/index.js install\` here.`,
    );
  } else {
    ok(`Registered in Claude Desktop (${desktopPath})`);
  }

  if (entry.command && entry.command !== "node" && !existsSync(entry.command)) {
    fail(
      `Claude Desktop's Node.js path no longer exists: ${entry.command}`,
      "Node.js was moved or reinstalled. Run `node dist/index.js install` to re-register.",
    );
  }
}

export async function runDoctor(): Promise<void> {
  console.log("QuickBooks connector checkup\n");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) {
    ok(`Node.js ${process.versions.node}`);
  } else {
    fail(
      `Node.js ${process.versions.node} is too old (need 18+)`,
      "Install the LTS version from nodejs.org, then open a fresh terminal.",
    );
  }

  await checkQboApi();
  checkClaudeDesktop();

  console.log("");
  if (failures === 0) {
    console.log("Everything checks out. If Claude still doesn't show the qbo tools:");
    console.log("  - Fully quit Claude Desktop (Windows: system-tray icon -> Quit; Mac: Cmd+Q)");
    console.log("    and reopen it — closing the window is not enough.");
    console.log("  - Local connectors appear in the Claude DESKTOP app (and Claude Code),");
    console.log("    never on claude.ai in a web browser.");
    console.log('  - Check Settings -> Developer in Claude Desktop: "qbo" should be listed.');
  } else {
    console.log(`${failures} problem(s) found — apply the fixes above, then run this again.`);
    process.exitCode = 1;
  }
}
