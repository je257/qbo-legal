# What must hold, and how to have it checked

A hosted connector acts as the owner in a system that holds company data, and it is reachable by
anyone on the internet. These are the properties the template provides. When adapting it, keep
each one, and know what it is for so that a change does not quietly remove it.

## Properties and what each one protects against

| Property | Where | Protects against |
|---|---|---|
| Every `/mcp` request needs a token the library issued; the handler also fails closed if the verified token details are missing | `cloud/worker.ts`, `cloud/mcp.ts` | Anyone reaching tools without signing in |
| A token is issued only after the connector password is checked, with a constant-time comparison; missing or short password switches sign-in off | `cloud/site.ts`, `cloud/env.ts` | Sign-in without the password; misconfiguration failing open |
| No secret in any URL | everywhere | Leaks through logs, browser history, connector settings shown to a team |
| The sign-in result is only ever sent to an allow-listed redirect address (Claude's), checked at registration, at the sign-in page, on error redirects and again before completing | `cloud/worker.ts`, `cloud/site.ts` | A look-alike app receiving a sign-in; the connector being used as an open redirect |
| Only Anthropic's address ranges may register an app; registrations are small and plain | `cloud/worker.ts`, `cloud/env.ts` | Strangers filling storage or using up the day's KV writes, which stops token renewal |
| One address only (https, default port); the provider gets a fresh copy of env per request | `cloud/worker.ts` | A second origin breaking sign-in or confusing token audiences |
| Each connection carries a fingerprint of the password it was made with; a mismatch, or a connection with no fingerprint, is refused at `/mcp` and at renewal | `cloud/env.ts`, `cloud/mcp.ts`, `cloud/worker.ts` | A leaked password: changing it ends every connection, however many |
| Sign-in attempts, page views and registrations are rate limited | `cloud/site.ts`, `cloud/worker.ts` | Guessing; cheap flooding |
| Pages escape every value they did not write, load nothing external, cannot be framed | `cloud/pages.ts` | Script injection through an app's self-chosen name; clickjacking |
| Logs hold tool names and status codes only | `cloud/mcp.ts`, `cloud/site.ts` | Data, tokens or passwords ending up in Cloudflare's logs |
| Optional tools (deletes, raw request) are behind switches; with deletes off, clearing a value is refused too | `src/server.ts`, `wrangler.jsonc` | An unintended permanent deletion; the switch promising more than it does |
| A request that creates something is never sent twice, and a delete that was answered is never repeated | the client's retry policy | Duplicate items after a timeout; a successful delete reported as "not found" |
| Two requests never share a server; settings are cleared when a server is returned | `cloud/pool.ts`, `cloud/mcp.ts` | One request seeing another's settings or answer |

## Having it reviewed

Independent review finds problems that a passing test suite does not. Typical examples: a
sign-out that stops silently at a page limit, a password change that ends nothing, anonymous
callers able to use up storage writes, a port-number trick that breaks sign-in, an open redirect
on an error path. None of these exposes data by itself, but each is worth fixing before relying
on a connector.

Use a small workflow: three reviewers, each followed by one skeptic who tries to refute the
findings. Give every reviewer the layout, the design decisions (so they challenge them only with a
concrete failure), what has already been established, and these rules: do not modify the project,
put scripts in a scratch folder, do not deploy or touch the Cloudflare account, never call the real
upstream API or the deployed Worker, report only specific problems with a file, a scenario and
whether it was reproduced.

The lenses that paid off:

1. **Sign-in and access control, read against the library's source.** Every path to a token or to
   the handler; how each library helper is used; scopes when a client asks for something else;
   every redirect including error paths; fail-open behaviour when a secret, binding or limiter is
   missing; whether sign-out and a password change really end connections; what an anonymous
   caller can make the Worker store.
2. **Attack the running Worker locally.** Odd paths and methods; Host header tricks; a token from
   one origin used at another; completing sign-in without the password (missing fields, duplicated
   fields, multipart, JSON, a handle from another page, racing two approvals); markup in an app's
   name; near-miss redirect addresses; code and token replay and swapping between apps; malformed
   input to the token and registration endpoints; rate-limit dodging; calling switched-off tools;
   oversized and deeply nested bodies.
3. **Will it keep working on Cloudflare with Claude?** The free plan's limits against what one
   request and one sign-in cost (processor time, KV reads and writes, counted by running it);
   what is allowed at start-up; reusing objects across requests; what Claude's client sends and
   whether each answer is right; anything known to make Claude ask to reconnect.
4. **The refactor.** The old client and the new one side by side through every error and retry
   branch; which calls are marked as creating something; the desktop paths the tests do not run
   (the command-line setup, the extension build); whether the tests can hide a failure.
5. **What a public repository gives away.** Before the first push: anything about the owner or
   their machine, real values used as test data (ids, names), and anything that helps find or
   profile the live deployment (addresses and how they were chosen, dates, measurements,
   statements about "this installation").

After fixes, one more pass aimed only at the changes is worth it, because fixes to sign-in code
are themselves sign-in code: a fix can quietly exempt everything that existed before it.

Verify findings yourself before acting on them, and tell the user in plain words what was found,
what it could have led to, and what is still not verified.
