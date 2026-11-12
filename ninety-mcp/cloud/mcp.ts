import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SCOPE, passwordFingerprint, type ConnectionProps, type Env } from "./env.js";
import { borrow, giveBack } from "./pool.js";

// The MCP endpoint (POST /mcp). The OAuth library only lets a request reach this handler after it
// has checked the bearer token, so everything here runs for the signed-in owner.
//
// Stateless: each request carries one message, gets its own transport, and is answered with one
// JSON body. The server behind it is borrowed from a small pool and handed back when the answer is
// ready (pool.ts); nothing about a request is kept once it ends.

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** What was asked, for the log: the method name and tool name only, never arguments or results. */
function describeCall(body: unknown): string {
  if (!body || typeof body !== "object") return "?";
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  if (method === "tools/call") return `tools/call:${String(params?.name ?? "?").slice(0, 80)}`;
  return typeof method === "string" ? method.slice(0, 80) : "response";
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const verified = ctx as OAuthResourceContext<ConnectionProps | undefined>;
    const auth = verified.auth;
    // Fail closed: no verified token details means the request did not come through the OAuth check.
    if (!auth) return jsonRpcError(401, -32001, "Not signed in.");
    if (!auth.scope.includes(SCOPE)) return insufficientScope(auth, [SCOPE]);

    // A connection is tied to the connector password it was made with. After the password is
    // changed (or removed) every earlier connection stops here, and its renewal is refused too.
    const current = await passwordFingerprint(env);
    if (!current || verified.props?.pw !== current) {
      const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp`;
      return jsonRpcError(401, -32001, "This connection has ended. Connect again.", {
        "WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="This connection has ended", resource_metadata="${metadata}", scope="${SCOPE}"`,
      });
    }

    // No server-to-client stream and no sessions to end, so only POST has a meaning here.
    if (request.method !== "POST") return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error: the request body is not valid JSON.");
    }
    // Claude sends one message per request. Several in one request (a batch) would multiply the
    // work done per request, and a batch that cancels its own request can never be answered.
    if (Array.isArray(body)) {
      return jsonRpcError(400, -32600, "Send one message per request; batches are not accepted.");
    }

    const startedAt = Date.now();
    const entry = await borrow(env);
    // Arranged before any waiting, so that a request the caller abandons part-way still gets time
    // to finish and hand its server back instead of leaving it marked as in use.
    let finished = (): void => undefined;
    ctx.waitUntil(
      new Promise<void>((resolve) => {
        finished = resolve;
      }).then(() => giveBack(entry)),
    );
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await entry.server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      console.log(
        JSON.stringify({ event: "mcp", call: describeCall(body), status: response.status, ms: Date.now() - startedAt }),
      );
      return response;
    } finally {
      // The answer is complete by now (JSON mode), so the server can go back to the pool.
      finished();
    }
  },
};
