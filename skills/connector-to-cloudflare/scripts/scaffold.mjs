#!/usr/bin/env node
// Copies the hosted-connector template into another connector's folder and renames it.
//
//   node scaffold.mjs --name garmin --title "Garmin" --to C:\path\to\garmin-mcp
//   node scaffold.mjs --name qbo --title "QuickBooks" --to ...\mcp --from C:\path\to\qbo-legal\ninety-mcp
//
//   --name   short lower-case name used in identifiers and the Worker name (letters, digits, dashes)
//   --title  the name people see ("Garmin", "QuickBooks")
//   --to     the connector's folder (the one with package.json and src/)
//   --from   a ninety-mcp folder to copy from instead of the bundled snapshot (use the repository's copy if newer)
//   --force  overwrite files that already exist
//
// It never touches the connector's own src/. Files that already exist are left alone unless --force.
// After it runs, the names are right but the connector-specific parts still need a person's judgement;
// the list it prints at the end says which.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const name = option("--name");
const title = option("--title");
const target = option("--to");
const force = args.includes("--force");
if (!name || !title || !target || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error('Usage: node scaffold.mjs --name <short-name> --title "<Display name>" --to <connector folder> [--from <ninety-mcp folder>] [--force]');
  process.exit(1);
}

const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "template");
const source = resolve(option("--from") ?? bundled);
if (!existsSync(join(source, "cloud", "worker.ts"))) {
  console.error(`No template found at ${source} (expected cloud/worker.ts there).`);
  process.exit(1);
}

// What is copied. src/ is deliberately absent: the connector keeps its own tools and client.
const COPY = [
  "cloud",
  "wrangler.jsonc",
  "SETUP-CLOUD.md",
  "scripts/dump-tools.mjs",
  "scripts/record-behaviour.mjs",
  "scripts/smoke-cloud.mjs",
  "test/support",
  "test/cloud.test.mjs",
  "test/desktop-regression.test.mjs",
];

const upper = name.replace(/-/g, "_").toUpperCase();
const identifier = name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());

/** Renames Ninety-specific text. Order matters: longest and most specific first. */
function rename(text) {
  return text
    .replace(/NINETY_API_TOKEN/g, `${upper}_API_TOKEN`)
    .replace(/NINETY_API_BASE_URL/g, `${upper}_API_BASE_URL`)
    .replace(/NINETY_MCP_DIR/g, `${upper}_MCP_DIR`)
    .replace(/ninety-mcp/g, `${name}-mcp`)
    .replace(/api\.public\.ninety\.io/g, `api.${name}.example`)
    .replace(/app\.ninety\.io/g, `app.${name}.example`)
    .replace(/Ninety\.io/g, title)
    .replace(/NinetyClient/g, `${identifier[0].toUpperCase()}${identifier.slice(1)}Client`)
    .replace(/NinetyError/g, `${identifier[0].toUpperCase()}${identifier.slice(1)}Error`)
    .replace(/ninetyToken/g, `${identifier}Token`)
    .replace(/Ninety Cloud/g, `${title} Cloud`)
    .replace(/Ninety/g, title)
    .replace(/NINETY/g, upper)
    .replace(/ninety_/g, `${name.replace(/-/g, "_")}_`)
    .replace(/ninety/g, name);
}

function* walk(path) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
  } else {
    yield path;
  }
}

let written = 0;
let skipped = 0;
for (const item of COPY) {
  const from = join(source, item);
  if (!existsSync(from)) {
    console.warn(`(not in the template: ${item})`);
    continue;
  }
  for (const file of walk(from)) {
    const destination = join(resolve(target), relative(source, file));
    if (existsSync(destination) && !force) {
      skipped++;
      console.log(`kept     ${relative(resolve(target), destination)}`);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, rename(readFileSync(file, "utf8")));
    written++;
    console.log(`written  ${relative(resolve(target), destination)}`);
  }
}

console.log(`
${written} files written, ${skipped} left as they were.

Still to do by hand (see SKILL.md, step 4):
  1. package.json: add devDependencies @cloudflare/workers-oauth-provider, wrangler, @cloudflare/workers-types,
     and the scripts check:cloud, test, deploy (copy them from the Ninety connector's package.json).
  2. .gitignore: add .wrangler/ and .dev.vars
  3. src/: createServer(deps) and a client that takes its token as an argument (assets/template/src-example).
  4. cloud/deps.ts and cloud/env.ts: the real secret names, API address and instructions text.
     The placeholders api.${name}.example and app.${name}.example are not real addresses.
  5. cloud/pool.ts: the cheap read tool used once at start-up (search for "${name.replace(/-/g, "_")}_teams").
  6. wrangler.jsonc: the tool switches and the comment that lists the secrets.
  7. test/cloud.test.mjs: tool names, tool counts and the paths the fake API should see.
  8. SETUP-CLOUD.md: read it through; it was written for Ninety.
  9. If the upstream credential is not a fixed token: references/upstream-auth.md.
`);
