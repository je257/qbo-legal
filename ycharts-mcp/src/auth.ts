import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BASE_CANDIDATES, DEFAULT_V3_BASE_URL, DEFAULT_V4_BASE_URL, configDir, loadConfig, saveConfig } from "./config.js";
import { probeApi } from "./ycharts.js";

export async function runAuthFlow(): Promise<void> {
  console.log("YCharts connector setup");
  console.log("-----------------------");
  console.log(
    "You need a YCharts API key with the API V4 Add-On. Find or regenerate it at\n" +
      "https://ycharts.com/api_v4 (docs and sandbox: https://ycharts.com/v4/docs).\n",
  );

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const existing = loadConfig();
    const promptSuffix = existing ? " (press Enter to keep the saved key)" : "";
    let apiKey = (await rl.question(`YCharts API key${promptSuffix}: `)).trim();
    if (!apiKey && existing) apiKey = existing.apiKey;
    if (!apiKey) throw new Error("No API key entered.");

    console.log("\nVerifying the key against the YCharts API (v4, then legacy v3)...");
    const outcome = await probeApi(apiKey, BASE_CANDIDATES, false);
    const v4 = outcome.results.find((r) => r.apiVersion === "v4" && r.ok);
    const v3 = outcome.results.find((r) => r.apiVersion === "v3" && r.ok);

    if (v4 || v3) {
      const v4BaseUrl = v4?.baseUrl ?? DEFAULT_V4_BASE_URL;
      saveConfig({ apiKey, v4BaseUrl, v3BaseUrl: v3?.baseUrl ?? v4BaseUrl });
      console.log(`\n${v4 ? "✓" : "✗"} v4 API (${v4BaseUrl}/v4): ${v4 ? "works" : "not reachable with this key"}`);
      console.log(`${v3 ? "✓" : "✗"} legacy v3 data API (${v3?.baseUrl ?? v4BaseUrl}/v3): ${v3 ? "works" : "not reachable with this key"}`);
      if (!v4) console.log("  The v4 tools may fail — the key may lack the API V4 Add-On. Contact YCharts if it should have it.");
      if (!v3) console.log("  The ycharts_v3_* raw-data tools may fail — legacy v3 access is a separate entitlement.");
      console.log(`\nKey saved to ${configDir}/config.json (owner-only permissions).`);
      return;
    }

    if (outcome.keyRejected) {
      console.error("\n✗ YCharts rejected this API key (HTTP 401). Nothing was saved.");
      console.error("  Double-check the key at https://ycharts.com/api_v4, or contact YCharts support if it should be active.");
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
      saveConfig({ apiKey, v4BaseUrl: DEFAULT_V4_BASE_URL, v3BaseUrl: DEFAULT_V3_BASE_URL });
      console.log(`Saved to ${configDir}/config.json. Run \`node dist/index.js status\` later to re-verify,`);
      console.log("or override the endpoints with YCHARTS_BASE_URL / YCHARTS_V3_BASE_URL.");
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
  console.log(`Configured endpoints: v4 = ${config.v4BaseUrl}/v4, v3 = ${config.v3BaseUrl}/v3`);
  console.log(
    `API key: ${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)} (from ${process.env.YCHARTS_API_KEY?.trim() ? "YCHARTS_API_KEY env var" : configDir + "/config.json"})`,
  );
  console.log("Checking connectivity...");

  const configured = [
    { baseUrl: config.v4BaseUrl, apiVersion: "v4" },
    { baseUrl: config.v3BaseUrl, apiVersion: "v3" },
  ];
  const outcome = await probeApi(
    config.apiKey,
    [...configured, ...BASE_CANDIDATES.filter((c) => !configured.some((k) => k.baseUrl === c.baseUrl && k.apiVersion === c.apiVersion))],
    false,
  );

  const v4Ok = outcome.results.some((r) => r.apiVersion === "v4" && r.baseUrl === config.v4BaseUrl && r.ok);
  const v3Ok = outcome.results.some((r) => r.apiVersion === "v3" && r.baseUrl === config.v3BaseUrl && r.ok);
  console.log(`${v4Ok ? "✓" : "✗"} v4 API: ${v4Ok ? "connected" : "not working on the configured host"}`);
  console.log(`${v3Ok ? "✓" : "✗"} legacy v3 data API: ${v3Ok ? "connected" : "not working on the configured host"}`);
  if (outcome.keyRejected) {
    console.log("✗ The API key was rejected (HTTP 401). Re-run `node dist/index.js auth`.");
  } else if (!v4Ok || !v3Ok) {
    const elsewhere = outcome.results.find(
      (r) => r.ok && !configured.some((k) => k.baseUrl === r.baseUrl && k.apiVersion === r.apiVersion),
    );
    if (elsewhere) {
      console.log(`  Note: ${elsewhere.baseUrl}/${elsewhere.apiVersion} works — re-run \`node dist/index.js auth\` to store it.`);
    }
    for (const r of outcome.results.filter((r) => !r.ok)) console.log(`  - ${r.baseUrl}/${r.apiVersion}: ${r.detail}`);
  }
}
