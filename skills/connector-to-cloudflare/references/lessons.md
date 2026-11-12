# Lessons from hosting the Ninety connector

Everything here was learned by hitting it. Dates are given because these things change; when one
stops being true, correct it here.

## Contents

1. Claude's side: plans, adding the connector, what its client really sends
2. Cloudflare: accounts, deploy, limits, processor time
3. The OAuth library (`@cloudflare/workers-oauth-provider` 1.2.4)
4. The MCP SDK in a Worker (`@modelcontextprotocol/sdk` 1.30)
5. Testing in workerd
6. Windows and the Claude desktop app
7. Numbers worth having to hand
8. Calling the upstream API: retries, deletes, sizes

---

## 1. Claude's side

**Only remote connectors reach the phone.** Desktop extensions and stdio servers work in Claude
Desktop and Claude Code only. A remote connector added on the web or desktop appears in the phone
app at the next login. Claude calls the server from Anthropic's cloud, never from the phone.

**Team and Enterprise plans: add it in Organization settings.** On these plans the personal link
(`claude.ai/customize/connectors?modal=add-custom-connector...`) opens the Connectors page and
nothing else. What works:

1. Owner link, pre-filled:
   `https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=NAME&connectorUrl=ENCODED_URL`
   (or Organization settings, Connectors, Add, Custom, Web).
2. Continue, keep the sign-in settings marked **Detected** (it detects "Register automatically"), Add.
3. Then each person: `claude.ai/customize/connectors`, find the connector (label **Custom**), Connect.

Everyone in the organization sees the connector in their list. They cannot use it without the
connector password, and it acts as its owner upstream, so the password stays with that person.
Say this to the user.

**What Claude's client does** (as observed in a Worker's log, late 2026):

- Discovery and OAuth calls come from `python-httpx`, tool traffic from user agent `Claude-User`.
  All of it came from Anthropic's published IPv4 ranges `160.79.104.0/21` and `153.61.208.0/20`.
  The sign-in page itself is loaded by the user's browser from their own address.
- It registers by Dynamic Client Registration as `Claude`, with exactly one redirect address,
  `https://claude.ai/api/mcp/auth_callback`, and `token_endpoint_auth_method: client_secret_post`.
- Per connection it sends `server/discover` first (the 2026-07-28 protocol). SDK 1.30 answers 400
  with error -32000 and Claude falls back to `initialize`, `notifications/initialized`,
  `tools/list`. That 400 is the correct answer; do not "fix" it with another status. Moving to the
  SDK's v2 would remove the extra round trip.
- It renews the access token about hourly with the refresh token, without help. Check the log for
  a 200 on the token endpoint an hour after connecting.
- Limits: about 150,000 characters per tool result, 240 seconds per tool call, 10 seconds for
  OAuth discovery/registration/token endpoints (30 for renewal).
- Sign-in settings of a connector cannot be edited after it is added; remove and add again.

**Assume a hosted address becomes known.** Expect anonymous requests to `/` and `/robots.txt` soon
after a first deploy. Anything reachable without the password must be cheap and write nothing.

## 2. Cloudflare

**wrangler logins are separate per environment.** A login made from an agent's shell and one made
in the user's own Terminal panel do not share credentials. Each needs its own Allow click. Use the
Terminal panel for prompts the user must type into.

**First deploy.** The account needs a `workers.dev` subdomain before the first deploy. Have the
owner register it in the dashboard first, under a name that says nothing about them or the
connector, so that the address cannot be worked out from the repository. The KV namespace is
created automatically when `kv_namespaces` has a binding and no id. A brand-new address can take
several minutes to start answering (`curl` fails with a handshake error until then). Wait in a
background loop rather than debugging.

**Secrets survive deploys; plain vars do not.** `wrangler.jsonc` is the source of truth for `vars`.
A var edited in the dashboard is overwritten by the next deploy.

**Free plan limits to design for** (`developers.cloudflare.com/workers/platform/limits`, KV limits):

- 10 ms of processor time per request. Occasional overage is tolerated; consistent overage ends
  the request with error 1102 (`exceededCpu` in the log). Waiting on fetch or KV does not count.
  Start-up has its own 1-second allowance.
- KV: 1,000 writes, 1,000 deletes, 1,000 lists and 100,000 reads a day. Anything an anonymous
  caller can do that writes to KV lets them stop token renewal for the day. This is why
  registration is limited to Anthropic's addresses.
- A sign-in page that stores a record per view (the consent handle, kept 10 minutes) lets
  anonymous callers consume KV writes too, and a per-address rate limit does not stop that. The
  template leaves this as it is, because the same plan also stops a Worker after 100,000 requests
  a day and no code can prevent that. Closing it means a sign-in page that stores nothing: its
  own change, with the sign-in tests rewritten.
- The rate-limit binding only has 10- or 60-second windows, so it cannot hold a daily budget.
- Workers Paid is 5 US dollars a month per account, covers every Worker in it, and removes these
  (30 s CPU, 1 million KV writes a month).

