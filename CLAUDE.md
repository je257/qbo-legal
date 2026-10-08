# Working notes for this repository

Read this before touching anything. It records what has repeatedly gone
wrong while building the connectors in this repo, and what actually fixed it.

## What this repo is

Two private, local MCP connectors for Claude Desktop / Claude Code, plus the
static pages Intuit requires:

- `mcp/` — QuickBooks Online (`qbo-mcp`, tools `qbo_*`, config in `~/.qbo-mcp/`)
- `garmin-mcp/` — Garmin Connect (`garmin-mcp`, tools `garmin_*`, config in `~/.garmin-mcp/`)
- `README.md` + `SETUP.md` (QuickBooks), `garmin-mcp/README.md` + `garmin-mcp/SETUP.md` (Garmin)

Each package: TypeScript, Node 20+, `npm install` builds via `prepare`,
CLI `node dist/index.js [setup|auth|install|status|serve]`. `garmin-mcp` has
`npm test` (offline, mocked Garmin responses). Keep new connectors on the same
pattern, as a sibling folder, with their own beginner `SETUP.md`.

## Who uses this

The owner (je257) is not a programmer and runs everything on **Windows**
(PowerShell, Claude Desktop installed in `C:\Users\<name>\AppData\Roaming\Claude`).
They get code by merging the pull request and clicking **Download ZIP** on
`main`. So: work must be merged to `main` before they can use it, and every
instruction must be copy-paste level. Never ask for their passwords; the
connectors never store passwords, only tokens.

## Recurring failures and the fixes that worked

### 1. The connector doesn't appear in Claude Desktop (happened with BOTH connectors)

Symptoms: `setup` prints "Added the ... connector", but Settings → Developer
does not list it, and Claude says it has no such tools.

Facts established on the owner's machine (Oct 2026):
- Local MCP servers show **only** under Settings → Developer, never under
  Connectors or Extensions.
- The config file Desktop uses is the one its **Settings → Developer → Edit
  config** button opens (`%APPDATA%\Claude\claude_desktop_config.json`), the
  same path the installers write. Desktop also stores its own `preferences`
  in that file.
- An entry written by our installer did **not** show up, twice, including
  once with Desktop fully quit first. The same entry **pasted through Edit
  config** (Notepad) showed up immediately after a full restart. The exact
  mechanism is unknown; do not claim to know it. A theory that Desktop
  rewrites the file on quit was NOT confirmed.
- A hand edit with a stray comma/brace makes Desktop silently drop the
  **entire** `mcpServers` list (the owner saw "it deleted QuickBooks").

What works: give the owner the **complete, valid file** (or the exact block
with their real paths, which `install` now prints) to paste via Edit config,
then a full quit (system tray → Quit, confirm in Task Manager) and reopen.
Both installers print that block; keep it that way.

### 2. "Fully quit" Claude Desktop

Closing the window does not quit it. Windows: system tray **^** → right-click
Claude → Quit, or Ctrl+Shift+Esc and End task on every "Claude" entry. Mac:
Cmd+Q. Say this every time you ask for a restart.

### 3. Implementing a third-party sign-in from memory

The first Garmin `sso.ts` reproduced an old embed-widget login from memory.
It would have failed on the first real run: Garmin had moved to a JSON login
(`/mobile/api/login`) and the maintained library had moved to a different
token exchange. The fix came from **downloading the current upstream source
from PyPI** (`garth`, `garminconnect`) into an isolated directory and
cross-checking every path, parameter, header and payload. Rule: for any
reverse-engineered API, fetch the current reference implementation first
(PyPI is reachable from the cloud sandbox; GitHub raw usually is not) and
port from the source, never from recollection. Prefer the actively
maintained library when two disagree.

### 4. Nothing third-party can be tested live from the cloud sandbox

`garmin.com`, `connectapi.garmin.com` and `sso.garmin.com` are blocked by the
sandbox proxy; Intuit is likewise untestable without the owner's tokens.
Build offline tests that replay the exact responses (see `garmin-mcp/test/`)
and say plainly in the PR what was and was not verified live. The owner's
first run is the live test; ask them to paste terminal output on failure.

### 5. Usage limits

A 159-agent verification fan-out exhausted the owner's session limit. Keep
agent fan-outs small; verify remaining findings by hand against the
downloaded source instead of re-launching agents.

### 6. Windows specifics already handled in the guides (don't regress them)

`npm.cmd install` when PowerShell blocks scripts; the ZIP must be *extracted*,
not browsed; the OAuth URL is opened with `rundll32 url.dll,FileProtocolHandler`
because `start` splits on `&`; Node 20+ is required (`Headers.getSetCookie`);
the QuickBooks refresh token dies after ~100 days of disuse.

## Pull-request workflow

- Develop on the designated `claude/...` branch, push, open a PR with the
  body describing exactly what was verified. The owner merges it.
- If the PR was merged, restart the branch from `origin/main` before any
  follow-up (`git checkout -B <branch> origin/main`), then open a new PR.
- Update the beginner `SETUP.md` whenever a step changes. The owner reads
  that file, not the code.
