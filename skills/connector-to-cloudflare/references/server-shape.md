# The shape of `createServer(deps)`

A stdio connector usually looks like this:

```ts
export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "x-mcp", version: "1.0.0" });
  server.registerTool("x_list", { ... }, (args) => run(() => XClient.load().request("GET", "/things", { query: args })));
  // ...every other tool...
  await server.connect(new StdioServerTransport());
}
```

Two things tie it to the desktop: `XClient.load()` reads a token from a file, and the last line
connects stdio. Change only those. The tool definitions stay exactly as they are, which is what
keeps the regression recording passing.

```ts
/** What a deployment supplies: where the token comes from and which optional tools it offers. */
export interface ServerDeps {
  /** A client for the API. Throws an error that says how to configure the token. */
  client: () => XClient;
  /** For the status tool: where the token comes from (undefined = none configured). */
  status: () => { tokenSource?: string; apiBaseUrl: string; notConfiguredHelp: string };
  enableDeleteTools?: boolean; // default true
  enableRawRequest?: boolean;  // default true
  maxResultChars?: number;     // default: no limit
  instructions?: string;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    deps.instructions ? { instructions: deps.instructions } : undefined,
  );

  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: formatResult(value, deps.maxResultChars) }] });
  // The async wrapper turns a throw from deps.client() (no token configured) into a tool error too.
  const run = (handler: () => Promise<unknown>) =>
    (async () => handler())().then(ok, (error: unknown) => ({
      content: [{ type: "text" as const, text: error instanceof XError ? error.message : `Unexpected error: ${String(error)}` }],
      isError: true,
    }));

  server.registerTool("x_list", { ... }, (args) => run(() => deps.client().request("GET", "/things", { query: args })));

  // A call that creates something new each time is marked, so the hosted build never sends it twice.
  server.registerTool("x_create", { ... }, (args) =>
    run(() => deps.client().request("POST", "/things", { body: args, nonIdempotent: true })));

  // Optional tools keep their place in the list (so the order never changes) and are removed at the end.
  const thingDelete = server.registerTool("x_delete", { ... }, ({ id }) => run(() => deps.client().request("DELETE", `/things/${encodeURIComponent(id)}`)));

  if (deps.enableDeleteTools === false) thingDelete.remove();
  return server;
}
```

`formatResult(value, maxChars)`: with no limit, `JSON.stringify(value, null, 2)` as before. With a
limit, compact JSON; if that is over the limit, a notice at the top saying the data is incomplete
and how to narrow the request, followed by the first part, never ending on half of a two-part
character.

Desktop wiring, unchanged behaviour:

```ts
// local.ts
export function localDeps(): ServerDeps {
  return {
    client() {
      const token = loadToken();                       // from the environment or the local config file
      if (!token) throw new XError("No token is configured. ...the same text as before...");
      return new XClient(token, { baseUrl: baseUrl(), retry: DESKTOP_RETRY, tokenHelp: "...as before..." });
    },
    status: () => ({ tokenSource: tokenSource(), apiBaseUrl: baseUrl(), notConfiguredHelp: "...as before..." }),
  };
}

// stdio.ts
export async function startServer(): Promise<void> {
  await createServer(localDeps()).connect(new StdioServerTransport());
}
```

Keep every message the desktop build prints or returns word for word. The regression recording
compares tool results as well as requests.

If the status tool wraps the API answer (as Ninety's does to report `connected: true` with the
list of teams), check it by hand in both builds; it is the one tool that does more than pass the
answer through.

Things `tsc` may have been hiding: a connector that was only ever bundled with esbuild can carry
type errors, because esbuild ignores types. Fix them as part of this step so that `npm install`
(which runs `tsc`) works.
