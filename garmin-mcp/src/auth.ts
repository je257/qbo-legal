import { createInterface } from "node:readline/promises";
import { AppConfig, configDir, hasStoredDomain, loadConfig, loadTokens, resolveDomain, saveConfig, saveTokens } from "./config.js";
import { GarminClient } from "./garmin.js";
import { GarminAuthError, domainLabel, login } from "./sso.js";

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
  const config = loadConfig();
  if (process.env.GARMIN_DOMAIN || hasStoredDomain()) return config;
  const answer = await ask("Garmin region [global/china] (global): ");
  const resolved = { ...config, domain: resolveDomain(answer) };
  saveConfig(resolved);
  return resolved;
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
  if (!email) throw new GarminAuthError("An email address is required.", "credentials");
  const password = process.env.GARMIN_PASSWORD ?? (await askHidden("Garmin Connect password (hidden): "));
  if (!password) throw new GarminAuthError("A password is required.", "credentials");

  console.log("\nSigning in to Garmin Connect...");
  const auth = await login(config, email, password, {
    log: (message) => console.log(`  ${message}`),
    promptMfa: async (method) => {
      const where = method === "sms" ? "your phone" : method === "email" ? "your email" : "your authenticator app";
      console.log(`\nYour account uses two-step verification. Garmin sent a code to ${where}.`);
      return ask("Enter the verification code: ");
    },
  });

  saveTokens({ domain: config.domain, email, auth, createdAt: Date.now() });
  console.log("\nSigned in. Loading your profile...");

  const profile = await GarminClient.load().profile();
  console.log(`\nConnected to Garmin Connect as ${profile.fullName ?? profile.userName ?? email}.`);
  console.log(`Tokens saved to ${configDir} (owner read/write only). Your password was not stored.`);
  console.log(
    auth.method === "di"
      ? "The sign-in renews itself automatically; you only need to sign in again if Garmin revokes it."
      : "The sign-in stays valid for about a year; the MCP server is ready to use.",
  );
}

export function printStatus(): void {
  const tokens = loadTokens();
  if (!tokens) {
    console.log("Not connected. Run `node dist/index.js auth` (from the garmin-mcp folder) to sign in.");
    return;
  }
  console.log(`Region:        ${domainLabel(tokens.domain)}`);
  if (tokens.email) console.log(`Account:       ${tokens.email}`);
  if (tokens.profile) {
    console.log(`Profile:       ${tokens.profile.fullName ?? tokens.profile.userName ?? "?"} (${tokens.profile.displayName})`);
  }
  console.log(`Signed in:     ${new Date(tokens.createdAt).toISOString()}`);
  const auth = tokens.auth;
  if (auth.method === "di") {
    console.log(`Token method:  DI bearer token (refreshes automatically${auth.di.refreshToken ? "" : "; no refresh token stored"})`);
    if (auth.di.expiresAt) console.log(`Access token:  expires ${new Date(auth.di.expiresAt * 1000).toISOString()}`);
  } else {
    console.log(`Token method:  OAuth1 (garth-style)`);
    console.log(`Access token:  expires ${new Date(auth.oauth2.expires_at * 1000).toISOString()} (auto-renews)`);
    const mfaExpiry = Number(auth.oauth1.mfa_expiration_timestamp);
    console.log(`Sign-in valid: ${mfaExpiry ? `until ${new Date(mfaExpiry * 1000).toISOString()}` : "roughly one year from sign-in"}`);
  }
}
