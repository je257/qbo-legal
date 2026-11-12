import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localDeps } from "./local.js";
import { createServer } from "./server.js";

/** The desktop connector: every tool, served over stdio to Claude Desktop or Claude Code. */
export async function startServer(): Promise<void> {
  await createServer(localDeps()).connect(new StdioServerTransport());
}
