# Setup guide (beginner-friendly)

This connects Claude to your Garmin Connect account. You only do this once,
and it takes about 10 minutes. No programming knowledge needed — every
command below is copy-paste.

**What you need before starting:**

- Your Garmin Connect email and password (the ones you use in the Garmin
  Connect app). If you have two-step verification turned on, have your
  phone or email handy for the code.
- The [Claude Desktop app](https://claude.ai/download) installed
- About 10 minutes

---

## Step 1 — Install Node.js

Node.js is the free program that runs the connector.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version.
2. Run the installer and accept all the defaults.
3. Check it worked: open a terminal
   (**Mac:** press Cmd+Space, type `Terminal`, press Enter.
   **Windows:** press the Windows key, type `powershell`, press Enter)
   and type:

   ```
   node --version
   ```

   You should see a version number like `v22.20.0` (anything 20 or higher
   is fine). If you see "command not found", close the terminal, open a new
   one, and try again.

## Step 2 — Download this project

1. On the [GitHub page for this project](https://github.com/je257/qbo-legal),
   click the green **Code** button → **Download ZIP**.
2. Unzip the downloaded file:
   - **Mac:** double-click the ZIP — a folder appears next to it.
   - **Windows:** right-click the ZIP → **Extract All...** → **Extract**.
     (Just double-clicking the ZIP only *peeks inside* it. You must Extract.)
3. The folder is called **`qbo-legal-main`**. Move it somewhere permanent —
   for example your Documents folder. **Don't delete it later** — Claude runs
   the connector from it. (If you ever move it, open a terminal in its
   `garmin-mcp` folder — see Step 3 — and run `node dist/index.js install`
   again.)

   Already have this folder from setting up the QuickBooks connector? Reuse
   it — the Garmin connector lives in its `garmin-mcp` subfolder.

## Step 3 — Open a terminal in the right folder

You need the terminal to be "inside" the `garmin-mcp` folder, which is inside
the `qbo-legal-main` folder you unzipped.

- **Mac:** open Terminal, type `cd ` (with a space after it), then drag the
  `garmin-mcp` folder from Finder onto the Terminal window, and press Enter.
- **Windows:** open the `garmin-mcp` folder in File Explorer, click in the
  address bar at the top, type `powershell`, and press Enter.

To check you're in the right place, type `ls` and press Enter — you should
see `package.json` in the list.

## Step 4 — Connect it (two commands)

In that terminal, run this first (it downloads the connector's parts —
takes a minute):

```
npm install
```

Lines starting with `npm warn` are normal and safe to ignore — only
`npm error` means something failed. (**Windows:** if you instead see
*"running scripts is disabled on this system"*, type `npm.cmd install` — it
does the same thing.)

Then run:

```
node dist/index.js setup
```

This walks you through everything:

1. **Region** — just press Enter (only pick `china` if your Garmin account
   is on garmin.cn).
2. **Email and password** — type your Garmin Connect email, press Enter,
   then your password. The password is hidden as you type (nothing appears
   on screen — that's normal). Press Enter.
3. **Two-step code** — if your account has two-step verification, Garmin
   sends a 6-digit code to your email or phone. Type it and press Enter.
4. It signs in and then adds itself to Claude Desktop automatically. You
   should see `Added the "garmin" Garmin Connect connector to Claude Desktop`.

Your password is used only to sign in and is not saved anywhere. The
sign-in stays valid for about a year.

## Step 5 — Restart Claude and try it

1. Fully quit Claude Desktop (**Mac:** Cmd+Q. **Windows:** right-click the
   Claude icon in the system tray → Quit; if you don't see the icon, click
   the **^** arrow at the right end of the taskbar to show hidden icons)
   and open it again.
2. Ask Claude:

   > Use garmin_daily_summary to show my stats for today.

If it shows your steps and heart rate — you're done. From now on you can
ask things like "how did I sleep this week?", "compare my resting heart
rate this month to last month", "what's my training readiness?", or
"download yesterday's run as a FIT file".

---

## If something goes wrong

- **"node: command not found"** — Node.js isn't installed or the terminal
  is stale. Redo Step 1 and open a fresh terminal.
- **"garmin-mcp needs Node.js 20 or newer"** — your Node.js is too old.
  Install the current LTS from nodejs.org and open a new terminal.
- **"running scripts is disabled on this system" (Windows)** — use
  `npm.cmd install` instead of `npm install`.
- **`ls` doesn't show `package.json`** — you're in the wrong folder. Redo
  Step 3 (make sure it's the `garmin-mcp` folder *inside* `qbo-legal-main`).
- **"Cannot find module ... dist/index.js"** — `npm install` didn't finish.
  Run it again in the `garmin-mcp` folder and let it complete.
- **"Garmin sign-in did not succeed"** — the email or password was
  mistyped, or the two-step code was wrong/expired. Run
  `node dist/index.js auth` and try again.
- **"Garmin rate-limited the sign-in attempt (HTTP 429)"** — too many
  sign-in attempts. Wait an hour and run `node dist/index.js auth` again.
- **Claude says it can't see any garmin tools** — make sure you fully quit
  and reopened Claude Desktop (closing the window is not enough).
- **It worked for months, then stopped** — the sign-in expires after about
  a year, or after you change your Garmin password. In the `garmin-mcp`
  folder, run `node dist/index.js auth` to sign in again.
- **You moved or renamed the project folder** — run
  `node dist/index.js install` from the folder's new location.
- **See the saved connection details** — run `node dist/index.js status`.

## Using Claude Code instead of Claude Desktop?

After Step 4's `setup` finishes, it prints a `claude mcp add garmin ...`
command — copy and run that one line, and skip Step 5's restart.
