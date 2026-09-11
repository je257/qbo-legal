# ninety-mcp

A local MCP (Model Context Protocol) server that connects Claude Desktop or
Claude Code to [Ninety.io](https://www.ninety.io/) through Ninety's public
REST API (`https://api.public.ninety.io/v1`).

Your Personal Access Token stays on your own machine
(`~/.ninety-mcp/config.json`, owner-only file permissions). Nothing is hosted
anywhere.

## Easiest install: the Desktop extension (no terminal)

`ninety.mcpb` in this folder is a one-file installer for Claude Desktop
([download it here](https://github.com/je257/qbo-legal/raw/claude/gifted-gates-mytp5y/ninety-mcp/ninety.mcpb)).
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
| `ninety_teams` | List the teams the token can access |
| `ninety_user_get` | Get a user by Id (name, primary email) |
| `ninety_todos_query` | List/filter To-Dos (team, personal, completed, search, paging) |
| `ninety_todo_get` / `ninety_todo_create` / `ninety_todo_update` / `ninety_todo_delete` | To-Do CRUD |
| `ninety_issues_query` | List/filter Issues (team, short/long-term, search, paging) |
| `ninety_issue_get` / `ninety_issue_create` / `ninety_issue_update` / `ninety_issue_delete` | Issue CRUD |
| `ninety_rocks_query` | List/filter Rocks (team, owner, status, level, future scope, paging) |
| `ninety_rock_get` / `ninety_rock_create` / `ninety_rock_update` / `ninety_rock_delete` | Rock CRUD (get includes milestones) |
| `ninety_milestone_get` / `ninety_milestone_create` / `ninety_milestone_update` | Milestones on Rocks |
| `ninety_kpis_query` | List/filter Scorecard Measurables (KPIs) and their metadata |
| `ninety_put_score` | Create/overwrite a Measurable score for a period |
| `ninety_put_note` | Create/overwrite a Measurable note for a period |
| `ninety_delete_score` / `ninety_delete_note` | Remove a score/note for a period |
| `ninety_request` | Raw authenticated request against any `/v1/...` endpoint (escape hatch) |

Every call retries automatically on `429 Too Many Requests` (respecting
`Retry-After`, exponential backoff otherwise) and on transient 5xx errors, so
batch score writes no longer need manual pacing.

## Public API limits worth knowing

These are constraints of Ninety's public API (v1), not of this connector:

- **Scorecard values cannot be read.** `ninety_kpis_query` returns Measurable
  metadata (including `lastScoreUpdatedAt`, `isSmart`, `isUsedInFormula`) but
  not score values; scores are write/overwrite/delete only. If Ninety ships a
  score-read endpoint later, `ninety_request` can call it immediately.
- **Never write scores to formula (`isSmart`) Measurables** — they compute
  from other Measurables. Formula definitions can't be edited via the API.
- **Milestones** have no delete and no list endpoint (they come embedded in
  each Rock).
- **Users** can only be fetched by Id — there is no list endpoint.
- **Tokens expire** (lifespan chosen at creation). On 401, generate a new
  token and re-run `node dist/index.js auth`.
- `GET /v1/swagger.json` (via `ninety_request`) returns the live OpenAPI spec
  if you want Claude to discover endpoints added after this connector was
  built.

## Maintenance

- **Revoke access:** delete the token in Ninety's Developer Settings, and/or
  delete `~/.ninety-mcp/`.
- **Rebuild after changing the source:** `cd ninety-mcp && npm run build`.

Independent integration built on Ninety's public API. Not affiliated with
Ninety Technologies LLC.
