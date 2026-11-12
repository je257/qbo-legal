#!/usr/bin/env node
// Builds the installable skill file for skills/connector-to-cloudflare.
//
//   node skills/build-skill.mjs
//
// 1. Refreshes the skill's template from the Ninety connector's source (ninety-mcp/), so the
//    skill always ships the current code. The template folder is generated and is not kept in git.
// 2. Checks the skill's front matter against the rules Claude applies on upload.
// 3. Writes skills/dist/connector-to-cloudflare.skill (a zip whose top folder is the skill's name).
//
// Needs only Node (no Python, no zip program).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const NAME = "connector-to-cloudflare";
const skill = join(here, NAME);
const source = join(repo, "ninety-mcp");
const template = join(skill, "assets", "template");

// ---------------------------------------------------------------- 1. template snapshot
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
const EXAMPLES = ["src/ninety.ts", "src/local.ts", "src/stdio.ts", "src/constants.ts"];

rmSync(template, { recursive: true, force: true });
for (const item of COPY) {
  const from = join(source, item);
  if (!existsSync(from)) throw new Error(`missing in ninety-mcp: ${item}`);
  cpSync(from, join(template, item), { recursive: true });
}
for (const item of EXAMPLES) {
  mkdirSync(join(template, "src-example"), { recursive: true });
  cpSync(join(source, item), join(template, "src-example", item.replace(/^src\//, "")));
}
const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
writeFileSync(
  join(template, "package.example.json"),
  JSON.stringify({ scripts: pkg.scripts, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies }, null, 2) + "\n",
);

// ---------------------------------------------------------------- 2. front matter
const text = readFileSync(join(skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
if (!front) throw new Error("SKILL.md has no front matter");
const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front[1])?.[1]?.trim() ?? "";
const name = field("name");
const description = field("description");
const keys = front[1].split("\n").filter((line) => /^[a-z-]+:/.test(line)).map((line) => line.split(":")[0]);
const allowed = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];
const problems = [];
if (name !== NAME) problems.push(`name is "${name}", expected "${NAME}"`);
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push("name must be lower-case words joined by single dashes, at most 64 characters");
if (!description) problems.push("description is missing");
if (description.length > 1024) problems.push(`description is ${description.length} characters; the limit is 1024`);
if (/[<>]/.test(description)) problems.push("description must not contain < or >");
for (const key of keys) if (!allowed.includes(key)) problems.push(`front matter key "${key}" is not allowed`);

function* walk(path) {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__pycache__") yield* walk(full);
    } else if (entry !== ".DS_Store" && !entry.endsWith(".pyc")) {
      yield full;
    }
  }
}
const files = [...walk(skill)].filter((file) => relative(skill, file).split(/[\\/]/)[0] !== "evals");
const skillFiles = files.filter((file) => file.endsWith("SKILL.md"));
if (skillFiles.length !== 1) problems.push(`there must be exactly one SKILL.md, found ${skillFiles.length}`);
if (problems.length) {
  console.error("The skill is not valid:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

// ---------------------------------------------------------------- 3. zip
const entries = files.map((file) => {
  const data = readFileSync(file);
  const path = Buffer.from(`${NAME}/${relative(skill, file).split("\\").join("/")}`, "utf8");
  const packed = deflateRawSync(data, { level: 9 });
  return { path, data, packed, crc: crc32(data) };
});

const parts = [];
const central = [];
let offset = 0;
for (const entry of entries) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // file names are UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x21, 12); // date: 1980-01-01
  local.writeUInt32LE(entry.crc >>> 0, 14);
  local.writeUInt32LE(entry.packed.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(entry.path.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, entry.path, entry.packed);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.packed.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.path.length, 28);
  header.writeUInt32LE(offset, 42);
  central.push(header, entry.path);
  offset += local.length + entry.path.length + entry.packed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

const out = join(here, "dist", `${NAME}.skill`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...parts, directory, end]));
console.log(`${entries.length} files, ${Math.round(statSync(out).size / 1024)} KB -> ${out}`);
console.log(`description: ${description.length} characters`);
