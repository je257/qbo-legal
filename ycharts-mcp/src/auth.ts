import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BASE_CANDIDATES, DEFAULT_API_VERSION, DEFAULT_BASE_URL, configDir, loadConfig, saveConfig } from "./config.js";
import { probeApi } from "./ycharts.js";

export async function runAuthFlow(): Promise<void> {
  console.log("YCharts connector setup");
  console.log("-----------------------");
  console.log(
    "You need a YCharts API key. API access is a YCharts add-on — the key comes from\n" +
      "your YCharts account manager / support (docs and sandbox: https://ycharts.com/v4/docs).\n",
  );

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const existing = loadConfig();
    const promptSuffix = existing ? " (press Enter to keep the saved key)" : "";
    let apiKey = (await rl.question(`YCharts API key${promptSuffix}: `)).trim();
    if (!apiKey && existing) apiKey = existing.apiKey;
    if (!apiKey) throw new Error("No API key entered.");

    console.log("\nVerifying the key against known YCharts API endpoints...");
    const outcome = await probeApi(apiKey);

    if (outcome.working) {
      saveConfig({ apiKey, baseUrl: outcome.working.baseUrl, apiVersion: outcome.working.apiVersion });
      console.log(
        `\n✓ Connected: ${outcome.working.baseUrl}/${outcome.working.apiVersion}` +
          `\n  Key saved to ${configDir}/config.json (owner-only permissions).`,
      );
      return;
    }

    if (outcome.keyRejected) {
      console.error("\n✗ YCharts rejected this API key (HTTP 401). Nothing was saved.");
      console.error("  Double-check the key, or contact YCharts support if it should be active.");
      for (const r of outcome.results) console.error(`  - ${r.baseUrl}/${r.apiVersion}: ${r.detail}`);
      process.exitCode = 1;
      return;
    }

    // Could not reach the API at all (offline, firewall, or endpoints moved).
    // Save with defaults so the server is usable once the network allows it.
    console.warn("\n! Could not verify the key against any known endpoint:");
    for (const r of outcome.results) console.warn(`  - ${r.baseUrl}/${r.apiVersion}: ${r.detail}`);
    const answer = (await rl.question("\nSave the key anyway with default settings? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      saveConfig({ apiKey, baseUrl: DEFAULT_BASE_URL, apiVersion: DEFAULT_API_VERSION });
      console.log(`Saved to ${configDir}/config.json. Run \`node dist/index.js status\` later to re-verify,`);
      console.log("or override the endpoint with YCHARTS_BASE_URL / YCHARTS_API_VERSION.");
    } else {
      console.log("Nothing saved.");
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

export async function printStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Not configured. Run `node dist/index.js auth` to store your YCharts API key.");
    return;
  }
  console.log(`Configured endpoint: ${config.baseUrl}/${config.apiVersion}`);
  console.log(`API key: ${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)} (from ${process.env.YCHARTS_API_KEY ? "YCHARTS_API_KEY env var" : configDir + "/config.json"})`);
  console.log("Checking connectivity...");

  const outcome = await probeApi(config.apiKey, [
    { baseUrl: config.baseUrl, apiVersion: config.apiVersion },
    ...BASE_CANDIDATES.filter((c) => c.baseUrl !== config.baseUrl || c.apiVersion !== config.apiVersion),
  ]);

  if (outcome.working) {
    const w = outcome.working;
    if (w.baseUrl === config.baseUrl && w.apiVersion === config.apiVersion) {
      console.log(`✓ Connected: ${w.baseUrl}/${w.apiVersion}`);
    } else {
      console.log(`✓ Key works, but against ${w.baseUrl}/${w.apiVersion} (not the configured endpoint).`);
      console.log("  Re-run `node dist/index.js auth` to save the working endpoint.");
    }
  } else if (outcome.keyRejected) {
    console.log("✗ The API key was rejected (HTTP 401). Re-run `node dist/index.js auth`.");
  } else {
    console.log("✗ Could not reach the YCharts API:");
    for (const r of outcome.results) console.log(`  - ${r.baseUrl}/${r.apiVersion}: ${r.detail}`);
  }
}
