# Ninety connector in the cloud: setup guide

This puts your own Ninety connector on the internet (on Cloudflare's free plan) so the Claude
**phone app** can use it with your computer switched off. If you already use the desktop
extension, it keeps working and is not touched.

The commands below are written for Windows. On macOS or Linux, leave out `.cmd` (type `npm` and
`npx`).

| | |
|---|---|
| Cost | Free on Cloudflare's free plan |
| Time | About 30 minutes the first time |
| You need | A Cloudflare account, your Ninety login, somewhere safe to keep two secrets |
| On this computer | Node.js 22.12 or newer (for the publishing tool; the desktop connector itself needs only Node 18) |

Your connector's address is printed at the end of Step 3. Open it in a browser at any time to see
its status page.

## How it is protected

- Nobody can use the connector without signing in. Signing in means typing a **connector password**
  that only you know, on a page that only hands access to Claude.
- Your Ninety token and the connector password are stored as **secrets** in Cloudflare. They are
  never in a web address, never in this folder, and never shown on any page.
- Every connection is tied to the password it was made with. **Changing the connector password
  ends every connection at once**, yours included; you then connect again with the new one.
- Only Claude's own servers can register with the connector, and it answers at one address only.
- As shipped, the hosted copy has **all 48 tools**, the same as the desktop connector, including the six
  delete tools and the raw "call any endpoint" tool. In Claude, keep every tool that changes or
  deletes something on **Needs approval**, so nothing is altered without you seeing it first.
  See "Changing what it can do" to leave the riskier tools out.

---

## Step 1. Create the Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and create an account. Verify your email.
2. Turn on two-step sign-in: the person icon (top right), **My Profile**, **Authentication**,
   **Two-Factor Authentication**. This account will hold your Ninety token, so treat it like your
   bank login.

You do not need a payment card or a paid plan.

## Step 2. Connect this computer to Cloudflare

Open a terminal in the `ninety-mcp` folder and run these, one at a time:

```powershell
npm.cmd install
```

```powershell
npx.cmd wrangler login
```

A Cloudflare page opens in your browser. Sign in if asked and click **Allow**.

## Step 3. Publish the connector

```powershell
npm.cmd run deploy
```

This runs the tests (a minute or two) and then publishes. Near the end it prints the address. The
first time, the connector's storage is created automatically. If you are asked to choose a
`workers.dev` subdomain for your account, pick a name that says nothing about you or the
connector. A brand-new address can take a few minutes before it opens in a browser.

Open the address. You should see a page titled **Ninety connector**. Two items under **Setup** say
**missing**; the next step fixes them.

## Step 4. Save the two secrets

You paste each secret into a prompt in the terminal. Nothing appears as you paste; that is on
purpose. Press Enter afterwards and wait for `Success!`.

**The connector password.** Any password of at least 16 characters that you can find again. A long
random one from a password manager is best; you only type it when you connect. Save it wherever
you keep passwords first, then:

```powershell
npx.cmd wrangler secret put CONNECTOR_PASSWORD
```

**The Ninety token.** Make a new one for this connector rather than reusing one you use
elsewhere, so each can be replaced without disturbing the other:

1. Sign in to Ninety and open <https://app.ninety.io/settings/user/developer-settings>.
2. Generate a **Personal Access Token**, give it a name you will recognise, and choose a lifespan
   (up to 365 days). Copy it; Ninety shows it only once.

```powershell
npx.cmd wrangler secret put NINETY_API_TOKEN
```

Reload the status page. All three setup items should be green.

> Never paste the token or the password into a chat with Claude or anyone else. The terminal prompt
> (or the Cloudflare dashboard: Workers & Pages, ninety-mcp, Settings, Variables and Secrets, Add,
> type **Secret**) is the only place they go.

## Step 5. Add the connector to Claude (on a computer)

The address to give Claude is the connector's address with `/mcp` on the end, for example
`https://ninety-mcp.YOUR-SUBDOMAIN.workers.dev/mcp`.

**If your Claude is a Team or Enterprise plan**, an Owner adds
it for the organization first:

1. Go to <https://claude.ai/admin-settings/connectors>, click **Add**, then **Custom** (choose
   **Web** if asked).
2. Name: `Ninety Cloud`. Address: the `/mcp` address above. Click **Continue**.
3. Leave the sign-in settings it marks **Detected** (if none are marked, choose
   **Register automatically**). Click **Add**.

Everyone on the Claude team will then see it in their list. They cannot use it without the
connector password, and because the connector acts as *you* in Ninety, do not share that password.

**If your Claude is a personal plan**, go to <https://claude.ai/customize/connectors>, choose
**Add**, then **Add custom connector**, and fill in the same name and address.

