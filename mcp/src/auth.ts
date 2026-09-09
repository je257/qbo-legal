import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  AppConfig,
  DEFAULT_REDIRECT_URI,
  TokenSet,
  configDir,
  loadConfig,
  loadTokens,
  saveConfig,
  saveTokens,
} from "./config.js";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

export async function exchangeToken(
  config: AppConfig,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export function tokensFromResponse(realmId: string, r: TokenResponse): TokenSet {
  const now = Date.now();
  return {
    realmId,
    accessToken: r.access_token,
    accessTokenExpiresAt: now + r.expires_in * 1000,
    refreshToken: r.refresh_token,
    refreshTokenExpiresAt: now + r.x_refresh_token_expires_in * 1000,
  };
}

function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // cmd.exe's `start` would split the unquoted URL at every "&", truncating
      // the OAuth query string — hand it straight to the URL handler instead.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The URL is printed either way; opening the browser is best-effort.
  }
}

export async function runAuthFlow(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let config = loadConfig();
    if (config) {
      console.log(
        `Found saved app keys (Client ID ending in ...${config.clientId.slice(-6)}, ` +
          `${config.environment}).`,
      );
      const answer = (await rl.question("Press Enter to use them, or type n to enter new keys: "))
        .trim()
        .toLowerCase();
      if (answer === "n" || answer === "no") config = undefined;
    }
    if (!config) {
      console.log("Enter the keys from your Intuit developer app");
      console.log("(developer.intuit.com → your app → Keys & credentials).\n");
      const clientId = (await rl.question("Client ID: ")).trim();
      const clientSecret = (await rl.question("Client Secret: ")).trim();
      const envAnswer = (await rl.question("Environment [production/sandbox] (production): ")).trim();
      const redirect = (await rl.question(`Redirect URI (${DEFAULT_REDIRECT_URI}): `)).trim();
      if (!clientId || !clientSecret) throw new Error("Client ID and Client Secret are required.");
      config = {
        clientId,
        clientSecret,
        environment: envAnswer === "sandbox" ? "sandbox" : "production",
        redirectUri: redirect || DEFAULT_REDIRECT_URI,
      };
      saveConfig(config);
      console.log(`\nSaved credentials to ${configDir} (owner read/write only).`);
    }

    const state = randomBytes(16).toString("hex");
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPE);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("state", state);

    console.log("\nOpen this URL, sign in to QuickBooks, and approve access:\n");
    console.log(`  ${authUrl.toString()}\n`);
    tryOpenBrowser(authUrl.toString());
    console.log("After approving, the callback page shows the full redirect URL.");

    const pasted = (await rl.question("\nPaste the redirect URL here: ")).trim();
    const redirected = new URL(pasted);
    const code = redirected.searchParams.get("code");
    const realmId = redirected.searchParams.get("realmId");
    const returnedState = redirected.searchParams.get("state");
    if (!code) throw new Error("No ?code= parameter found in the pasted URL.");
    if (!realmId) throw new Error("No ?realmId= parameter found in the pasted URL.");
    if (returnedState !== state) throw new Error("State mismatch — restart the auth flow.");

    let tokenResponse;
    try {
      tokenResponse = await exchangeToken(config, {
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(401)")) {
        throw new Error(
          message +
            "\n\nQuickBooks rejected the app keys. This usually means the Client ID or Client " +
            "Secret was mistyped, or Development keys were mixed up with Production ones. Run " +
            'the command again and type "n" when asked about the saved keys to re-enter them.',
        );
      }
      throw error;
    }
    saveTokens(tokensFromResponse(realmId, tokenResponse));
    console.log(`\nConnected to QuickBooks company ${realmId} (${config.environment}).`);
    console.log(`Tokens saved to ${configDir}. The MCP server is ready to use.`);
  } finally {
    rl.close();
  }
}

export function printStatus(): void {
  const config = loadConfig();
  const tokens = loadTokens();
  if (!config) {
    console.log("Not configured. Run `node dist/index.js auth` (from the mcp folder) to set up credentials.");
    return;
  }
  console.log(`Environment:  ${config.environment}`);
  console.log(`Redirect URI: ${config.redirectUri}`);
  if (!tokens) {
    console.log("Not connected. Run `node dist/index.js auth` (from the mcp folder) to authorize a company.");
    return;
  }
  console.log(`Company (realm): ${tokens.realmId}`);
  console.log(`Access token:    expires ${new Date(tokens.accessTokenExpiresAt).toISOString()}`);
  console.log(`Refresh token:   expires ${new Date(tokens.refreshTokenExpiresAt).toISOString()}`);
}
