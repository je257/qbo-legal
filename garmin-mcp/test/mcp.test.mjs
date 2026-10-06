import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freshHome } from "./helpers.mjs";

const home = freshHome();
writeFileSync(
  join(home, "tokens.json"),
  JSON.stringify({
    domain: "garmin.com",
    email: "x@example.com",
    createdAt: 1,
    profile: { displayName: "abcd-1234" },
    auth: { method: "di", di: { accessToken: "a", refreshToken: "r", clientId: "X", expiresAt: 9999999999 } },
  }),
);

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

test("server registers the tools and validates arguments", async () => {
  const client = await connect({ GARMIN_MCP_DIR: home });
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ["garmin_auth_status", "garmin_daily_summary", "garmin_wellness", "garmin_trend", "garmin_training", "garmin_activities", "garmin_activity", "garmin_download_activity", "garmin_api_request"]) {
      assert.ok(names.includes(expected), expected);
    }
    const status = await client.callTool({ name: "garmin_auth_status", arguments: {} });
    assert.match(status.content[0].text, /"connected": true/);
    const bad = await client.callTool({ name: "garmin_wellness", arguments: { metric: "sleep", date: "2026-13-45" } });
    assert.equal(bad.isError, true);
    const range = await client.callTool({ name: "garmin_trend", arguments: { metric: "steps", start: "2026-09-10", end: "2026-09-01" } });
    assert.equal(range.isError, true);
    const abs = await client.callTool({ name: "garmin_api_request", arguments: { path: "https://evil.example/x" } });
    assert.match(abs.content[0].text, /must be relative/);
  } finally {
    await client.close();
  }
});

test("not signed in is reported, not thrown", async () => {
  const empty = freshHome();
  const client = await connect({ GARMIN_MCP_DIR: empty });
  try {
    const r = await client.callTool({ name: "garmin_daily_summary", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /No Garmin account is connected/);
  } finally {
    await client.close();
  }
});
