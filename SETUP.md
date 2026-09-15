# Setup guide (beginner-friendly)

This connects Claude to your QuickBooks Online account. You only do this
once, and it takes about 15 minutes. No programming knowledge needed —
every command below is copy-paste.

**What you need before starting:**

- Your QuickBooks Online login (must be an admin on the company)
- The [Claude Desktop app](https://claude.ai/download) installed
- About 15 minutes

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

   You should see a version number like `v22.20.0`. If you see
   "command not found", close the terminal, open a new one, and try again.

## Step 2 — Download this project

1. On the [GitHub page for this project](https://github.com/je257/qbo-legal),
   click the green **Code** button → **Download ZIP**.
2. Unzip the downloaded file:
   - **Mac:** double-click the ZIP — a folder appears next to it.
   - **Windows:** right-click the ZIP → **Extract All...** → **Extract**.
     (Just double-clicking the ZIP only *peeks inside* it — it looks like a
     normal folder but nothing will work from there. You must Extract.)
3. The folder is called **`qbo-legal-main`**. Move it somewhere permanent —
   for example your Documents folder. **Don't delete it later** — Claude runs
   the connector from it. (If you ever move it, open a terminal in its `mcp`
   folder — see Step 4 — and run `node dist/index.js install` again.)

## Step 3 — Get your QuickBooks keys

The connector needs two codes from Intuit (the company behind QuickBooks)
so QuickBooks knows to trust it.

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in
   with the **same account you use for QuickBooks**.
2. If you already created an app here before, open it. Otherwise click
   **Create an app**, choose **QuickBooks Online and Payments**, give it any
   name (e.g. "Claude Connector"), and select the
   **com.intuit.quickbooks.accounting** scope.
3. In your app, find **Keys & credentials** and switch to the
   **Production** keys. (Intuit may first ask you to fill in a few app
   details — for the privacy policy and EULA links, use:
   - `https://je257.github.io/qbo-legal/privacy.html`
   - `https://je257.github.io/qbo-legal/eula.html` )
4. On the same Keys & credentials page, add this **Redirect URI**, exactly:

   ```
   https://je257.github.io/qbo-legal/callback.html
   ```

5. Keep this page open — you'll copy the **Client ID** and **Client Secret**
   from it in the next step.

## Step 4 — Open a terminal in the right folder

You need the terminal to be "inside" the `mcp` folder, which is inside the
`qbo-legal-main` folder you unzipped.

- **Mac:** open Terminal, type `cd ` (with a space after it), then drag the
  `mcp` folder from Finder onto the Terminal window, and press Enter.
- **Windows:** open the `mcp` folder in File Explorer, click in the address
  bar at the top, type `powershell`, and press Enter.

To check you're in the right place, type `ls` and press Enter — you should
see `package.json` in the list.

## Step 5 — Connect it (two commands)

**Before you run anything: if Claude Desktop is open, fully quit it now.**
(**Windows:** right-click the Claude icon in the system tray → Quit — click
the **^** arrow at the right end of the taskbar if the icon is hidden.
**Mac:** Cmd+Q.) Claude Desktop can silently undo connector changes made
while it is running, so it must stay closed until Step 6.

In that terminal, run this first (it downloads the connector's parts —
takes a minute):

```
npm install
```

It should end with a line like `added 92 packages`. Lines starting with
`npm warn` are normal and safe to ignore — only `npm error` means something
failed. (**Windows:** if you instead see *"running scripts is disabled on
this system"*, type `npm.cmd install` — it does the same thing.)

Then run:

```
node dist/index.js setup
```

This walks you through everything:

1. It asks for the **Client ID** and **Client Secret** — copy them from the
   Intuit page you kept open. For the environment and redirect questions,
   just press Enter to accept the defaults. (Running it again later? It
   offers your saved keys — press Enter to reuse them, or type `n` to enter
   different ones.)
2. Your browser opens a QuickBooks sign-in page. Sign in, pick your
   company, and click **Connect**. (If no page opens, or the page shows an
   error, copy the long web address printed in the terminal and paste it
   into your browser's address bar instead.)
3. You land on a page titled "Authorization received" with a **Copy**
   button. Click it, go back to the terminal, paste (right-click pastes
   in PowerShell), and press Enter.
4. It then adds itself to Claude Desktop automatically. You should see
   `Added the "qbo" QuickBooks connector to Claude Desktop`.

## Step 6 — Open Claude and try it

1. Open Claude Desktop. (If it turns out it was open during Step 5 — the
   install step prints an IMPORTANT warning when it notices — fully quit it
   first: **Mac:** Cmd+Q; **Windows:** system-tray Claude icon → Quit. Then
   run `node dist/index.js install` once more with it closed, and only then
   open it — otherwise the connector you just added can be lost.)
2. Ask Claude:

   > Use qbo_company_info to show my company profile.

If it shows your company's name and address — you're done. From now on you
can ask things like "show me a profit & loss for last month" or "which
invoices are overdue?"

---

## If something goes wrong

**Start here:** in the connector's folder (`mcp` or `paychex`), run

```
node dist/index.js doctor
```

It checks everything — Node, your saved keys, the live connection, and
whether Claude Desktop actually knows about the connector — and prints the
exact fix for whatever failed. The list below covers the same ground by
hand:

- **Claude restarted, but the tools are missing** (nothing under Claude
  Desktop → Settings → Developer) — the setup command never finished, so it
  never registered itself. This usually happens when `npm install` had
  failed first (so `setup` errored with "Cannot find module"). Run
  `npm.cmd install`, let it finish, then `node dist/index.js setup` again —
  or, if the connect step had already succeeded earlier (the terminal
  printed a `Connected to ...` line), just `node dist/index.js install`.
  (Saved keys alone are not enough — the connection step must have
  finished.) Run the install/setup command with Claude Desktop fully quit,
  and only open Claude Desktop afterward — see the next bullet for why the
  order matters.
- **The connector was registered, but vanished after restarting Claude** —
  Claude Desktop can rewrite its config file when it exits, wiping entries
  that were added while it was running. The order matters: **quit Claude
  Desktop completely first** (Windows: press Ctrl+Shift+Esc for Task
  Manager, End task on every Claude entry), **then** run
  `node dist/index.js install`, and only then open Claude Desktop. The
  install command warns you when it detects Claude Desktop running.
- **"node: command not found"** — Node.js isn't installed or the terminal
  is stale. Redo Step 1 and open a fresh terminal.
- **"running scripts is disabled on this system" (Windows)** — use
  `npm.cmd install` instead of `npm install`, or run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, answer `Y`,
  and retry.
- **`ls` doesn't show `package.json`** — you're in the wrong folder. Redo
  Step 4 (make sure it's the `mcp` folder *inside* `qbo-legal-main`). On
  Windows, this also happens when the ZIP was never really extracted —
  right-click it → **Extract All** (Step 2).
- **"Cannot find module ... dist/index.js"** — `npm install` didn't finish.
  Run it again in the `mcp` folder and let it complete.
- **"Token request failed (401)"** — the saved Client ID/Secret are wrong
  (mistyped, or Development keys mixed up with Production). Run
  `node dist/index.js setup` again and type `n` when it offers the saved
  keys, then enter the correct ones.
- **Intuit won't show Production keys** — finish the required app-detail
  fields (Step 3.3), including the privacy/EULA links.
- **Browser shows an Intuit error instead of the sign-in page** — the
  Redirect URI in Step 3.4 doesn't match exactly. Fix it and run
  `node dist/index.js setup` again.
- **Claude says it can't see any qbo tools** — make sure you fully quit
  and reopened Claude Desktop (closing the window is not enough).
- **It worked for months, then stopped** — the QuickBooks connection
  expires after ~100 days of no use. In the `mcp` folder, run
  `node dist/index.js auth` to reconnect.
- **You moved or renamed the project folder** — run
  `node dist/index.js install` from the folder's new location.
- **See the saved connection details** (company, when the connection
  expires) — run `node dist/index.js status`.

## Using Claude Code instead of Claude Desktop?

After Step 5's `setup` finishes, it prints a `claude mcp add qbo ...`
command — copy and run that one line, and skip Step 6's restart.

---

## Also connecting Paychex Flex (payroll)?

This project includes a second connector for Paychex Flex. It's even
simpler than the QuickBooks one — there's no browser approval step.

1. **Get your Paychex keys.** Sign in at
   [developer.paychex.com](https://developer.paychex.com) and create an
   application (any name works). Copy its **API key** and **secret**. Then
   link your Paychex Flex company to the application in the portal — a
   company admin has to approve it. (If you skip this, the connector will
   say it can't see any companies yet.)
2. **Open a terminal in the `paychex` folder** — same trick as Step 4
   above, but use the `paychex` folder instead of `mcp`.
3. **Fully quit Claude Desktop if it's open** (system tray → Quit), then
   **run the two commands:**

   ```
   npm install
   node dist/index.js setup
   ```

   Paste the API key and secret when asked. It confirms the connection,
   shows your company, and adds itself to Claude Desktop.
4. **Open Claude Desktop** (same as Step 6 — quit it fully first if it was
   open) and ask:

   > Use paychex_companies to list my payroll companies.

---

## Plan B — install as a Desktop Extension

Some newer versions of Claude Desktop manage the config file themselves and
**discard connector entries added to it from outside** — the symptom is
that the connector never shows up under Settings → Developer no matter how
carefully you follow the steps above (existing older entries keep working).
If that's you, install the connector through Claude Desktop's own
Extensions screen instead:

1. Open a terminal in the connector's folder (`paychex` or `mcp`, as in
   Step 4) and run:

   ```
   npx.cmd -y @anthropic-ai/mcpb pack
   ```

   (On Mac/Linux: `npx -y @anthropic-ai/mcpb pack`.) It downloads a small
   packaging tool and produces a file like `paychex-mcp-0.1.0.mcpb` in the
   folder.
2. In Claude Desktop, go to **Settings → Extensions → Advanced settings →
   Install extension…**, pick the `.mcpb` file from the connector's folder,
   and click **Install**. (If it refuses because the extension is unsigned,
   allow unsigned/development extensions under those same Advanced settings
   and retry. Don't bother double-clicking the `.mcpb` file — without a
   file association Windows just opens it as gibberish in a text editor.)
3. The connector now appears under Settings → Extensions and survives
   restarts. Your saved keys keep working — no need to redo the auth step.
4. Ask Claude: "Use paychex_companies to list my payroll companies."

If something goes wrong, run `node dist/index.js doctor` in the `paychex`
folder — it checks everything and prints the fix. The fixes in "If
something goes wrong" above apply here too — just read `mcp` as `paychex`.
A "Token request failed (401)" means the API key or secret was mistyped:
run `setup` again and type `n` to re-enter them.
