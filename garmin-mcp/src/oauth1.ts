import { createHmac, randomBytes } from "node:crypto";

/** RFC 3986 percent-encoding as required by OAuth 1.0a. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export interface OAuth1SignOptions {
  method: string;
  url: URL;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  /** Form-encoded body parameters (included in the signature base string). */
  bodyParams?: Record<string, string>;
  /** Overrides for deterministic testing. */
  nonce?: string;
  timestamp?: string;
}

/**
 * Builds an OAuth 1.0a HMAC-SHA1 `Authorization` header value for a request.
 * Query-string parameters and form body parameters are folded into the
 * signature base string as the spec requires.
 */
export function oauth1Header(opts: OAuth1SignOptions): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };
  if (opts.token) oauthParams.oauth_token = opts.token;

  const pairs: [string, string][] = [];
  for (const [k, v] of opts.url.searchParams) pairs.push([k, v]);
  for (const [k, v] of Object.entries(opts.bodyParams ?? {})) pairs.push([k, v]);
  for (const [k, v] of Object.entries(oauthParams)) pairs.push([k, v]);

  const normalized = pairs
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseUrl = `${opts.url.protocol}//${opts.url.host.toLowerCase()}${opts.url.pathname}`;
  const baseString = [opts.method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join("&");
  const signingKey = `${percentEncode(opts.consumerSecret)}&${percentEncode(opts.tokenSecret ?? "")}`;
  oauthParams.oauth_signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(", ")
  );
}
