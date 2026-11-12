// The desktop (stdio) build must behave exactly as v0.2.0 did: same 48 tool definitions, and the
// same HTTP request for every tool call. The fixtures were recorded from the v0.2.0 source before
// the tools were separated from the transport, against a local fake API.
//
// Regenerate (only after an intended change to the tools):
//   node scripts/dump-tools.mjs dist/index.js test/fixtures/tools-v0.2.0.json
//   node scripts/record-behaviour.mjs dist/index.js test/fixtures/behaviour-v0.2.0.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectStdio, recordBehaviour, startStubApi } from "./support/harness.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("desktop build lists the same 48 tools as v0.2.0", async () => {
  const expected = fixture("tools-v0.2.0.json");
  let client;
  try {
    client = await connectStdio(ENTRY);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 48);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      expected.tools.map((tool) => tool.name),
      "tool names and their order",
    );
    assert.deepEqual(tools, expected.tools, "titles, descriptions, input schemas and annotations");
  } finally {
    await client?.close();
  }
});

test("desktop build sends the same request to Ninety for every tool call as v0.2.0", { timeout: 120_000 }, async () => {
  const expected = fixture("behaviour-v0.2.0.json");
  // Everything that listens or runs is closed even if the build fails to start, so a broken build
  // makes this test fail instead of leaving the test run hanging.
  const stub = await startStubApi();
  let client;
  try {
    client = await connectStdio(ENTRY, { NINETY_API_BASE_URL: stub.baseUrl });
    const actual = await recordBehaviour(client, stub);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(actual[i], expected[i], `${expected[i].tool} (${expected[i].mode} arguments)`);
    }
  } finally {
    await client?.close();
    await stub.close();
  }
});

test("desktop build reports a missing token as a tool error, not a crash", async () => {
  let client;
  try {
    client = await connectStdio(ENTRY, { NINETY_API_TOKEN: "" });
    const status = await client.callTool({ name: "ninety_auth_status", arguments: {} });
    assert.match(status.content[0].text, /"connected": false/);
    assert.match(status.content[0].text, /No token configured/);
    const teams = await client.callTool({ name: "ninety_teams", arguments: {} });
    assert.equal(teams.isError, true);
    assert.match(teams.content[0].text, /No Ninety Personal Access Token is configured/);
  } finally {
    await client?.close();
  }
});
