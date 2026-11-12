import { DEFAULT_BASE_URL, DEVELOPER_SETTINGS_URL } from "../src/constants.js";
import { HOSTED_RETRY, NinetyClient, NinetyError } from "../src/ninety.js";
import type { ServerDeps } from "../src/server.js";
import { apiBaseUrl, ninetyToken, type Env } from "./env.js";

// How the hosted connector differs from the desktop one: the token is a Worker secret, one request
// to Ninety must answer within a minute, results stay under Claude's size limit, and the tools that
// can destroy data are off unless switched on in wrangler.jsonc.

/** Claude's hosted apps accept about 150,000 characters per tool result; stay well under it. */
export const MAX_RESULT_CHARS = 100_000;

/** Which optional tools a server is built with. Fixed for the life of that server. */
export interface ToolSwitches {
  deleteTools: boolean;
  rawRequest: boolean;
}

const WHERE_SECRETS_LIVE =
  "the Cloudflare dashboard: Workers & Pages, this Worker, Settings, Variables and Secrets";

const INSTRUCTIONS =
  "Ninety.io (EOS) connector, acting as one signed-in Ninety user. " +
  "Most tools need a teamId: call ninety_teams once and reuse the id. " +
  "Lists are paged: pass pageSize and pageIndex (or nextToken) instead of assuming a response is complete, " +
  "and narrow a request that comes back truncated. " +
  "Scorecard: Measurables with isSmart=true are formulas, so never write scores to them. " +
  "Writes are visible to the team at once, and a score written for a period replaces the one already there.";

/**
 * `settings` returns the settings of the request being served right now, or undefined when the
 * server is not serving one (it is kept in a pool between requests; see pool.ts). Tools read the
 * token through it at call time, so a pooled server never holds on to a request's settings.
 */
export function hostedDeps(settings: () => Env | undefined, switches: ToolSwitches): ServerDeps {
  return {
    client() {
      const env = settings();
      const token = env ? ninetyToken(env) : undefined;
      if (!env || !token) {
        throw new NinetyError(
          "This hosted connector has no Ninety token yet. Add a secret named NINETY_API_TOKEN in " +
            `${WHERE_SECRETS_LIVE}. Generate the token at ${DEVELOPER_SETTINGS_URL}.`,
        );
      }
      return new NinetyClient(token, {
        baseUrl: apiBaseUrl(env),
        retry: HOSTED_RETRY,
        tokenHelp:
          `Generate a new one at ${DEVELOPER_SETTINGS_URL} and replace the NINETY_API_TOKEN secret in ` +
          `${WHERE_SECRETS_LIVE}.`,
      });
    },
    status() {
      const env = settings();
      return {
        tokenSource: env && ninetyToken(env) ? "Cloudflare Worker secret NINETY_API_TOKEN" : undefined,
        apiBaseUrl: env ? apiBaseUrl(env) : DEFAULT_BASE_URL,
        notConfiguredHelp:
          "No token configured. Generate a Personal Access Token at " +
          `${DEVELOPER_SETTINGS_URL}, then add it as a secret named NINETY_API_TOKEN in ${WHERE_SECRETS_LIVE}.`,
      };
    },
    enableDeleteTools: switches.deleteTools,
    enableRawRequest: switches.rawRequest,
    maxResultChars: MAX_RESULT_CHARS,
    instructions: INSTRUCTIONS,
  };
}
