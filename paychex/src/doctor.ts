import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_URL, fetchToken } from "./auth.js";
import { AppConfig, configDir, loadConfig } from "./config.js";
import { desktopConfigPath } from "./install.js";

const SERVER_KEY = "paychex";

let failures = 0;
let warnings = 0;

function ok(message: string): void {
  console.log(`  [ok]   ${message}`);
}

function warn(message: string): void {
  warnings += 1;
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

async function checkPaychexApi(): Promise<void> {
  let config: AppConfig | undefined;
  try {
    config = loadConfig();
  } catch {
    fail(
      "The saved credentials file is unreadable (corrupt JSON)",
      `Delete the folder ${configDir} and run \`node dist/index.js auth\` again.`,
    );
    return;
  }
  if (!config) {
    fail(
      "No Paychex credentials saved",
      "Run `node dist/index.js auth` and enter the API key and secret from developer.paychex.com.",
    );
    return;
  }
  ok(`Credentials saved in ${configDir} (API key ...${config.clientId.slice(-6)})`);

  let accessToken: string;
  try {
    accessToken = (await fetchToken(config)).accessToken;
  } catch (error) {
    fail(
      `Paychex rejected or didn't answer the credential check: ${firstLine(error)}`,
      "If it's a 400/401, the API key or secret was mistyped — run `node dist/index.js auth` " +
        "and type n to re-enter them. Otherwise check the internet connection.",
    );
    return;
  }
  ok("Paychex accepted the API key and secret");

  try {
    const res = await fetch(`${BASE_URL}/companies`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) {
      fail(
        `Company lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        "Retry in a minute; if it persists, check the application's access at developer.paychex.com.",
      );
      return;
    }
    const body = (await res.json()) as {
      content?: { companyId?: string; displayId?: string; legalName?: string }[];
    };
    const companies = body.content ?? [];
    if (companies.length === 0) {
      fail(
        "The API key works but cannot see any companies",
        "At developer.paychex.com, link your Paychex Flex company to the application — a " +
          "company admin must approve it. No re-setup needed afterward.",
      );
      return;
    }
    ok(
      `Can access ${companies.length} ${companies.length === 1 ? "company" : "companies"}: ` +
        companies.map((c) => c.legalName ?? c.displayId ?? c.companyId ?? "?").join(", "),
    );
    const savedCompanyId = config.companyId;
    if (savedCompanyId) {
      if (companies.some((c) => c.companyId === savedCompanyId)) {
        ok(`Default company: ${savedCompanyId}`);
      } else {
        fail(
          `The saved default company (${savedCompanyId}) is not among the companies this ` +
            "key can access — company-scoped tools will fail",
          "Run `node dist/index.js auth` to re-pick the default (or unset the " +
            "PAYCHEX_COMPANY_ID environment variable if you set one).",
        );
      }
    } else if (companies.length > 1) {
      warn(
        "No default company saved — run `node dist/index.js auth` to pick one, or pass " +
          "companyId in tool calls.",
      );
    }
  } catch (error) {
    fail(`Company lookup failed: ${firstLine(error)}`, "Check the internet connection and retry.");
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
      "Quit Claude Desktop completely FIRST (Windows: Task Manager -> End task on every " +
        "Claude entry), then run `node dist/index.js install`, then reopen Claude Desktop. " +
        "Order matters: Claude Desktop can wipe entries added while it is running.",
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
  failures = 0;
  warnings = 0;
  console.log("Paychex connector checkup\n");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) {
    ok(`Node.js ${process.versions.node}`);
  } else {
    fail(
      `Node.js ${process.versions.node} is too old (need 18+)`,
      "Install the LTS version from nodejs.org, then open a fresh terminal.",
    );
  }

  await checkPaychexApi();
  checkClaudeDesktop();

  console.log("");
  if (failures > 0) {
    console.log(`${failures} problem(s) found — apply the fixes above, then run this again.`);
    process.exitCode = 1;
    return;
  }
  if (warnings > 0) {
    console.log(
      `No hard failures, but ${warnings} warning(s) above — read them before assuming all is well.`,
    );
    console.log("");
  } else {
    console.log("Everything checks out.");
  }
  console.log("If Claude still doesn't show the paychex tools:");
  console.log("  - Fully quit Claude Desktop (Windows: system-tray icon -> Quit; Mac: Cmd+Q)");
  console.log("    and reopen it — closing the window is not enough.");
  console.log("  - Local connectors appear in the Claude DESKTOP app (and Claude Code),");
  console.log("    never on claude.ai in a web browser.");
  console.log('  - Check Settings -> Developer in Claude Desktop: "paychex" should be listed.');
}
