#!/usr/bin/env node
// Starts a stdio build of the connector and writes its tools/list answer to a JSON file.
// Used to (re)generate test/fixtures/tools-*.json, the snapshot the regression test compares against.
//
//   node scripts/dump-tools.mjs dist/index.js test/fixtures/tools-v0.2.0.json
//
// No Ninety token is needed and no request is sent to Ninety: listing tools is local.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , entry, outFile] = process.argv;
if (!entry || !outFile) {
  console.error("Usage: node scripts/dump-tools.mjs <path to index.js> <output.json>");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(entry), "serve"],
  // An empty config dir and no token: the dump must not depend on this machine's saved token.
  env: { ...process.env, NINETY_API_TOKEN: "", NINETY_MCP_DIR: mkdtempSync(join(tmpdir(), "ninety-dump-")) },
});
const client = new Client({ name: "dump-tools", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const snapshot = { serverInfo: client.getServerVersion(), toolCount: tools.length, tools };
writeFileSync(resolve(outFile), JSON.stringify(snapshot, null, 2) + "\n");
await client.close();
console.log(`${tools.length} tools written to ${outFile}`);
