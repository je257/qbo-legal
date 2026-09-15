#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { configPath, keySource, loadApiKey, maskKey, saveApiKey } from "./config.js";
import { runDiagnostics } from "./diagnose.js";
import { runInstall } from "./install.js";
import { startServer } from "./server.js";
import { YchartsClient } from "./ycharts.js";

const command = process.argv[2] ?? "serve";

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const key = (await rl.question("Paste your YCharts API key: ")).trim();
    if (!key) throw new Error("No key entered — nothing saved.");
    const path = saveApiKey(key);
    console.log(`\nSaved ${maskKey(key)} to ${path} (owner-only permissions).`);
    console.log(`Tip: the YCHARTS_API_KEY environment variable, when set, takes precedence over this file.`);
    console.log(`\nNext: node dist/index.js diagnose   (maps what this key can access)`);
    console.log(`Then: node dist/index.js install     (adds the connector to Claude Desktop / prints the Claude Code line)`);
  } finally {
    rl.close();
  }
}

async function runDiagnoseCli(): Promise<void> {
  const report = await runDiagnostics(YchartsClient.load());
  for (const probe of report.probes) {
    console.log(`${probe.ok ? "PASS" : "FAIL"}  ${probe.probe}`);
    console.log(`      ${probe.note}`);
  }
  console.log("\nSummary:");
  for (const line of report.summary) console.log(`- ${line}`);
}

function printStatus(): void {
  const key = loadApiKey();
  if (!key) {
    console.log("Not configured. Set YCHARTS_API_KEY or run: node dist/index.js setup");
    return;
  }
  console.log(`API key: ${maskKey(key)} (source: ${keySource()})`);
  console.log(`Config file: ${configPath}`);
}

switch (command) {
  case "setup":
    runSetup().catch(fail);
    break;
  case "status":
    printStatus();
    break;
  case "diagnose":
    runDiagnoseCli().catch(fail);
    break;
  case "install":
    try {
      runInstall();
    } catch (error) {
      fail(error);
    }
    break;
  case "serve":
    startServer().catch(fail);
    break;
  default:
    console.error(`Unknown command: ${command}\nUsage: ycharts-mcp [setup|status|diagnose|install|serve]`);
    process.exit(1);
}