**Processor time, measured on a deployed Worker** for an authenticated `/mcp` request:

| Build | CPU per request |
|---|---|
| A new MCP server built per request | 9-27 ms |
| Servers pooled, tool list cached | 7-17 ms (mostly cold instances) |
| Unauthenticated 401, metadata | 1-6 ms |
| Sign-in page / token exchange | 8-18 ms, sign-in only |

A Worker with few users is cold most of the time, so most requests pay first-run costs. Laptop
benchmarks after warm-up (0.3-0.6 ms) are misleading; measure with `wrangler tail`.

**Other hostnames.** Cloudflare accepts the same hostname on ports 2053, 2083, 2087, 2096 and 8443.
The Worker treats anything but https on the default port as 404, because each origin would
otherwise be a separate OAuth identity.

## 3. The OAuth library

Read its bundled `README.md`, `docs/*.md` and `dist/oauth-provider.d.ts`; they match the installed
version. Facts that mattered:

- `OAuthProvider` (single Worker) needs `resourceMetadata.resource` as an absolute https URL at
  construction. The hostname is unknown until deployed, so the template builds one provider per
  request origin and caches it. http is accepted only for loopback hosts, which is what local tests use.
- It attaches its helpers to `env.OAUTH_PROVIDER` **once per env object**, and Workers reuse the env
  object across requests. With more than one origin, the first one served owned the helpers and
  sign-in broke on the others. Pass a copy: `provider.fetch(request, { ...env }, ctx)`.
- The consent helpers (`beginConsent`, `approveConsent`, `denyConsent`) keep the request server-side
  and bind the form to the browser with a `__Host-` cookie. `approveConsent` consumes the handle,
  so check the password **before** calling it or a typo burns the page.
- `parseAuthRequest` errors carry `redirectTo` once the app's own registered address is validated.
  Follow it only if that address is also on the connector's allow-list.
- A replayed authorization code revokes the tokens issued from it. Tests that reuse a code must
  sign in again afterwards.
- `tokenExchangeCallback({ props, env })` runs at code exchange and at every renewal. Throwing
  `OAuthError("invalid_grant")` deletes the grant; returning `{ newProps }` updates it. The template
  uses this to tie connections to the connector password. Three things to get right:
  - Never use `newProps` to hand a fingerprint to a connection that has none: a connection made
    before the check existed would then survive the next password change. A connection without
    the current fingerprint is refused, full stop, so everyone connects once more after such a
    deploy. Say so before deploying.
  - Only `invalid_grant` deletes the grant. For a state the owner can put right (the password
    secret missing or too short) throw `temporarily_unavailable` with `statusCode: 503`, or one
    renewal attempt during the gap ends the connection for good.
  - The fingerprint depends on the password alone, so going back to an earlier password revives
    connections that did not try to renew in between. The guide says to choose a new one.
- Ending a connection (`revokeGrant`) costs 3 KV operations plus one per live token, and one
  request may do about 1,000. The "sign out every other connection" tick stops at 200 per request.
- Refresh tokens: 30 days fixed by default. `refreshTokenIdleTTL` makes it slide. Dynamically
  registered apps expire after 90 days but are renewed by any renewal past half-life.
- `clientRegistrationCallback` can refuse a registration; it does not receive `env`, so anything
  that needs settings (rate limit, source address) is checked in the Worker's own `fetch` first.
- KV cost: registration 1 write; sign-in page 1 write; whole sign-in about 5 writes; renewal
  2 writes; an authenticated request 1 read and no write.

## 4. The MCP SDK in a Worker

