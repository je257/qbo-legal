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
2. Unzip it, and move the unzipped folder somewhere permanent — for example
   your Documents folder. **Don't delete or move this folder later** — Claude
   runs the connector from it. (If you do move it, just redo Step 5.)

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

You need the terminal to be "inside" the `mcp` folder of the project you
downloaded.

- **Mac:** open Terminal, type `cd ` (with a space after it), then drag the
  `mcp` folder from Finder onto the Terminal window, and press Enter.
- **Windows:** open the `mcp` folder in File Explorer, click in the address
  bar at the top, type `powershell`, and press Enter.

To check you're in the right place, type `ls` and press Enter — you should
see `package.json` in the list.

## Step 5 — Connect it (two commands)

In that terminal, run this first (it downloads the connector's parts —
takes a minute):

```
npm install
```

Then run:

```
node dist/index.js setup
```

This walks you through everything:

1. It asks for the **Client ID** and **Client Secret** — copy them from the
   Intuit page you kept open. For the environment and redirect questions,
   just press Enter to accept the defaults.
2. Your browser opens a QuickBooks sign-in page. Sign in, pick your
   company, and click **Connect**.
3. You land on a page titled "Authorization received" with a **Copy**
   button. Click it, go back to the terminal, paste (right-click pastes
   in PowerShell), and press Enter.
4. It then adds itself to Claude Desktop automatically. You should see
   `Added the "qbo" QuickBooks connector to Claude Desktop`.

## Step 6 — Restart Claude and try it

1. Fully quit Claude Desktop (**Mac:** Cmd+Q. **Windows:** right-click the
   Claude icon in the system tray → Quit) and open it again.
2. Ask Claude:

   > Use qbo_company_info to show my company profile.

If it shows your company's name and address — you're done. From now on you
can ask things like "show me a profit & loss for last month" or "which
invoices are overdue?"

---

## If something goes wrong

- **"node: command not found"** — Node.js isn't installed or the terminal
  is stale. Redo Step 1 and open a fresh terminal.
- **`ls` doesn't show `package.json`** — you're in the wrong folder. Redo
  Step 4 (make sure it's the `mcp` folder *inside* the project folder).
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
- **Check the connection any time** — run `node dist/index.js status`.

## Using Claude Code instead of Claude Desktop?

After Step 5's `setup` finishes, it prints a `claude mcp add qbo ...`
command — copy and run that one line, and skip Step 6's restart.
