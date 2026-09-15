import { createInterface } from "node:readline/promises";
import {
  AppConfig,
  CachedToken,
  configDir,
  loadConfig,
  loadToken,
  saveConfig,
  saveToken,
} from "./config.js";

export const BASE_URL = "https://api.paychex.com";
const TOKEN_URL = `${BASE_URL}/auth/oauth/v2/token`;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function fetchToken(config: AppConfig): Promise<CachedToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 400) {
      throw new Error(
        `Token request failed (${res.status}): ${text}\n\n` +
          "Paychex rejected the credentials. This usually means the API key or secret was " +
          "mistyped. Run the command again and type \"n\" when asked about the saved keys " +
          "to re-enter them.",
      );
    }
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  const r = (await res.json()) as TokenResponse;
  return { accessToken: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
}

interface CompanySummary {
  companyId?: string;
  displayId?: string;
  legalName?: string;
}

async function listCompanies(token: CachedToken): Promise<CompanySummary[]> {
  const res = await fetch(`${BASE_URL}/companies`, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not list companies (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { content?: CompanySummary[] };
  return body.content ?? [];
}

function describeCompany(c: CompanySummary): string {
  const name = c.legalName ?? "(unnamed company)";
  const display = c.displayId ? ` — display ID ${c.displayId}` : "";
  return `${name}${display} (companyId ${c.companyId ?? "?"})`;
}

export async function runAuthFlow(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let config = loadConfig();
    if (config) {
      console.log(`Found saved credentials (API key ending in ...${config.clientId.slice(-6)}).`);
      const answer = (await rl.question("Press Enter to use them, or type n to enter new keys: "))
        .trim()
        .toLowerCase();
      if (answer === "n" || answer === "no") config = undefined;
    }
    if (!config) {
      console.log("Enter the credentials from your Paychex developer application");
      console.log("(developer.paychex.com → your application).\n");
      const clientId = (await rl.question("API key (client ID): ")).trim();
      const clientSecret = (await rl.question("API secret (client secret): ")).trim();
      if (!clientId || !clientSecret) throw new Error("API key and secret are required.");
      config = { clientId, clientSecret };
      saveConfig(config);
      console.log(`\nSaved credentials to ${configDir} (owner read/write only).`);
    }

    console.log("\nRequesting an access token from Paychex...");
    const token = await fetchToken(config);
    saveToken(token);
    console.log("Token received. Looking up companies this application can access...");

    const companies = await listCompanies(token);
    if (companies.length === 0) {
      console.log(
        "\nConnected, but the application cannot see any companies yet.\n" +
          "In the Paychex developer portal (developer.paychex.com), link your Paychex Flex\n" +
          "company to this application — a company admin must approve the access.\n" +
          "Once that's done the tools will work; no need to re-run auth.",
      );
    } else if (companies.length === 1) {
      const only = companies[0];
      if (only.companyId) {
        saveConfig({ ...config, companyId: only.companyId });
      }
      console.log(`\nConnected to ${describeCompany(only)} — saved as the default company.`);
    } else {
      console.log("\nThis application can access several companies:\n");
      companies.forEach((c, i) => console.log(`  ${i + 1}. ${describeCompany(c)}`));
      const pick = (
        await rl.question(`\nDefault company [1-${companies.length}, or Enter to skip]: `)
      ).trim();
      const index = Number.parseInt(pick, 10) - 1;
      const chosen = companies[index];
      if (pick !== "" && chosen?.companyId) {
        saveConfig({ ...config, companyId: chosen.companyId });
        console.log(`Saved ${describeCompany(chosen)} as the default company.`);
      } else {
        console.log(
          "No default saved — tool calls will need an explicit companyId " +
            "(paychex_companies lists them).",
        );
      }
    }
    console.log(`\nTokens are stored in ${configDir}. The MCP server is ready to use.`);
  } finally {
    rl.close();
  }
}

export function printStatus(): void {
  const config = loadConfig();
  if (!config) {
    console.log(
      "Not configured. Run `node dist/index.js auth` (from the paychex folder) to set up credentials.",
    );
    return;
  }
  console.log(`API key:         ...${config.clientId.slice(-6)}`);
  console.log(`Default company: ${config.companyId ?? "(none — tool calls must pass companyId)"}`);
  const token = loadToken();
  if (!token) {
    console.log("Access token:    none cached — one is requested automatically on first use.");
    return;
  }
  const expired = Date.now() > token.expiresAt;
  console.log(
    `Access token:    ${expired ? "expired" : "valid"} (until ${new Date(token.expiresAt).toISOString()}) — renewed automatically.`,
  );
}
