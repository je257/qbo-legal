// Shared test helpers: a fake Ninety API, a stdio MCP client, and argument generation from tool schemas.
// Nothing here talks to the real Ninety API.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const FAKE_TOKEN = "test-token-not-a-real-credential";

/**
 * A local stand-in for api.public.ninety.io. Records every request it receives.
 * `respond(request)` may return { status, headers, body } to script failures; default is 200 {"ok":true}.
 */
export async function startStubApi(respond) {
  const requests = [];
  // Tests can swap the script at any time: api.respond = (request, count) => ({ status, headers, body })
  const api = { respond };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      const scripted = api.respond ? api.respond(record, requests.length) : undefined;
      const status = scripted?.status ?? 200;
      const body = scripted?.body ?? JSON.stringify({ ok: true });
      const send = () => {
        if (scripted?.dropMidBody) {
          // The status and half the body arrive, then the connection is cut.
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body) + 500),
          });
          res.write(body.slice(0, Math.max(1, Math.floor(body.length / 2))));
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.writeHead(status, { "Content-Type": "application/json", ...(scripted?.headers ?? {}) });
        res.end(body);
      };
      // delayMs lets a test hold a request open, to overlap calls or cut one off part-way.
      if (scripted?.delayMs) setTimeout(send, scripted.delayMs);
      else send();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return Object.assign(api, {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    take() {
      return requests.splice(0, requests.length);
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
  });
}

/** Connects an MCP client to a stdio build of the connector (dist/index.js). */
export async function connectStdio(entry, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(entry), "serve"],
    env: {
      ...process.env,
      NINETY_MCP_DIR: mkdtempSync(join(tmpdir(), "ninety-test-")),
      NINETY_API_TOKEN: FAKE_TOKEN,
      ...env,
    },
  });
  const client = new Client({ name: "ninety-tests", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const HEX_ID = "0123456789abcdef01234567";

function sampleValue(name, schema) {
  if (!schema || typeof schema !== "object") return "sample";
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return sampleValue(name, variants.find((option) => option.type !== "null") ?? variants[0]);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return Math.max(1, schema.minimum ?? 1);
    case "array":
      return [sampleValue(name.replace(/s$/, ""), schema.items)];
    case "object":
      if (schema.properties) return sampleArguments(schema, "all");
      return { sampleKey: "sampleValue" };
    case "string":
    default:
      if (name === "path") return "/v1/teams";
      if (/email/i.test(name)) return "someone@example.com";
      if (/date|after|before|start|end/i.test(name)) return "2026-07-01";
      if (/id$/i.test(name) || /ids$/i.test(name) || /token/i.test(name)) return HEX_ID;
      return `sample ${name}`;
  }
}

/** Builds arguments that satisfy a tool's input schema: only the required fields, or every field. */
export function sampleArguments(schema, mode) {
  const args = {};
  const required = new Set(schema?.required ?? []);
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (mode === "required" && !required.has(name)) continue;
    args[name] = sampleValue(name, property);
  }
  return args;
}

/**
 * Calls every tool twice (required arguments only, then every argument) and records the tool
 * result and the HTTP requests each call made. This is the behaviour snapshot.
 */
export async function recordBehaviour(client, stub) {
  const { tools } = await client.listTools();
  const cases = [];
  for (const tool of tools) {
    for (const mode of ["required", "all"]) {
      const args = sampleArguments(tool.inputSchema, mode);
      stub.take();
      let outcome;
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
        outcome = { isError: Boolean(result.isError), text: normalise(text, stub) };
      } catch (error) {
        outcome = { threw: normalise(String(error?.message ?? error), stub) };
      }
      const requests = stub.take().map((request) => ({
        method: request.method,
        url: request.url,
        authorization: request.authorization === `Bearer ${FAKE_TOKEN}` ? "Bearer <token>" : request.authorization,
        contentType: request.contentType,
        body: request.body,
      }));
      cases.push({ tool: tool.name, mode, arguments: args, outcome, requests });
    }
  }
  return cases;
}

function normalise(text, stub) {
  return text.split(stub.baseUrl).join("http://stub");
}
