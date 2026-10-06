import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

export const DIST = new URL("../dist/", import.meta.url);
export const importDist = (file) => import(new URL(file, DIST).href);

/** Fresh config directory per test file; set before importing dist modules. */
export function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "garmin-mcp-test-"));
  process.env.GARMIN_MCP_DIR = home;
  return home;
}

export const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const jwt = (payload) => `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(payload)}.sig`;
export const form = (body) => Object.fromEntries(new URLSearchParams(body));

export function json(obj, init = {}) {
  const headers = new Headers(init.headers ?? []);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status: 200, ...init, headers });
}

/** Installs a route-based fetch mock and returns the recorded calls. */
export function mockFetch() {
  const calls = [];
  const routes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const req = { url: new URL(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(req);
    for (const r of routes) if (r.match(req)) return r.respond(req);
    throw new Error(`unexpected request ${req.method} ${url}`);
  };
  return {
    calls,
    route: (match, respond) => routes.push({ match, respond }),
    at: (host, path) => (r) => r.url.host === host && r.url.pathname === path,
    reset: () => {
      calls.length = 0;
      routes.length = 0;
    },
  };
}

/** Collapses the anti-bot delays in the widget/portal strategies. */
export function noDelays() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms > 50 ? 0 : ms, ...a);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a small ZIP archive (stored or deflated entries) for the extractor tests. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const comp = e.method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
