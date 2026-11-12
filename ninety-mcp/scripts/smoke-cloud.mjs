#!/usr/bin/env node
// Starts the hosted build locally in Cloudflare's runtime (no account needed) and prints what an
// unauthenticated visitor sees. A quick check that the Worker boots; the real tests are in test/.
//
//   node scripts/smoke-cloud.mjs
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  root: fileURLToPath(new URL("..", import.meta.url)),
  workers: [
    {
      configPath: "./wrangler.jsonc",
      secrets: { NINETY_API_TOKEN: "smoke-token", CONNECTOR_PASSWORD: "smoke-password-0123456789" },
    },
  ],
});

try {
  const { url } = await server.listen();
  const origin = url.origin;
  console.log("listening at", origin);

  const status = await fetch(`${origin}/`);
  console.log("GET / ->", status.status, status.headers.get("content-type"));
  console.log("  CSP:", status.headers.get("content-security-policy"));

  const mcp = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log("POST /mcp (no token) ->", mcp.status);
  console.log("  WWW-Authenticate:", mcp.headers.get("www-authenticate"));

  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
    const response = await fetch(origin + path);
    console.log(`GET ${path} ->`, response.status);
    console.log("  ", JSON.stringify(await response.json().catch(() => null)));
  }
} catch (error) {
  console.error("SMOKE FAILED:", error);
  server.debug?.();
  process.exitCode = 1;
} finally {
  await server.close();
}
