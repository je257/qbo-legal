// The few HTML pages the hosted connector shows a person: the sign-in page and the status page.
// No external assets, no cookies of our own, and every value that did not come from this file is escaped.

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --ink: #1c1f24; --soft: #5b6470; --line: #d5dae1; --page: #f6f7f9; --card: #ffffff; --accent: #1f5fbf; --bad: #b3261e; --good: #1a7f4b; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaed; --soft: #a3acb8; --line: #3a4048; --page: #15171a; --card: #1e2125; --accent: #7fb0ff; --bad: #ff8a80; --good: #6fd39b; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--page); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { font-size: 1.35rem; line-height: 1.25; margin: 0 0 12px; }
h2 { font-size: 1.05rem; margin: 24px 0 8px; }
p { margin: 0 0 12px; }
.soft { color: var(--soft); font-size: 0.92rem; }
.error { color: var(--bad); font-weight: 600; }
.warn { border-left: 4px solid var(--bad); padding-left: 12px; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input[type=password], input[type=text] { width: 100%; padding: 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
.check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; margin: 14px 0 0; }
.check input { margin-top: 5px; }
.actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
button { font: inherit; font-weight: 600; padding: 12px 20px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
@media (prefers-color-scheme: dark) { button.primary { color: #10131a; } }
code { font: 0.9em ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
ul { padding-left: 1.2rem; margin: 0 0 12px; }
li { margin-bottom: 6px; }
.yes { color: var(--good); font-weight: 600; }
.no { color: var(--bad); font-weight: 600; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface PageSecurity {
  /** Other origins a form on this page may end up at (the app the sign-in result is sent to). */
  formTargets?: string[];
  /** Allows the one inline script carrying this nonce. Without it the page runs no script at all. */
  scriptNonce?: string;
}

/** Headers for every HTML page: never cached, never framed, nothing loaded from anywhere else. */
export function pageHeaders(base: Headers | undefined, security: PageSecurity = {}): Headers {
  const headers = new Headers(base);
  const formAction = ["'self'", ...(security.formTargets ?? [])].join(" ");
  const script = security.scriptNonce ? ` script-src 'nonce-${security.scriptNonce}';` : "";
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline';${script} base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

export function messagePage(title: string, paragraphs: string[]): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1>\n${paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("\n")}`);
}

export interface SignInView {
  /** The app's self-chosen name. Not verified: anyone can register under any name. */
  clientName: string;
  /** Where the sign-in result is sent. This is the fact that identifies the app. */
  redirectHost: string;
  redirectIsLoopback: boolean;
  /** One-time reference to the sign-in request, kept by the server. */
  handle: string;
  /** Whether "sign out every other connection" is ticked. */
  signOutOthers: boolean;
  error?: string;
}

export function signInPage(view: SignInView): string {
  const name = escapeHtml(view.clientName);
  const host = escapeHtml(view.redirectHost);
  return shell(
    "Connect to your Ninety connector",
    `<h1>Connect to your Ninety connector</h1>
<p><strong>${name}</strong> is asking to use this connector. If you allow it, access is sent to <strong>${host}</strong>.</p>
<p class="soft">Continue only if you just chose Connect for this connector in Claude. The app's name is whatever it called itself; the address above is what counts.</p>
${
  view.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to a program on your own computer.</strong> Continue only if you started this sign-in from that program a moment ago.</p>'
    : ""
}
${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ""}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escapeHtml(view.handle)}">
  <input type="hidden" name="client" value="${name}">
  <input type="hidden" name="host" value="${host}">
  <input type="hidden" name="loopback" value="${view.redirectIsLoopback ? "1" : ""}">
  <label for="password">Connector password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  <p class="soft">The password saved in Cloudflare as <code>CONNECTOR_PASSWORD</code>. It is not your Ninety or Claude password.</p>
  <label class="check"><input type="checkbox" name="signOutOthers" value="1"${view.signOutOthers ? " checked" : ""}> <span>Also sign out every other connection to this connector</span></label>
  <div class="actions">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny" formnovalidate>Cancel</button>
  </div>
</form>`,
  );
}

export interface StatusView {
  mcpUrl: string;
  /** Where requests carrying the Ninety token go. Always Ninety's API outside the tests. */
  apiAddress: string;
  tokenSet: boolean;
  passwordSet: boolean;
  passwordTooShort: boolean;
  storageBound: boolean;
  deleteTools: boolean;
  rawRequest: boolean;
  minPasswordLength: number;
  scriptNonce: string;
}

export function statusPage(view: StatusView): string {
  const mark = (ok: boolean, yes: string, no: string) =>
    ok ? `<span class="yes">${escapeHtml(yes)}</span>` : `<span class="no">${escapeHtml(no)}</span>`;
  const ready = view.tokenSet && view.passwordSet && view.storageBound;
  return shell(
    "Ninety connector",
    `<h1>Ninety connector</h1>
<p>${
      ready
        ? "This private connector is set up. It only answers after its owner signs in."
        : "This private connector is running but <strong>not finished setting up</strong>. See the list below."
    }</p>
<h2>Setup</h2>
<ul>
  <li>Ninety token (secret <code>NINETY_API_TOKEN</code>): ${mark(view.tokenSet, "saved", "missing")}</li>
  <li>Connector password (secret <code>CONNECTOR_PASSWORD</code>): ${
    view.passwordSet
      ? '<span class="yes">saved</span>'
      : `<span class="no">${view.passwordTooShort ? `too short, needs at least ${view.minPasswordLength} characters` : "missing"}</span>`
  }</li>
  <li>Sign-in storage (<code>OAUTH_KV</code>): ${mark(view.storageBound, "connected", "missing")}</li>
  <li>Delete tools: ${view.deleteTools ? "on" : "off"}. Raw request tool: ${view.rawRequest ? "on" : "off"}.</li>
  <li>Ninety requests go to: <code>${escapeHtml(view.apiAddress)}</code></li>
</ul>
<p class="soft">Secrets are added in the Cloudflare dashboard: Workers &amp; Pages, this Worker, Settings, Variables and Secrets. This page never shows their values.</p>
<h2>Add it to Claude</h2>
<p>On a computer, at claude.ai: Customize, Connectors, Add custom connector, and paste this address:</p>
<p><code>${escapeHtml(view.mcpUrl)}</code></p>
<p class="soft">Then choose Connect and type the connector password. After that it is available in the Claude phone app too.</p>
<h2>Need a connector password?</h2>
<p>Here is a freshly made random one. It was created in your browser just now and is not saved anywhere: reload for another. Keep it in your password manager.</p>
<p><code id="suggestion">(needs JavaScript)</code></p>
<script nonce="${escapeHtml(view.scriptNonce)}">
(function () {
  // 56 characters with the look-alikes (I, O, l, o, 0, 1) left out; 28 of them is about 160 bits.
  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  var out = "";
  // Rejection sampling (224 = 4 x 56) so every character is equally likely.
  while (out.length < 28) {
    var bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length && out.length < 28; i++) {
      if (bytes[i] < 224) out += alphabet[bytes[i] % 56];
    }
  }
  document.getElementById("suggestion").textContent = out.replace(/(.{7})(?=.)/g, "$1-");
})();
</script>`,
  );
}
