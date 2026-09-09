#!/usr/bin/env node
import { printStatus, runAuthFlow } from "./auth.js";
import { runInstall } from "./install.js";
import { startServer } from "./server.js";

const command = process.argv[2] ?? "serve";

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

switch (command) {
  case "setup":
    runAuthFlow()
      .then(() => runInstall())
      .catch(fail);
    break;
  case "auth":
    runAuthFlow()
      .then(() => {
        console.log(
          `\nNot added to Claude Desktop yet? Run: node dist/index.js install` +
            `\nAlready added before? You're done — just restart Claude Desktop.`,
        );
      })
      .catch(fail);
    break;
  case "install":
    try {
      runInstall();
    } catch (error) {
      fail(error);
    }
    break;
  case "status":
    printStatus();
    break;
  case "serve":
    startServer().catch(fail);
    break;
  default:
    console.error(`Unknown command: ${command}\nUsage: qbo-mcp [setup|auth|install|status|serve]`);
    process.exit(1);
}
