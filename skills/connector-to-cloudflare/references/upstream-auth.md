# Upstream credentials: three kinds of connector

"Upstream" is the service the connector talks to (Ninety, QuickBooks, Garmin, and so on).
The sign-in in front of the Worker is the same for all of them. What differs is how the Worker
holds the credential it uses upstream. Work out which kind the connector is by reading its own
`auth.ts` / `config.ts` before estimating anything; do not rely on memory of how a service
authenticates, because several of these were reverse-engineered and have changed before.

## A. A fixed token or API key

Examples: Ninety (Personal Access Token), or any service that issues an API key.

This is the template as it stands. The token is one Worker secret, read at call time in
`cloud/deps.ts`. Nothing is stored in KV for it.

- Have the user create a **separate** token for the hosted connector so it can be replaced or
  revoked without touching the desktop one.
- Find out how long it lives and say so (Ninety: at most 365 days). The error text for a 401
  should say how to replace the secret; that is `tokenHelp` in the client.
- Replacing it is one Terminal prompt: `npx.cmd wrangler secret put <NAME>`.

## B. OAuth upstream, with refresh tokens that rotate

Example: QuickBooks Online (Intuit). Payroll and banking APIs are often of this kind too.

The Worker has to keep a refresh token that changes over time, so a secret is not enough:

- **Client id and client secret** are Worker secrets.
- **Access and refresh tokens live in KV** under one key, written whenever they are refreshed.
  Use a separate KV namespace or a clearly separate key prefix from the sign-in storage, and
  remember that KV writes are scarce on the free plan (a refresh is one write).
- The Worker needs **two extra routes**, both behind the owner's sign-in or an equivalent check:
  one that starts the upstream consent (`/upstream/connect`) and the upstream's redirect target
  (`/upstream/callback`). The redirect address must be registered with the upstream app exactly.
  Keep the `state` value in KV for ten minutes and check it on return.
- **Refresh inside the tool call** when the access token is close to expiry, and write the new
  pair back before using it. Two requests refreshing at once can invalidate each other with
  rotating refresh tokens; serialise it (a short KV lock, or accept one retry) and test it.
- Surface a dead refresh token as a clear tool error that tells the owner to reconnect upstream.
  Intuit refresh tokens die after about 100 days without use, and at once if the client secret is
  regenerated.

An earlier experiment served QuickBooks from a single hand-written Worker. Its Intuit OAuth and
KV token handling are a useful reference, but **its access protection must not be reused**: a
secret in the URL path with no sign-in is not acceptable for anything that can write, and neither
is implementing the MCP protocol by hand. Put the upstream-token logic behind this template
instead.

The same "state in KV, redirect, exchange, store" pattern applies to the library's upstream
helpers (`beginUpstream` / `finishUpstream`, see the library's `docs/upstream-sign-in.md`), but
those are for signing the *user* in through a third party. Here the owner signs in with the
connector password and the upstream consent is a separate, one-time setup step.

## C. A session obtained by logging in with a username and password

Example: Garmin Connect (no official API for individuals; the desktop connector reproduces the
mobile app's login and stores the resulting tokens).

Treat this as the hard case and tell the user so before starting:

- The login may not work from Cloudflare's addresses at all (bot detection, CAPTCHA, rate limits
  per address). Test that first, with the user's consent, before building anything else.
- Never put the user's account password in a Worker secret if a token can be used instead. The
  workable shape is: log in **on the PC** with the existing desktop connector, then carry the
  long-lived tokens to the Worker (a Terminal prompt that reads them from the local file and pipes
  them into `wrangler secret put`, without printing them). The Worker refreshes the short-lived
  token from the long-lived one and stores the result in KV, as in B.
- When the long-lived token expires the user repeats the PC step. Say how often that is.
- Logins rebuilt from another app's behaviour change without notice. Port from the connector's
  current code and the current upstream library source, not from recollection.

## Choosing what to host at all

Not every connector is worth hosting, and it is the user's call once they have the facts:

- **Sensitivity.** A hosted connector is reachable from the internet behind one password, and on
  an organization plan everyone in the organization can see that it exists. Where the data is
  about other people or is financial, raise leaving out the write tools, or hosting a read-only
  subset, before building.
- **Tools that produce files.** Some tools save a file to the PC (charts, PDFs, activity
  downloads). A Worker has no disk the user can reach. Either leave those tools out of the hosted
  build or return a link or the data itself.
- **Long jobs.** Anything that needs minutes, large batches or pacing (a large bulk
  update, for example) belongs on the desktop: Claude allows 240 seconds per call and the hosted
  client gives up after 60.
