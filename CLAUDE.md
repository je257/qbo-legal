# CLAUDE.md — project memory

Two independent local MCP connectors that give Claude Desktop / Claude Code
access to the owner's accounting systems:

- `mcp/` — **qbo-mcp** (QuickBooks Online; OAuth authorization-code flow with
  a browser step; refresh token lapses after ~100 days of no use)
- `paychex/` — **paychex-mcp** (Paychex Flex payroll; OAuth client
  credentials — API key + secret, no browser step, tokens auto-renewed)

Both are TypeScript, built by `npm install` (the `prepare` script runs `tsc`
into `dist/`). CLI: `node dist/index.js [setup|auth|install|status|doctor|serve]`.
`setup` = `auth` then `install`. Credentials live in `~/.qbo-mcp/` /
`~/.paychex-mcp/` (mode 600), never in the repo. Static pages at the repo
root are served by GitHub Pages for the Intuit app (callback/privacy/EULA).

## How the owner runs this (support context — read before troubleshooting)

- **Windows + PowerShell**, following SETUP.md; no programming background,
  no git. They download the repo as a **ZIP from GitHub**, so code pushed to
  a branch is NOT on their machine until they re-download and re-extract.
  Their install lives under a path with a space (e.g.
  `C:\PayChex Connector\...`) — quote paths in any command you give them.
- They use **Claude Desktop**. Local MCP servers only appear in the Desktop
  app (Settings → Developer) or Claude Code — never on claude.ai in a
  browser.
- When dictating PowerShell commands that create files: their Windows
  PowerShell 5.1 `Set-Content -Encoding UTF8` writes a UTF-8 BOM, which
  JSON parsers (mcpb's manifest validator among them) reject with
  "Unexpected token ''". For ASCII-only content use `-Encoding ASCII`;
  otherwise `[IO.File]::WriteAllText($path, $text)` (BOM-less UTF-8).

## Recurring setup failures (seen multiple times — check these FIRST)

The single fastest diagnostic: have them run, in the connector's folder,

    node dist/index.js doctor

It checks Node, credentials, a live API call, company linkage, and whether
the server is actually registered in `claude_desktop_config.json`, and
prints the exact fix for whatever fails. Ask for its full output.

Known failure chain, in the order it usually happens:

1. **`npm install` fails on Windows**: "running scripts is disabled on this
   system" (PowerShell execution policy blocks `npm.ps1`). Fix:
   `npm.cmd install`, or once:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
2. **Because install failed, `dist/` doesn't exist**, so every
   `node dist/index.js ...` fails with "Cannot find module". Users often
   don't notice and think setup ran.
3. **`setup` = auth + install; if auth errors (or never ran), install never
   runs**, so nothing is written to Claude Desktop's config. The user
   restarts Claude Desktop and the tools are simply absent — no error
   anywhere. Fix: re-run `setup`. `install` alone suffices only when auth
   had already completed (a `Connected ...` line was printed) — for QBO,
   keys are saved BEFORE the browser step, so saved keys do not imply a
   connected company. `install` now verifies its write and says what to
   check.
4. **Claude Desktop wasn't fully quit** — closing the window is not enough.
   Windows: system-tray Claude icon → Quit (the `^` overflow arrow may hide
   it). Then reopen and check Settings → Developer for the server name.
5. **Folder moved/renamed after install** → the config points at a dead
   path. Fix: `node dist/index.js install` from the new location.
6. **Paychex: key works but zero companies** → the Paychex Flex company was
   never linked to the app at developer.paychex.com (a company admin must
   approve). No re-setup needed once linked.
7. **QBO: 401 on token exchange** → mistyped Client ID/Secret or
   Development/Production keys mixed up. Re-run auth, type `n`, re-enter.
8. **Claude Desktop REWRITES `claude_desktop_config.json` and wipes entries
   added while it was running.** Observed directly (2026-09): the file held
   `qbo` + `ninety` + `paychex`; after a restart it held only `qbo` (the one
   entry the app knew at its last launch) plus the app's own `preferences`
   keys. This is the root cause behind "I installed it, restarted, and the
   tools are gone" — and it silently killed the owner's Ninety connector the
   same way. The procedure that sticks, in this order: (1) quit Claude
   Desktop completely and verify in Task Manager that no Claude processes
   remain, (2) run `node dist/index.js install` while it is closed, (3)
   verify the entry is in the file (doctor or Get-Content), (4) only then
   launch Claude Desktop. `install` detects a running Claude Desktop and
   prints this warning itself.
   **Escalation (observed on the owner's newer Claude Desktop build,
   2026-09):** the app rewrites the file even at launch and while running
   (its own `preferences` keys keep appearing, e.g. an `autoResumeRateLimit`
   entry referencing a live session), and entries added to the file are
   discarded even when present at launch — the quit-first procedure was
   followed correctly and paychex still never appeared. On such builds the
   file route is dead for NEW servers (old entries like `qbo`, held in the
   app's internal store, keep working). The reliable path is a **Desktop
   Extension**: each connector folder has a committed `manifest.json` +
   `.mcpbignore`; run `npx -y @anthropic-ai/mcpb pack` (Windows:
   `npx.cmd`) in the folder to produce `<name>-<version>.mcpb`, then
   install it via Claude Desktop → Settings → Extensions → Advanced
   settings → Install extension… Saved credentials in `~/.paychex-mcp` /
   `~/.qbo-mcp` are used unchanged. See SETUP.md "Plan B".
   **CONFIRMED WORKING (2026-09-15):** the owner installed paychex-mcp
   this way and the tools came alive — Plan B is the proven install path
   on their machine. Do NOT suggest double-clicking the `.mcpb`: with no
   file association Windows opens it in a text editor ("a bunch of
   gibberish"); go straight to the Install extension… picker.

Claude Desktop's config file: `%APPDATA%\Claude\claude_desktop_config.json`
(Windows), `~/Library/Application Support/Claude/claude_desktop_config.json`
(Mac). Each connector registers itself under `mcpServers.qbo` /
`mcpServers.paychex` with an absolute node path + absolute `dist/index.js`
path. Hand-editing that file is the fallback when `install` can't run.

## Conventions for changes

- Keep the two packages mirror images: same CLI commands, same file layout
  (`config.ts`, `auth.ts`, `<api>.ts`, `server.ts`, `install.ts`,
  `doctor.ts`, `index.ts`), same error-message style ("what happened + the
  exact command to fix it", written for a non-programmer).
- Paychex shipped read-only by design; on 2026-09-15 the owner explicitly
  requested write capability ("I entitled the API to have full
  capabilities"), so `paychex_write` (generic POST/PATCH/PUT/DELETE,
  destructive-hinted, confirm-before-writing description) was added.
  Keep any further write conveniences within that decision — and treat
  payroll-mutating behavior changes as needing the owner's say-so.
- After source changes, rebuild (`npm run build`) and update README.md and
  SETUP.md — the owner installs from SETUP.md's copy-paste commands, and
  wrong docs cost a full support round-trip.
- Commit `package-lock.json` files; `dist/` and `node_modules/` stay
  ignored.