- `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and
  `enableJsonResponse: true` works in workerd with no `nodejs_compat`. A stateless transport
  refuses to be used for a second request: one transport per request.
- An `McpServer` can be reused across requests if it is closed in between (`connect` throws
  "Already connected" otherwise). A home-made in-memory transport must call `onclose` in its
  `close()`, or the server never counts itself disconnected.
- `RegisteredTool.remove()` before connecting drops a tool cleanly and keeps the order of the rest.
- Replacing the `tools/list` handler with a cached answer is safe when tools never change.
- At Worker start-up (module scope) timers, random values, fetch and reading a request body are
  refused, and `Date.now()` is 0. Top-level `await` on plain promises is fine, and
  `import { env } from "cloudflare:workers"` gives vars and secrets there.
- A JSON-RPC batch containing a request and a `notifications/cancelled` for it never answers.
  Claude sends single messages; the template refuses arrays.
- Hand a borrowed server back through `ctx.waitUntil`, arranged before the first `await`, so a
  request the client abandons still returns it.

## 5. Testing in workerd

- `createTestHarness` from `wrangler` runs the Worker from `wrangler.jsonc` with test-only `vars`
  and `secrets`. `server.update(...)` reloads with new settings and **keeps storage**, which is how
  the password-change test and the upgrade test work. `server.getLogs()` returns the Worker's logs.
- Tests should set the tool switches themselves and not depend on what `wrangler.jsonc` deploys.
- The local rate limiter counts per clock minute and per Worker instance. Keep each harness under
  10 sign-in attempts and 10 sign-in page views, and do not start a limiter test in the last
  seconds of a minute.
- A connection cut mid-body is only noticed when the request times out (20 s hosted). Run such
  cases in parallel inside one test.
- In local workerd a client can set `CF-Connecting-IP`; on Cloudflare it cannot. Useful for testing
  the registration source rule; not a vulnerability.
- Use `fileURLToPath(new URL(...))` for paths. `.pathname` keeps `%20` and breaks in folders with
  spaces, which Windows folders often have.
- To test against a connection made by an earlier build, `test/support/earlier-build/` is a small
  stand-in Worker that signs in without asking and stores the connection without a fingerprint.
  `worker.useEarlierBuild()` swaps it in on the same storage and `worker.changeSecrets({})` puts the
  real Worker back. It has its own Worker name and answers only on loopback, so it can never be
  deployed over the real one. Keep that pattern for any later change to what a connection stores.
- See every new test fail against the old code before trusting it: put the source files back
  (`git show HEAD:path > path`), run just those tests with `--test-name-pattern`, restore. Tests
  that use the shared signed-in session need the sign-in test in the pattern too, or they fail
  for the wrong reason (in under a millisecond, which is the giveaway).
- `JSON.stringify` turns `Infinity` into `null`. To send a number like `1e999` to the Worker,
  write the request body as text.
- Keep assertion output small. A failed `assert.match` prints the whole string; with a
  300,000-character test body that floods the terminal. Filter the test output when running it.

## 6. Windows and the Claude desktop app

- In Windows PowerShell the script policy can block the `.ps1` shims: use `npm.cmd`/`npx.cmd`
  there, plain `npm`/`npx` in the Bash tool. Do not assume Python or `gh` is installed; Node is
  enough for everything here.
- Files checked out by git have CRLF line endings. Multi-line search-and-replace must normalise
  them first (read, replace `\r\n`, edit, restore).
- Inline `node -e` or heredocs with quotes get mangled by the shell. Write a script file and run it.
- `preview_start` reads `launch.json` from the session's starting folder, which may belong to
  another project. To look at the Worker's pages, run the test harness briefly in the background
  and open its URL in a new browser tab. Do not expect the built-in browser to be signed in to
  claude.ai or GitHub.
- `git push` may open a GitHub sign-in window that the user must complete; the command waits
  until they do.
- The repo's commits by Claude use `Claude <noreply@anthropic.com>`. Pass it on each command with
  `-c user.name=... -c user.email=...` rather than relying on a configured git identity, and give
  commits a UTC date so that they do not record a local time zone.
- **`je257/qbo-legal` is a public repository** (it serves the QuickBooks app's public pages).
  Everything pushed to any branch is public at once, and a pull request keeps its commits
  reachable for good. Before the first push: no live address, no account or record ids, no
  machine paths, nothing about the owner. Test data must be invented, never copied from a real
  answer, however opaque the value looks. Check the diff for these before pushing, and if
  cleaning is needed do it before the pull request exists.

## 7. Numbers worth having to hand

| Thing | Value |
|---|---|
| Claude's redirect address | `https://claude.ai/api/mcp/auth_callback` (also allow `https://claude.com/api/mcp/auth_callback`) |
| Anthropic outbound ranges | `160.79.104.0/21`, `153.61.208.0/20` |
| Claude result / call limits | about 150,000 characters; 240 seconds |
| Hosted result cap in the template | 100,000 characters |
| Hosted request budget in the template | 3 attempts, 20 s each, 60 s in total |
| Access token / refresh | 1 hour / 30 days sliding |
| Minimum connector password | 16 characters |
| Bundle size (Ninety) | about 1.1 MB, 220 KB gzipped; start-up 50-120 ms |
| Sign-outs per request | 200 |

## 8. Calling the upstream API

Found by reviewers in the Ninety client (`src-example/ninety.ts`, `src/server.ts`); the same
questions apply to any connector's client.

- **A create is never sent twice.** Mark each creating call; on a timeout or 5xx report "it may
  have gone through, check before repeating". A 429 is the exception: it was refused before
  anything happened, so it is safe to send again.
- **A delete that was answered with success is done**, even if the rest of the answer is lost.
  Sending it again can only come back "not found" and replace the real outcome with an error.
  When a delete is retried after a failure with no clear answer and then gets 404, say that the
  first attempt may have done it.
- **A refusal is final** (4xx): only the explanation can be lost, never retry it.
- **Hold errors to the same size limit as results.** An error message that quotes the upstream
  response can be as large as any result.
- **Numbers that JSON cannot hold.** `1e999` parses to `Infinity`, passes a number check, and is
  written back out as `null`. Where `null` means "clear this value" and clearing is switched off,
  treat a non-finite number as a null.
- **Notes appended to an error start on a new line**, or they run on from quoted upstream text
  and read as part of it.
- Under a deadline, a rate-limit pause longer than the per-wait cap is reported at once ("wait
  30 seconds") and not slept through.
