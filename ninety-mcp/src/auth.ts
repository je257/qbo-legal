import { createInterface } from "node:readline/promises";
import { DEVELOPER_SETTINGS_URL, baseUrl, configDir, loadToken, saveToken, tokenSource } from "./config.js";

interface Team {
  id: string;
  name: string;
}

async function verifyToken(token: string): Promise<Team[]> {
  const res = await fetch(`${baseUrl()}/v1/teams`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token check failed (${res.status}): ${text || res.statusText}\n` +
        `Make sure you pasted a current Personal Access Token from ${DEVELOPER_SETTINGS_URL}`,
    );
  }
  return (await res.json()) as Team[];
}

export async function runAuthFlow(): Promise<void> {
  console.log(`Ninety connector setup`);
  console.log(`----------------------`);
  console.log(`1. Sign in to Ninety and open ${DEVELOPER_SETTINGS_URL}`);
  console.log(`2. Generate a Personal Access Token (pick the longest expiration that suits you).`);
  console.log(`3. Paste it below. It is stored only in ${configDir}/config.json (owner-only permissions).\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const token = (await rl.question("Personal Access Token: ")).trim();
    if (token === "") throw new Error("No token entered.");

    process.stdout.write("Checking the token against the Ninety API... ");
    const teams = await verifyToken(token);
    console.log("OK");

    saveToken(token);
    console.log(`\nToken saved. Teams visible to this token:`);
    for (const team of teams) console.log(`  - ${team.name} (${team.id})`);
    if (teams.length === 0) console.log("  (none — the token works but sees no teams)");
    console.log(
      `\nNote: Ninety tokens expire (30/90/180/365 days, chosen at creation). When this one does, ` +
        `re-run \`node dist/index.js auth\` with a fresh token.`,
    );
  } finally {
    rl.close();
  }
}

export async function printStatus(): Promise<void> {
  const source = tokenSource();
  if (!source) {
    console.log(`Not configured. Run \`node dist/index.js auth\` (or set NINETY_API_TOKEN).`);
    return;
  }
  console.log(`Token source: ${source === "env" ? "NINETY_API_TOKEN environment variable" : `${configDir}/config.json`}`);
  console.log(`API base URL: ${baseUrl()}`);
  try {
    const teams = await verifyToken(loadToken() as string);
    console.log(`Connected. Teams visible: ${teams.map((t) => t.name).join(", ") || "(none)"}`);
  } catch (error) {
    console.log(`Not connected: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