**Then, on either kind of plan, connect it for yourself:**

1. Go to <https://claude.ai/customize/connectors> and find **Ninety Cloud** (label **Custom**).
2. Click **Connect**. On the page that opens, check it says access is sent to **claude.ai**, paste
   the connector password, and click **Allow**.
3. In the connector's settings in Claude, set the tools that change things to **Needs approval**.

Try it in a new chat: *"Check my Ninety connection."* Claude should report **connected** and list
your teams.

## Step 6. Use it on your phone

1. Open the Claude app and start a new chat.
2. Tap **+**, then **Connectors**, and switch on **Ninety Cloud**.
3. Ask: *"What are my open To-Dos in Ninety?"*

If you also use the desktop extension, a computer now shows two Ninety connectors. Switch on
only one of them in a chat, so Claude is not offered every tool twice.

---

## Looking after it

### The Ninety token expires

A Ninety token lasts at most 365 days. When it expires, Claude reports that the token is missing,
invalid or expired. Generate a new token in Ninety and run the same command as in Step 4:

```powershell
npx.cmd wrangler secret put NINETY_API_TOKEN
```

Nothing else changes. Put a reminder in your calendar for shortly before the new one expires.

### Changing what it can do

Two lines in `wrangler.jsonc` in this folder decide which optional tools the hosted connector
offers. Both are `"true"` in the file as shipped:

- `ENABLE_DELETE_TOOLS`: the six delete tools (To-Do, To-Do link, Issue, Rock, score, note), and
  clearing a score or note. Deleting a To-Do or an Issue in Ninety is permanent.
- `ENABLE_RAW_REQUEST`: `ninety_request`, which can call any Ninety endpoint with any method.

Change either to `"false"` to leave those tools out (41 of the 48 remain), then publish again with
`npm.cmd run deploy`.

### After any change to the code

```powershell
npm.cmd run deploy
```

The two secrets, and your connection in Claude, stay in place across deploys.

### If you think someone else got in, or the password may have leaked

1. **Change the connector password.** This is the one that matters: it ends every connection at
   once, however many there are, and the old password stops working. Choose one this connector
   has never had before: going back to an earlier password would let back in a connection that
   was made with it and has stayed unused since.

   ```powershell
   npx.cmd wrangler secret put CONNECTOR_PASSWORD
   ```

   Then in Claude, open **Ninety Cloud** and connect again with the new password.
2. **If you want to be certain nothing more can happen in Ninety,** also delete the token in
   Ninety's Developer Settings and save a new one (Step 4). Until you do, the hosted connector
   cannot reach Ninety at all.

For something smaller, such as wanting to drop an old connection without changing the password:
connect again in Claude and tick **Also sign out every other connection to this connector** on the
sign-in page. It ends up to 200 connections in one go.

### If something is not working

- Open the connector's address (without `/mcp`) in a browser. The status page says which secret is
  missing or too short.
- **Claude cannot connect:** check the address in Claude ends in `/mcp`. Sign-in settings cannot be
  edited after a connector is added, so remove it in Claude and add it again.
- **Claude could connect before and now cannot register:** the connector only lets Anthropic's
  published addresses register. If Anthropic changes them, the log shows `registration_refused`.
  Put the new ranges in `REGISTRATION_SOURCES` in `wrangler.jsonc` (the line is there, commented
  out) and publish again.
- **"That password is not right":** it is the connector password, not your Ninety, Claude or
  Cloudflare password. After ten wrong tries in a minute it locks for a minute.
- **"Sign-in is switched off":** no connector password is saved yet, or it is shorter than 16
  characters. Repeat Step 4.
- **Claude asks you to connect again:** a connection that goes unused for 30 days ends, and so does
  every connection when the connector password is changed. Connect again with the password.
- **To see what happened:** Cloudflare dashboard, **Workers & Pages**, **ninety-mcp**, **Logs**.
  The log shows tool names and result codes, never your data, token or password.
- **Errors mentioning "exceeded CPU" or 1102:** Cloudflare's free plan allows about 10 ms of
  processor time per request, and some requests to the connector can need more. If these errors appear, moving the
  Worker to Cloudflare's paid plan (5 US dollars a month) removes the limit.
- **It stopped working until the next day:** Cloudflare's free plan has daily allowances for
  storage writes and requests. If they run out, the connector cannot renew its sign-in until they
  reset at midnight UTC. The paid plan has far larger monthly allowances.

### Removing it

Remove the connector in Claude, delete the **ninety-mcp** Worker in the Cloudflare dashboard, and
delete the token in Ninety's Developer Settings.
