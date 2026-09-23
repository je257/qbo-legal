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

## Maintenance

- **Revoke access:** delete the token in Ninety's Developer Settings, and/or
  delete `~/.ninety-mcp/`.
- **Rebuild after changing the source:** `cd ninety-mcp && npm run build`.

Independent integration built on Ninety's public API. Not affiliated with
Ninety Technologies LLC.
