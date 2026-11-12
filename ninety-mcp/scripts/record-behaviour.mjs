#!/usr/bin/env node
// Records what every tool sends to the Ninety API (against a local fake, never the real API)
// and writes it to a JSON file. Used to (re)generate test/fixtures/behaviour-*.json.
//
//   node scripts/record-behaviour.mjs dist/index.js test/fixtures/behaviour-v0.2.0.json
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectStdio, recordBehaviour, startStubApi } from "../test/support/harness.mjs";

const [, , entry, outFile] = process.argv;
if (!entry || !outFile) {
  console.error("Usage: node scripts/record-behaviour.mjs <path to index.js> <output.json>");
  process.exit(1);
}

const stub = await startStubApi();
const client = await connectStdio(entry, { NINETY_API_BASE_URL: stub.baseUrl });
const cases = await recordBehaviour(client, stub);
await client.close();
await stub.close();

writeFileSync(resolve(outFile), JSON.stringify(cases, null, 2) + "\n");
const withRequests = cases.filter((entry) => entry.requests.length > 0).length;
const errors = cases.filter((entry) => entry.outcome.isError || entry.outcome.threw).length;
console.log(`${cases.length} calls recorded: ${withRequests} reached the API, ${errors} returned an error.`);
for (const entry of cases.filter((c) => c.outcome.isError || c.outcome.threw)) {
  console.log(`  error: ${entry.tool} (${entry.mode}): ${(entry.outcome.text ?? entry.outcome.threw).slice(0, 160)}`);
}
