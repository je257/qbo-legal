# ninety-mcp

An MCP (Model Context Protocol) server that connects Claude to
[Ninety.io](https://www.ninety.io/) through Ninety's public REST API
(`https://api.public.ninety.io/v1`). The same tools come in two builds:

- **Desktop** (the default, described below): runs on your own computer for
  Claude Desktop or Claude Code. Your Personal Access Token stays on your
  machine (`~/.ninety-mcp/config.json`) and nothing is hosted anywhere.
- **Hosted** (optional): runs as a Cloudflare Worker so the Claude **phone
  app** can use it with your computer off. See
  [SETUP-CLOUD.md](SETUP-CLOUD.md) and "Hosted build" below.

## Easiest install: the Desktop extension (no terminal)

`ninety.mcpb` in this folder is a one-file installer for Claude Desktop
([download it here](https://github.com/je257/qbo-legal/raw/main/ninety-mcp/ninety.mcpb)).
Open Claude Desktop → **Settings → Extensions**, drag the downloaded file in
(or double-click it), and paste your Ninety Personal Access Token into the
form field. That's it — no config file, no commands. The token field can be
left blank on a machine where the terminal `auth` step already saved one.

Rebuild it after changing the source:

```sh
npx -y esbuild extension/main.ts --bundle --platform=node --target=node18 \
  --format=cjs --outfile=build/mcpb/server/index.js
cp extension/manifest.json build/mcpb/manifest.json
npx -y @anthropic-ai/mcpb pack build/mcpb ninety.mcpb
```

## Terminal setup (Claude Code, or if you prefer the config-file route)

Requires Node.js 18+ and a Ninety Personal Access Token.

1. Sign in to Ninety and open
   [User Settings → Developer Settings](https://app.ninety.io/settings/user/developer-settings).
2. Generate a Personal Access Token. You choose its lifespan (30 / 90 / 180 /
   365 days; default 90) — the token runs as *you* and respects your in-app
   permissions. Observers cannot generate tokens.
3. Install and configure:

```sh
cd ninety-mcp
npm install     # also builds (prepare script)
node dist/index.js setup
```

`setup` prompts for the token, verifies it against the API (it lists the teams
the token can see), stores it, and registers the server in Claude Desktop's
`claude_desktop_config.json` (backing up the existing config first). It also
prints the equivalent one-liner for Claude Code:

```sh
claude mcp add ninety -- node /absolute/path/to/qbo-legal/ninety-mcp/dist/index.js
```

Each step is also runnable on its own: `auth`, `install`, `status`, `serve`.

Environment variables (override the stored config):

| Variable | Purpose |
| --- | --- |
| `NINETY_API_TOKEN` | Personal Access Token (takes precedence over the config file) |
| `NINETY_API_BASE_URL` | API base URL (default `https://api.public.ninety.io`) |
| `NINETY_MCP_DIR` | Config directory (default `~/.ninety-mcp`) |

## Tools exposed to Claude

| Tool | What it does |
| --- | --- |
| `ninety_auth_status` | Token configured? Verifies it by listing teams |
| `ninety_teams` / `ninety_teams_available` | List teams (yours / all you may create work for) |
| `ninety_users` / `ninety_team_users` / `ninety_user_get` | List company users (by email too), a team's users, or one user |
| `ninety_todos_query` | List/filter To-Dos (team, assignees, due-date range, search; `paged` for totals) |
| `ninety_todos_company` | Company-wide To-Dos, cursor-paginated (Owners/Admins only) |
| `ninety_todo_get` / `ninety_todo_create` / `ninety_todo_update` / `ninety_todo_delete` | To-Do CRUD (create/update can link a Rock/Issue/Milestone) |
| `ninety_todo_comment` / `ninety_todo_link` / `ninety_todo_unlink` | Comment on a To-Do; manage its links |
| `ninety_issues_query` / `ninety_issues_company` | List/filter Issues; company-wide list (Owners/Admins) |
| `ninety_issue_get` / `ninety_issue_create` / `ninety_issue_update` / `ninety_issue_delete` / `ninety_issue_comment` | Issue CRUD + comments |
| `ninety_rocks_query` / `ninety_rocks_company` | List/filter Rocks (`paged` for flat page + totals); company-wide list |
| `ninety_rock_get` / `ninety_rock_create` / `ninety_rock_update` / `ninety_rock_delete` / `ninety_rock_milestones` | Rock CRUD + its milestones |
| `ninety_milestone_get` / `ninety_milestone_create` / `ninety_milestone_update` | Milestones on Rocks |
| `ninety_kpis_query` | List/filter Scorecard Measurables (KPIs) and their metadata |
| `ninety_team_scorecard` | **Read** a team's scorecard: measurables with score values, notes, goals per period |
| `ninety_get_score` | **Read** one measurable's score for the period containing a date |
| `ninety_put_score` / `ninety_put_note` | Create/overwrite a Measurable score / note for a period |
| `ninety_update_score` | Patch score, note, and/or per-period goal override in one call (null clears) |
| `ninety_delete_score` / `ninety_delete_note` | Remove a score/note for a period |
| `ninety_meeting_next` / `ninety_meetings` / `ninety_meeting_get` | A team's next meeting; past meetings with ratings; one meeting with notes |
| `ninety_vto` | A team's Vision/Traction Organizer (plus the leadership team's shared sections) |
| `ninety_accountability_chart` | Every Seat, its responsibilities, and who holds it |
| `ninety_headlines` / `ninety_headline_create` | List / create Headlines and Cascading Messages |
| `ninety_request` | Raw authenticated request against any `/v1/...` endpoint (escape hatch) |

The API reference this connector was built against is checked in at
[`openapi/swagger.json`](openapi/swagger.json); the live version is at
`GET /v1/swagger.json`.

Every call retries automatically on `429 Too Many Requests` (respecting
`Retry-After`, exponential backoff otherwise) and on transient 5xx errors, so
batch score writes no longer need manual pacing.

## Public API limits worth knowing

These are constraints of Ninety's public API (v1), not of this connector:

- **Never write scores to formula (`isSmart`) Measurables** — they compute
  from other Measurables. Formula definitions can't be edited via the API.
- **Milestones** have no delete endpoint.
- **Company-wide listings** (`*_company`) return 403 for anyone who is not a
  company Owner or Admin.
- **Tokens expire** (lifespan chosen at creation). On 401, generate a new
  token and re-run `node dist/index.js auth` (or update the token field in
  the extension's settings).
- `GET /v1/swagger.json` (via `ninety_request`) returns the live OpenAPI spec
  if you want Claude to discover endpoints added after this connector was
  built.

## Hosted build (for the Claude phone app)

The Claude phone app can only use connectors that live on the internet, so
`cloud/` holds a second entry point that serves the same tools from a
Cloudflare Worker. [SETUP-CLOUD.md](SETUP-CLOUD.md) is the step-by-step guide.

- **Sign-in.** Nobody reaches the tools without signing in through OAuth
  (`@cloudflare/workers-oauth-provider`). The sign-in page asks for a connector
  password that only the owner knows, and only hands access to Claude's own
  address. No secret is ever part of a URL. Every connection is tied to the
  password it was made with, so changing the password ends them all.
- **Who can register.** Only Anthropic's published address ranges may register
  an app, and only with Claude's redirect address (`REGISTRATION_SOURCES` and
  `ALLOWED_REDIRECT_URIS` override the defaults).
- **Secrets.** `NINETY_API_TOKEN` and `CONNECTOR_PASSWORD` are Worker secrets,
  set with `npx wrangler secret put <NAME>`. They are not in this repository.
- **Optional tools.** The six delete tools (plus clearing a score or note) and
  `ninety_request` are controlled by `ENABLE_DELETE_TOOLS` and
  `ENABLE_RAW_REQUEST`. Without those settings they are left out (41 of the 48
  tools). This repository's `wrangler.jsonc` switches both on, so the hosted
  connector offers all 48.
- **Stricter limits.** One request to Ninety answers within 60 seconds, a
  create is never sent twice, and a result is cut at 100,000 characters with a
  clear notice.

| Folder | What it is |
| --- | --- |
| `src/server.ts`, `src/ninety.ts`, `src/constants.ts` | The tools and the HTTP client, shared by both builds |
| `src/stdio.ts`, `src/local.ts`, `src/config.ts`, `src/index.ts` | Desktop only |
| `cloud/` | Hosted only: Worker entry, sign-in page, MCP endpoint, server pool |
| `wrangler.jsonc` | Cloudflare settings for the hosted build |
| `test/` | Tests for both builds |

Publishing and testing the hosted build need Node.js 22.12 or newer; the
desktop connector itself still runs on Node 18.

```sh
npm test          # both builds; the hosted one runs locally in Cloudflare's runtime
npm run deploy    # tests, then publishes the Worker (needs: npx wrangler login)
```

## Maintenance

- **Revoke access:** delete the token in Ninety's Developer Settings, and/or
  delete `~/.ninety-mcp/`.
- **Rebuild after changing the source:** `cd ninety-mcp && npm run build`.
- **Check nothing changed for the desktop build:** `npm test` compares its 48
  tool definitions, and the request each one sends, with a recording of
  v0.2.0. After an intended change to the tools, re-record with
  `scripts/dump-tools.mjs` and `scripts/record-behaviour.mjs`.
- **The committed `ninety.mcpb`** is the v0.2.0 build. Rebuild it (commands
  above) and bump `extension/manifest.json` when you want the desktop
  extension to pick up source changes.

Independent integration built on Ninety's public API. Not affiliated with
Ninety Technologies LLC.
