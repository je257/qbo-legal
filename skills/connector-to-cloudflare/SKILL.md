---
name: connector-to-cloudflare
description: Move a local MCP connector (QuickBooks, Garmin, Ninety, or any other stdio Node/TypeScript MCP server, such as those in the je257/qbo-legal repo) onto Cloudflare Workers as a password-protected remote connector, so it works in the Claude phone app and on the web with the computer off. Use this whenever the user asks to put a connector in the cloud, host it, get it on their phone or tablet, make it work without the desktop, or do for another connector what was done for Ninety, and whenever they mention Cloudflare, Workers, wrangler, or a custom or remote connector in connection with their own connectors. Also use it to look after a connector that is already hosted - replacing its token or password, publishing a change, switching tools on or off, or fixing sign-in, reconnect or "exceeded CPU" problems. It bundles the working template (OAuth sign-in page, server pool, tests), a scaffold script, plain-language setup steps, and notes on the known pitfalls.
---

# Putting a local connector on Cloudflare

A local MCP connector runs on its owner's own PC. The Claude phone app can only use connectors
that live on the internet, so each one wanted on a phone needs a hosted build. The Ninety.io
connector was the first; what it turned up is written down here, so the next one should go much
faster.

The result for each connector is the same shape:

- the connector's tools, unchanged, served from a **Cloudflare Worker**
- a **sign-in page** in front of it that asks for a connector password only the user knows
  (OAuth 2.1 through `@cloudflare/workers-oauth-provider`); no secret is ever part of a URL
- the upstream credential (API token, OAuth client secret, refresh token) held as a **Worker secret**
- the **desktop build left behaving exactly as before**, proven by a recorded comparison
- a `SETUP-CLOUD.md` the user can follow, and the connector added to Claude and tested on the phone

## What is bundled

| Path | Use |
|---|---|
| `assets/template/` | A snapshot of the working hosted layer from the Ninety connector: `cloud/` (Worker entry, sign-in, MCP endpoint, server pool, settings), `wrangler.jsonc`, tests and test helpers, helper scripts, `SETUP-CLOUD.md`, and the shared-code pattern in `src-example/` |
| `scripts/scaffold.mjs` | Copies the template into another connector's folder and renames everything |
| `scripts/tail-summary.mjs` | Turns `wrangler tail --format json` output into one line per request (path, status, CPU time, tool name), with no addresses or headers |
| `references/lessons.md` | Every pitfall met the first time, with the fix. Read it before starting; it is the main time-saver |
| `references/upstream-auth.md` | How to handle each kind of upstream credential (fixed token, OAuth with refresh tokens, username/password sessions) |
| `references/review.md` | The security properties that must hold and the review prompts that found real problems |
| `references/server-shape.md` | The skeleton of `createServer(deps)` and the desktop wiring, for step 3 |

The reference implementation is the `ninety-mcp/` folder of `je257/qbo-legal`. If a clone of it
is at hand and newer than the snapshot, scaffold from it instead:
`node scripts/scaffold.mjs --from <path to ninety-mcp> ...`.

## Working with the owner

These matter as much as the code. Write for a reader who may not be a programmer: plain words, one
command at a time. Working rules:

- **Never ask for a token or password in chat, and never type one yourself.** Open a prompt in the
  app's Terminal panel (`run_in_terminal` with `npx wrangler secret put NAME`, or `npx.cmd` in
  Windows PowerShell, then show the pane) and have the user paste there. Verify afterwards with `wrangler secret list` (names only)
  and the Worker's status page. The Terminal prompt is one step; the dashboard route takes several.
- **Give one small step at a time**, say what they will see, and confirm it from the Worker's log
  rather than relying on what the screen showed: a step can look finished without having reached
  the connector.
- **Check which Claude plan they have.** On a Team or Enterprise plan a custom connector is added
  by an Owner under Organization settings, not from the personal Connectors page; the personal
  "add connector" link silently does nothing there. Exact steps are in `references/lessons.md`.
- **Tell them plainly what is not verified** and what a choice costs. Whether to save the upstream
  credential before a review has finished is their call to make, once they have the trade-off.
- Keep agent fan-outs small (2-4).

