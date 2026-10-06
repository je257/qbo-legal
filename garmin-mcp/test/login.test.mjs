import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { freshHome, importDist, json, jwt, form, mockFetch, noDelays } from "./helpers.mjs";

const home = freshHome();
const { login, refreshDiToken, nativeHeaders } = await importDist("sso.js");
const { GarminClient } = await importDist("garmin.js");
noDelays();

const now = Math.floor(Date.now() / 1000);
const config = { domain: "garmin.com" };
const SSO = "sso.garmin.com";
const DI = "diauth.garmin.com";
const API = "connectapi.garmin.com";
const fx = mockFetch();
const { calls, route, at } = fx;
const noMfa = { promptMfa: async () => { throw new Error("no mfa expected"); }, log: () => {} };
const okProfile = () => route(at(API, "/userprofile-service/socialProfile"), () => json({ displayName: "abc" }));
const diOk = () =>
  route(at(DI, "/di-oauth2-service/oauth/token"), (r) => {
    const f = form(r.body);
    return json({ access_token: jwt({ exp: now + 3600, client_id: f.client_id }), refresh_token: "refresh-1", token_type: "Bearer" });
  });

test("mobile (iOS) login exchanges the ticket for a DI token with the native app's request shape", async () => {
  fx.reset();
  route(at(SSO, "/mobile/api/login"), () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-1-abc-cas" }));
  diOk();
  okProfile();
  const auth = await login(config, "me@example.com", "pw", noMfa);
  assert.equal(auth.method, "di");
  assert.equal(auth.di.refreshToken, "refresh-1");
  assert.equal(auth.di.clientId, "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2");
  assert.equal(auth.di.expiresAt, now + 3600);
  const [loginReq, diReq, verifyReq] = calls;
  assert.deepEqual(Object.fromEntries(loginReq.url.searchParams), { clientId: "GCM_IOS_DARK", locale: "en-US", service: "https://mobile.integration.garmin.com/gcm/ios" });
  assert.deepEqual(JSON.parse(loginReq.body), { username: "me@example.com", password: "pw", rememberMe: true, captchaToken: "" });
  assert.match(loginReq.headers["User-Agent"], /^Mozilla\/5\.0 \(iPhone; CPU iPhone OS 18_7/);
  assert.equal(loginReq.headers.Accept, "application/json, text/plain, */*");
  assert.equal(loginReq.headers["Content-Type"], "application/json");
  assert.equal(loginReq.headers.Origin, "https://sso.garmin.com");
  assert.deepEqual(form(diReq.body), {
    client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
    service_ticket: "ST-1-abc-cas",
    grant_type: "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket",
    service_url: "https://mobile.integration.garmin.com/gcm/ios",
  });
  assert.equal(diReq.headers.Authorization, "Basic " + Buffer.from("GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2:").toString("base64"));
  assert.equal(diReq.headers["User-Agent"], "GCM-Android-5.23");
  assert.equal(diReq.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(verifyReq.headers.Authorization, `Bearer ${auth.di.accessToken}`);
  assert.equal(verifyReq.headers["X-Garmin-User-Agent"], nativeHeaders()["X-Garmin-User-Agent"]);
});

test("MFA: wrong code is retried, session cookie is carried, both verify endpoints are tried", async () => {
  fx.reset();
  const verifyCalls = [];
  route(at(SSO, "/mobile/api/login"), () =>
    json({ responseStatus: { type: "MFA_REQUIRED" }, customerMfaInfo: { mfaLastMethodUsed: "sms" } }, { headers: [["set-cookie", "SESSION=mfa-sess; Path=/"]] }),
  );
  route((r) => r.url.host === SSO && /\/api\/mfa\/verifyCode$/.test(r.url.pathname), (r) => {
    verifyCalls.push(r);
    if (JSON.parse(r.body).mfaVerificationCode !== "654321") return json({ responseStatus: { type: "INVALID_MFA_CODE", message: "Invalid code" } });
    return json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-2-mfa-cas" });
  });
  diOk();
  okProfile();
  const codes = ["000000", "654321"];
  const prompted = [];
  const auth = await login(config, "me@example.com", "pw", { promptMfa: async (m) => { prompted.push(m); return codes.shift(); }, log: () => {} });
  assert.equal(auth.method, "di");
  assert.deepEqual(prompted, ["sms", "sms"]);
  assert.equal(calls.filter((c) => c.url.pathname === "/mobile/api/login").length, 1);
  assert.deepEqual(verifyCalls.map((r) => r.url.pathname), ["/mobile/api/mfa/verifyCode", "/portal/api/mfa/verifyCode", "/mobile/api/mfa/verifyCode"]);
  assert.deepEqual(Object.fromEntries(verifyCalls[1].url.searchParams), { clientId: "GarminConnect", locale: "en-US", service: "https://connect.garmin.com/app" });
  assert.deepEqual(JSON.parse(verifyCalls[2].body), { mfaMethod: "sms", mfaVerificationCode: "654321", rememberMyBrowser: true, reconsentList: [], mfaSetup: false });
  assert.match(verifyCalls[0].headers.Cookie, /SESSION=mfa-sess/);
  assert.equal(form(calls.find((c) => c.url.host === DI).body).service_ticket, "ST-2-mfa-cas");
});

test("wrong password stops the cascade immediately", async () => {
  fx.reset();
  route(at(SSO, "/mobile/api/login"), () => json({ responseStatus: { type: "INVALID_USERNAME_PASSWORD" } }));
  await assert.rejects(login(config, "me@example.com", "wrong", noMfa), (e) => e.kind === "credentials");
  assert.equal(calls.length, 1);
});

test("429 then 403 on the mobile logins falls through to the embedded widget", async () => {
  fx.reset();
  const SIGNIN = `<html><head><title>GARMIN Authentication Application</title></head><body><input type="hidden" name="_csrf" value="csrf-123"/></body></html>`;
  const SUCCESS = `<html><head><title>Success</title></head><body><script>var response_url = "https:\\/\\/sso.garmin.com\\/sso\\/embed?ticket=ST-3-widget-cas";</script></body></html>`;
  route((r) => at(SSO, "/mobile/api/login")(r) && r.url.searchParams.get("clientId") === "GCM_IOS_DARK", () => new Response("", { status: 429 }));
  route((r) => at(SSO, "/mobile/api/login")(r) && r.url.searchParams.get("clientId") === "GCM_ANDROID_DARK", () => new Response("<html>challenge</html>", { status: 403 }));
  route(at(SSO, "/sso/embed"), () => new Response("<html></html>", { status: 200, headers: [["set-cookie", "GARMIN-SSO=w1; Path=/; Secure"]] }));
  route((r) => at(SSO, "/sso/signin")(r) && r.method === "GET", () => new Response(SIGNIN, { status: 200 }));
  route((r) => at(SSO, "/sso/signin")(r) && r.method === "POST", () => new Response(SUCCESS, { status: 200 }));
  diOk();
  okProfile();
  const auth = await login(config, "me@example.com", "pw", noMfa);
  assert.equal(auth.method, "di");
  const post = calls.find((c) => c.method === "POST" && c.url.pathname === "/sso/signin");
  assert.deepEqual(form(post.body), { username: "me@example.com", password: "pw", embed: "true", _csrf: "csrf-123" });
  assert.match(post.headers.Cookie, /GARMIN-SSO=w1/);
  assert.match(post.headers.Referer, /^https:\/\/sso\.garmin\.com\/sso\/signin\?id=gauth-widget/);
  assert.equal(form(calls.find((c) => c.url.host === DI).body).service_url, "https://sso.garmin.com/sso/embed");
});

test("DI exchange refused for every client id falls back to garth's OAuth1 exchange", async () => {
  fx.reset();
  route(at(SSO, "/mobile/api/login"), () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-5-cas" }));
  route(at(DI, "/di-oauth2-service/oauth/token"), () => new Response('{"error":"invalid_grant"}', { status: 400 }));
  route(at("thegarth.s3.amazonaws.com", "/oauth_consumer.json"), () => json({ consumer_key: "ck", consumer_secret: "cs" }));
  route(at(API, "/oauth-service/oauth/preauthorized"), () => new Response("oauth_token=ot&oauth_token_secret=os", { status: 200 }));
  route(at(API, "/oauth-service/oauth/exchange/user/2.0"), () => json({ access_token: "o2", token_type: "Bearer", expires_in: 3600, refresh_token_expires_in: 7200 }));
  okProfile();
  const auth = await login(config, "me@example.com", "pw", noMfa);
  assert.equal(auth.method, "oauth1");
  assert.deepEqual(
    calls.filter((c) => c.url.host === DI).map((c) => form(c.body).client_id),
    ["GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4", "GARMIN_CONNECT_MOBILE_ANDROID_DI", "GARMIN_CONNECT_MOBILE_IOS_DI"],
  );
  const pre = calls.find((c) => c.url.pathname === "/oauth-service/oauth/preauthorized");
  assert.deepEqual(Object.fromEntries(pre.url.searchParams), { ticket: "ST-5-cas", "login-url": "https://mobile.integration.garmin.com/gcm/ios", "accepts-mfa-tokens": "true" });
  assert.match(pre.headers.Authorization, /^OAuth oauth_consumer_key="ck"/);
  assert.equal(pre.headers["User-Agent"], "com.garmin.android.apps.connectmobile");
  assert.deepEqual(form(calls.find((c) => c.url.pathname === "/oauth-service/oauth/exchange/user/2.0").body), { audience: "GARMIN_CONNECT_MOBILE_ANDROID_DI" });
  assert.equal(calls.at(-1).headers["User-Agent"], "GCM-iOS-5.22.1.4");
  assert.equal(JSON.parse(readFileSync(`${home}/config.json`, "utf8")).consumerKey, "ck");
});

test("a token the API rejects moves on to the next strategy", async () => {
  fx.reset();
  let n = 0;
  route(at(SSO, "/mobile/api/login"), () => json({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: `ST-6-${++n}-cas` }));
  diOk();
  let verifyN = 0;
  route(at(API, "/userprofile-service/socialProfile"), () => (++verifyN === 1 ? new Response('{"message":"Token is not active"}', { status: 401 }) : json({})));
  await login(config, "me@example.com", "pw", noMfa);
  assert.deepEqual(calls.filter((c) => c.url.pathname === "/mobile/api/login").map((c) => c.url.searchParams.get("clientId")), ["GCM_IOS_DARK", "GCM_ANDROID_DARK"]);
  assert.equal(form(calls.filter((c) => c.url.host === DI).at(-1).body).service_url, "https://mobile.integration.garmin.com/gcm/android");
});

test("every strategy rate-limited yields one clear error", async () => {
  fx.reset();
  route((r) => r.url.host === SSO, () => new Response("", { status: 429 }));
  await assert.rejects(login(config, "me@example.com", "pw", noMfa), (e) => e.kind === "rate-limit" && /every sign-in method/.test(e.message));
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/mobile/api/login", "/mobile/api/login", "/sso/embed", "/portal/sso/en-US/sign-in"]);
});

test("DI refresh keeps the old refresh token when none is returned", async () => {
  fx.reset();
  route(at(DI, "/di-oauth2-service/oauth/token"), () => json({ access_token: jwt({ exp: now + 7200, client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2" }) }));
  const refreshed = await refreshDiToken("garmin.com", { accessToken: "old", refreshToken: "refresh-1", clientId: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", expiresAt: now - 10 });
  assert.deepEqual(form(calls[0].body), { grant_type: "refresh_token", client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", refresh_token: "refresh-1" });
  assert.equal(refreshed.refreshToken, "refresh-1");
  assert.equal(refreshed.expiresAt, now + 7200);
});

test("client refreshes an expiring token before the call and retries once on 401", async () => {
  fx.reset();
  writeFileSync(
    `${home}/tokens.json`,
    JSON.stringify({
      domain: "garmin.com",
      createdAt: 1,
      profile: { displayName: "abc" },
      auth: { method: "di", di: { accessToken: "expired", refreshToken: "refresh-1", clientId: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", expiresAt: now - 5 } },
    }),
  );
  let refreshes = 0;
  route(at(DI, "/di-oauth2-service/oauth/token"), () => json({ access_token: jwt({ exp: now + 7200, client_id: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2" }), refresh_token: `refresh-${++refreshes + 1}` }));
  let apiN = 0;
  route(at(API, "/hrv-service/hrv/2026-10-01"), (r) => (++apiN === 1 ? new Response("", { status: 401 }) : json({ ok: true, auth: r.headers.Authorization })));
  const result = await GarminClient.load().get("/hrv-service/hrv/2026-10-01");
  assert.equal(refreshes, 2);
  const stored = JSON.parse(readFileSync(`${home}/tokens.json`, "utf8")).auth.di;
  assert.equal(result.auth, `Bearer ${stored.accessToken}`);
  assert.equal(stored.refreshToken, "refresh-3");
});
