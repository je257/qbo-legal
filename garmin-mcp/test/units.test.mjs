import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip, importDist } from "./helpers.mjs";

const { oauth1Header } = await importDist("oauth1.js");
const { extractZip } = await importDist("zip.js");
const { extractTitle, extractCsrf, extractTicket, parseWidgetMfaVars, decodeJwtPayload } = await importDist("sso.js");

test("OAuth1 HMAC-SHA1 signature matches Twitter's documented example", () => {
  const url = new URL("https://api.twitter.com/1.1/statuses/update.json?include_entities=true");
  const header = oauth1Header({
    method: "POST",
    url,
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: "1318622958",
  });
  assert.equal(decodeURIComponent(/oauth_signature="([^"]+)"/.exec(header)[1]), "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("ZIP extractor handles deflated and stored entries", () => {
  const zip = buildZip([
    { name: "12345_ACTIVITY.fit", data: "FIT".repeat(1000), method: 8 },
    { name: "readme.txt", data: "stored-file", method: 0 },
  ]);
  const entries = extractZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.data.length]), [["12345_ACTIVITY.fit", 3000], ["readme.txt", 11]]);
  assert.equal(entries[0].data.toString(), "FIT".repeat(1000));
  assert.throws(() => extractZip(Buffer.from("not a zip")), /Not a ZIP/);
});

test("widget page parsers", () => {
  const signin = `<html><head><title>GARMIN Authentication Application</title></head><body><input type="hidden" name="_csrf" value="abc123DEF-_=" /></body></html>`;
  assert.equal(extractTitle(signin), "GARMIN Authentication Application");
  assert.equal(extractCsrf(signin), "abc123DEF-_=");
  const success = `<html><head>\n<title>Success</title></head><body><script>var response_url = "https:\\/\\/sso.garmin.com\\/sso\\/embed?ticket=ST-0123456-aBcDeFgHiJkLmNoPqRsT-cas";</script></body></html>`;
  assert.equal(extractTitle(success), "Success");
  assert.equal(extractTicket(success), "ST-0123456-aBcDeFgHiJkLmNoPqRsT-cas");
  assert.equal(extractTicket("<html></html>"), undefined);
  const mfa = `<script>var customerGuid = "guid-1"; var mfaMethod = "EMAIL"; var locale = "en_US"; var clientId = "GarminConnect"; var codeSentTo = "";</script>`;
  assert.deepEqual(parseWidgetMfaVars(mfa), { customerGuid: "guid-1", mfaMethod: "EMAIL", locale: "en_US", clientId: "GarminConnect", codeSentTo: "" });
});

test("JWT payload decoding rejects alg=none", () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.deepEqual(decodeJwtPayload(`${b64u({ alg: "RS256" })}.${b64u({ exp: 5, client_id: "x" })}.s`), { exp: 5, client_id: "x" });
  assert.equal(decodeJwtPayload(`${b64u({ alg: "none" })}.${b64u({ exp: 5 })}.`), undefined);
  assert.equal(decodeJwtPayload("garbage"), undefined);
});
