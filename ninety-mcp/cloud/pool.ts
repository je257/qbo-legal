import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { hostedDeps, type ToolSwitches } from "./deps.js";
import { isOn, type Env } from "./env.js";

// Why this exists: Cloudflare's free plan allows about 10 ms of processor time per request, and
// building the server (48 tool definitions) plus converting every tool's schema for a tools/list
// answer costs more than that on its own: a server built per request needs roughly 9-27 ms. So
// servers are built once and kept:
//
//   - a small pool of ready servers per Worker instance; a request borrows one, connects its own
//     one-request transport to it, and hands it back closed. Two requests never share a server.
//   - the tool list is worked out once per set of tool switches and served from memory.
//   - the first server is built while the Worker starts (start-up has its own 1-second allowance),
//     so even the first request finds one ready.
//
// A pooled server holds no request data between uses: the settings of the request being served
// are set when it is borrowed and cleared when it is returned.

const MAX_POOLED = 6;
/**
 * A borrowed server not returned after this long belongs to a request that was cut off. No request
 * can run much past the 60 seconds a call to Ninety is allowed.
 */
const ABANDONED_AFTER_MS = 90 * 1000;
const TURNS_TO_WAIT = 2000;

export interface PooledServer {
  server: McpServer;
  /** Which optional tools this server was built with. */
  key: string;
  /** The settings of the request being served; empty while the server sits in the pool. */
  current: { env?: Env };
  busy: boolean;
  borrowedAt: number;
}

const pool: PooledServer[] = [];
/** The tools/list answer for each set of tool switches, worked out the first time one is built. */
const toolLists = new Map<string, { tools: unknown[] }>();

export function switchesOf(env: Pick<Env, "ENABLE_DELETE_TOOLS" | "ENABLE_RAW_REQUEST">): ToolSwitches {
  return { deleteTools: isOn(env.ENABLE_DELETE_TOOLS), rawRequest: isOn(env.ENABLE_RAW_REQUEST) };
}

const keyOf = (switches: ToolSwitches): string => `${switches.deleteTools}|${switches.rawRequest}`;

/**
 * Sends requests straight into a server through an in-memory transport and returns its answers.
 * Uses no timers, random numbers or network, so it is allowed while the Worker starts, and it
 * cannot hang: the server gets a bounded number of turns to answer each one.
 */
async function askDirectly(server: McpServer, messages: JSONRPCMessage[]): Promise<(JSONRPCMessage | undefined)[]> {
  const replies: JSONRPCMessage[] = [];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      replies.push(message);
    },
    async close() {
      // The server only counts itself disconnected once its transport says so.
      transport.onclose?.();
    },
  };
  await server.connect(transport);
  const answers: (JSONRPCMessage | undefined)[] = [];
  try {
    for (const message of messages) {
      const expected = replies.length + 1;
      transport.onmessage?.(message);
      for (let turn = 0; turn < TURNS_TO_WAIT && replies.length < expected; turn++) await Promise.resolve();
      answers.push(replies.length >= expected ? replies[expected - 1] : undefined);
    }
  } finally {
    await server.close();
  }
  return answers;
}

/** Builds a server and fixes its tool list, so later tools/list requests cost almost nothing. */
async function build(switches: ToolSwitches): Promise<PooledServer> {
  const key = keyOf(switches);
  const current: { env?: Env } = {};
  const server = createServer(hostedDeps(() => current.env, switches));
  let fixed = toolLists.get(key);
  if (!fixed) {
    const [, list] = await askDirectly(server, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "start-up", version: "0" } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      // Runs a tool call's code path once. It ends in "no token" before anything is sent anywhere,
      // because a server that is not serving a request has no settings to read a token from.
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ninety_teams", arguments: {} } },
    ]);
    const result = (list as { result?: { tools?: unknown[] } } | undefined)?.result;
    if (result && Array.isArray(result.tools)) {
      fixed = { tools: result.tools };
      toolLists.set(key, fixed);
    }
  }
  if (fixed) {
    // The tools never change once a server is built, so the list worked out once is the list.
    // A fresh copy of the outer object per answer keeps callers from sharing a mutable result.
    const tools = fixed.tools as never[];
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  }
  return { server, key, current, busy: false, borrowedAt: 0 };
}

/** Builds the first server while the Worker starts. Returns how many tools it offers. */
export async function prepare(env: Pick<Env, "ENABLE_DELETE_TOOLS" | "ENABLE_RAW_REQUEST">): Promise<number> {
  const entry = await build(switchesOf(env));
  pool.push(entry);
  return toolLists.get(entry.key)?.tools.length ?? 0;
}

/** Borrows a server for one request. */
export async function borrow(env: Env): Promise<PooledServer> {
  const now = Date.now();
  const key = keyOf(switchesOf(env));
  // Forget servers whose request was cut off before it could hand them back, and idle servers
  // built for tool switches that are no longer the ones in force.
  for (let i = pool.length - 1; i >= 0; i--) {
    const candidate = pool[i];
    const abandoned = candidate.busy && now - candidate.borrowedAt > ABANDONED_AFTER_MS;
    const outdated = !candidate.busy && candidate.key !== key;
    if (abandoned || outdated) pool.splice(i, 1);
  }
  let entry = pool.find((candidate) => !candidate.busy && candidate.key === key);
  if (!entry) {
    entry = await build(switchesOf(env));
    // Beyond the limit the server still serves this request; it is just not kept afterwards.
    if (pool.length < MAX_POOLED) pool.push(entry);
  }
  entry.busy = true;
  entry.borrowedAt = now;
  entry.current.env = env;
  return entry;
}

/** Hands a server back: disconnects it from the finished request and clears that request's settings. */
export async function giveBack(entry: PooledServer): Promise<void> {
  try {
    await entry.server.close();
  } catch {
    // A server that will not close cleanly is not reused.
    const index = pool.indexOf(entry);
    if (index >= 0) pool.splice(index, 1);
  }
  entry.current.env = undefined;
  entry.busy = false;
}
