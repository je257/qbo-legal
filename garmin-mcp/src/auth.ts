import { createInterface } from "node:readline/promises";
import {
  AppConfig,
  configDir,
  loadConfig,
  loadStoredDomain,
  loadTokens,
  resolveDomain,
  saveConfig,
  saveTokens,
} from "./config.js";
import { GarminClient } from "./garmin.js";
import { GarminAuthError, domainLabel, fetchOAuthConsumer, login } from "./sso.js";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).then(
    (answer) => {
      rl.close();
      return answer.trim();
    },
    (error) => {
      rl.close();
      throw error;
    },
  );
}

/** Reads a line without echoing it (falls back to a visible prompt when stdin is not a TTY). */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return ask(question);

  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw ?? false;
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function resolveAppConfig(): Promise<AppConfig> {
  const existing = loadConfig();
  const domainAnswer =
    process.env.GARMIN_DOMAIN ??
    (existing?.domain ??
      loadStoredDomain() ??
      (await ask("Garmin region [global/china] (global): ")));
  const domain = resolveDomain(domainAnswer);

  if (existing && existing.domain === domain) return existing;
  if (existing) {
    const config = { ...existing, domain };
    saveConfig(config);
    return config;
  }

  console.log("Fetching the Garmin Connect app credentials this connector signs in with...");
  const consumer = await fetchOAuthConsumer();
  const config: AppConfig = { domain, ...consumer };
  saveConfig(config);
  return config;
}

export async function runAuthFlow(): Promise<void> {
  const config = await resolveAppConfig();
  console.log(`Region: ${domainLabel(config.domain)}\n`);

  const previous = loadTokens();
  let email = process.env.GARMIN_EMAIL;
  if (!email) {
    const hint = previous?.email ? ` (${previous.email})` : "";
    email = (await ask(`Garmin Connect email${hint}: `)) || previous?.email || "";
  }
  if (!email) throw new GarminAuthError("An email address is required.");
  const password = process.env.GARMIN_PASSWORD ?? (await askHidden("Garmin Connect password (hidden): "));
  if (!password) throw new GarminAuthError("A password is required.");

  console.log("\nSigning in to Garmin Connect...");
  const { oauth1, oauth2 } = await login(config, email, password, async () => {
    console.log("\nYour account uses multi-factor authentication.");
    return ask("Enter the 6-digit code from your email/authenticator: ");
  });

  saveTokens({ domain: config.domain, email, oauth1, oauth2, createdAt: Date.now() });
  console.log("Signed in. Loading your profile...");

  const profile = await GarminClient.load().profile();
  console.log(`\nConnected to Garmin Connect as ${profile.fullName ?? profile.userName ?? email}.`);
  console.log(`Tokens saved to ${configDir} (owner read/write only). Your password was not stored.`);
  console.log("The sign-in stays valid for about a year; the MCP server is ready to use.");
}

export function printStatus(): void {
  const config = loadConfig();
  const tokens = loadTokens();
  if (!config || !tokens) {
    console.log("Not connected. Run `node dist/index.js auth` (from the garmin-mcp folder) to sign in.");
    return;
  }
  console.log(`Region:        ${domainLabel(tokens.domain)}`);
  if (tokens.email) console.log(`Account:       ${tokens.email}`);
  if (tokens.profile) {
    console.log(`Profile:       ${tokens.profile.fullName ?? tokens.profile.userName ?? "?"} (${tokens.profile.displayName})`);
  }
  console.log(`Signed in:     ${new Date(tokens.createdAt).toISOString()}`);
  console.log(`Access token:  expires ${new Date(tokens.oauth2.expires_at * 1000).toISOString()} (auto-renews)`);
  const mfaExpiry = Number(tokens.oauth1.mfa_expiration_timestamp);
  if (mfaExpiry) console.log(`Sign-in valid: until ${new Date(mfaExpiry * 1000).toISOString()}`);
  else console.log(`Sign-in valid: roughly one year from sign-in`);
}
