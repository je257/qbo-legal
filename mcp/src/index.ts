#!/usr/bin/env node
import { printStatus, runAuthFlow } from "./auth.js";
import { startServer } from "./server.js";

const command = process.argv[2] ?? "serve";

switch (command) {
  case "auth":
    runAuthFlow().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  case "status":
    printStatus();
    break;
  case "serve":
    startServer().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  default:
    console.error(`Unknown command: ${command}\nUsage: qbo-mcp [auth|status|serve]`);
    process.exit(1);
}