## The workflow

Work through these in order. Each phase ends with something you can show.

### 1. Orient

- Check what is already known about the connector and about anything already hosted, and that it
  is still true (`git status`, the status page of anything already deployed).
- Find the connector's source. In `je257/qbo-legal` each connector has its own folder (`mcp/` is
  QuickBooks, `garmin-mcp/`, `ninety-mcp/`). If only an installed extension bundle is at hand,
  take the source from the repository.
- Work in a **fresh clone or worktree on a new branch**.
- Decide the upstream credential type with `references/upstream-auth.md`; it sets how much work
  phase 4 is. A fixed API token is the easy case. QuickBooks (rotating refresh tokens) and Garmin
  (session login) are not.
- Ask the user one thing if it is not obvious: should the hosted copy offer every tool, or leave
  out the ones that delete? (The Ninety template ships with every tool switched on; a connector to
  more sensitive data may deserve a different answer, and it is the owner's decision.)

### 2. Record the baseline before changing anything

The desktop build must not change. The cheapest proof is a recording made from the untouched code:

```
npx tsc --outDir .baseline            # emits even if there are type errors
node scripts/dump-tools.mjs .baseline/index.js test/fixtures/tools-vX.json
node scripts/record-behaviour.mjs .baseline/index.js test/fixtures/behaviour-vX.json
```

`dump-tools` saves every tool definition; `record-behaviour` calls every tool twice (required
arguments only, then all arguments) against a local fake API and saves the HTTP request each one
sends. `test/desktop-regression.test.mjs` then fails if either changes. The scripts and the fake
API come with the template; adapt the environment variable names to the connector (its token and
base-URL variables).

### 3. Separate the tools from how they are served

A stdio connector usually has one function that registers the tools and connects stdio, and a
client that reads its token from a file. Split them, changing as little as possible:

- `createServer(deps)` registers every tool and **returns** the server. `deps` supplies the API
  client, a status reporter, which optional tools to offer, a result size limit, and instructions.
- The client takes its token (and a retry policy) as arguments. Nothing the Worker imports may
  import `node:fs`, `node:os` or the stdio transport.
- `stdio.ts` + `local.ts` keep the desktop wiring: token from the file or environment, every tool,
  no size limit, the old retry behaviour.

`references/server-shape.md` shows the skeleton of `createServer`, and
`assets/template/src-example/` holds the Ninety versions of `ninety.ts` (the client, with
`DESKTOP_RETRY` and `HOSTED_RETRY`), `local.ts`, `stdio.ts` and `constants.ts`. Run the regression test from phase 2 after this step; it should
pass before anything hosted exists.

Two behaviours worth carrying over because they were found the hard way:

- **A request that creates something is never sent twice** by the hosted build: mark those calls
  and do not retry them after a timeout, a server error or an unreadable response. A 429 is safe to
  retry because the API refused before doing anything.
- **Hosted results are compact JSON, cut at 100,000 characters with a notice at the top.** Claude
  allows about 150,000 characters per result and 240 seconds per call.

### 4. Scaffold the hosted layer

```
node <skill>/scripts/scaffold.mjs --name garmin --title "Garmin" --to <connector folder>
```

This copies `cloud/`, `wrangler.jsonc`, the tests and helpers, and `SETUP-CLOUD.md`, renaming
`ninety`/`Ninety`/`NINETY` throughout. Then adapt what a rename cannot:

- `cloud/deps.ts`: build the connector's client from Worker secrets; write the instructions text.
- `cloud/env.ts`: the secret and variable names, and the scope name.
- `cloud/pool.ts`: the tool called once at start-up to warm the code path (pick a cheap read tool).
- `wrangler.jsonc`: the Worker name, the tool switches, and the comment listing the secrets.
- `test/cloud.test.mjs`: tool names, tool counts, and the paths the fake API expects.
- If the upstream credential is not a fixed token, the extra routes and storage from
  `references/upstream-auth.md`.

Do not weaken the sign-in, registration or one-address checks while adapting. `references/review.md`
lists what each one protects against.

### 5. Test locally in Cloudflare's runtime

`npm test` builds the desktop code, type-checks the Worker, and runs both test files. The hosted
tests run the real Worker in workerd through wrangler's `createTestHarness`; no Cloudflare account
is needed. They must cover at least: no token and a made-up token are refused; the full sign-in
including a wrong password; an authorization code works once; registration rules; the tool list;
overlapping requests each get their own answer; a password change ends connections; retries and
truncation. Look at the sign-in and status pages at phone width before the user sees them.

### 6. Publish it locked

The owner needs a Cloudflare account (free is enough to start; the 5-dollar Workers Paid plan
removes the processor-time and storage-write limits).

1. `npx wrangler login` opens a Cloudflare page; the user clicks Allow.
2. If the account has no `workers.dev` subdomain yet, have the owner register one in the
   Cloudflare dashboard before the first deploy, under a name that says nothing about them or the
   connector, so that the address cannot be worked out from the repository.
3. `npx wrangler deploy`. The first deploy creates the KV namespace. A brand-new address can take
   several minutes before it answers.
4. Check from outside: the status page lists both secrets as missing, `/mcp` without a token is
   401, registering from an ordinary address is 403, the sign-in page says sign-in is switched off.

With no secrets saved the Worker refuses everyone, so publishing before the review is safe. Saving
the upstream credential is the step that matters; get the review done first if the user will wait.

### 7. Secrets, then Claude

1. Connector password: open the Terminal prompt (see "Working with the owner"). At least 16
   characters, best made by a password manager. The Terminal panel needs its own Cloudflare
   approval the first time, separate from the Bash tool's.
2. Upstream credential: a new one made for this connector, not the desktop's, so each can be
   replaced alone. Same Terminal prompt.
3. Add the connector in Claude (organization-plan steps in `references/lessons.md`), sign in with the
   connector password, and set the tools that change things to **Needs approval**.
4. Watch it happen: `npx wrangler tail <worker> --format json > file` in the background, then
   `node <skill>/scripts/tail-summary.mjs file`. Expect registration, the sign-in, a token
   exchange, then `initialize` and `tools/list` from the `Claude-User` agent. Ask the user for one
   question that needs fresh data and confirm the tool call in the log, on the phone as well.

### 8. Review, fix, save

- Have independent reviewers look at it before or soon after the credential goes in. Three lenses
  found real problems the first time; the prompts are in `references/review.md`. Verify their
  findings yourself, fix, re-run the tests, publish.
- Update `SETUP-CLOUD.md` and the connector's README so they match the connector as built. Keep
  both general: nothing about one particular deployment.
- Commit and push only when the user asks, and check first whether the repository is public: if
  it is, nothing about the owner, their accounts or the live address may go into it (see
  `references/lessons.md`). A push may open a GitHub sign-in window the user has to complete. Open
  the pull request against `main`; the user merges it.
- Record privately, never in the repository: the live address, what is saved where, what was
  verified, what is left.

## Looking after a hosted connector

| The user wants | Do this |
|---|---|
| Replace an expired upstream token | Terminal prompt: `npx.cmd wrangler secret put <TOKEN_NAME>`; confirm with the status tool from Claude |
| Change the connector password, or suspects it leaked | Terminal prompt: `npx.cmd wrangler secret put CONNECTOR_PASSWORD`. This ends every connection; they connect again in Claude with the new one |
| Switch optional tools on or off | Edit the `vars` in `wrangler.jsonc`, `npm test`, `npx wrangler deploy` |
| Publish a code change | `npm test`, then `npx wrangler deploy`. Secrets and the Claude connection carry over |
| "Claude says the connector failed" | Read the status page, then `wrangler tail` while they retry. `exceededCpu` or error 1102 means the free plan's processor limit: move to Workers Paid |
| "Claude can't connect any more" | A `registration_refused` line in the log means Anthropic's addresses changed: set `REGISTRATION_SOURCES` in `wrangler.jsonc` |
| Asked to connect again | Normal after 30 idle days or a password change |

## When something here turns out to be wrong

Cloudflare, Claude's connector client and the libraries all move. The numbers and behaviours in
`references/lessons.md` are dated; when one no longer holds, fix the note in the skill as part of
the job so the next connector benefits.
