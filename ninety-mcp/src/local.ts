import { baseUrl, loadToken, tokenSource } from "./config.js";
import { DEVELOPER_SETTINGS_URL } from "./constants.js";
import { DESKTOP_RETRY, NinetyClient, NinetyError } from "./ninety.js";
import type { ServerDeps } from "./server.js";

// Desktop-only wiring: the token comes from this computer (NINETY_API_TOKEN, or the file written
// by `node dist/index.js auth`). Every tool is offered and nothing is truncated, exactly as before
// the hosted build existed.

export function localDeps(): ServerDeps {
  return {
    client() {
      const token = loadToken();
      if (!token) {
        throw new NinetyError(
          "No Ninety Personal Access Token is configured. Generate one at " +
            `${DEVELOPER_SETTINGS_URL}, then either set the NINETY_API_TOKEN environment variable ` +
            "or open a terminal in the project's ninety-mcp folder and run `node dist/index.js auth`.",
        );
      }
      return new NinetyClient(token, {
        baseUrl: baseUrl(),
        retry: DESKTOP_RETRY,
        tokenHelp:
          `Generate a new one at ${DEVELOPER_SETTINGS_URL} and re-run ` +
          "`node dist/index.js auth` (or update NINETY_API_TOKEN).",
      });
    },
    status() {
      return {
        tokenSource: tokenSource(),
        apiBaseUrl: baseUrl(),
        notConfiguredHelp:
          "No token configured. Generate a Personal Access Token at " +
          `${DEVELOPER_SETTINGS_URL}, then run ` +
          "`node dist/index.js auth` in the project's ninety-mcp folder (or set NINETY_API_TOKEN).",
      };
    },
  };
}
