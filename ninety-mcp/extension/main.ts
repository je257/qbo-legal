// Entry point for the Claude Desktop extension (.mcpb) build: serve only, no CLI.
import { startServer } from "../src/stdio.js";

startServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
