import { DEFAULT_BASE_URL, DEVELOPER_SETTINGS_URL } from "./constants.js";

// The HTTP client for Ninety's public API. Portable: no Node-only imports, so the same code
// runs in the desktop (stdio) build and in the hosted (Cloudflare Worker) build. Where the token
// comes from is the caller's business; see local.ts (desktop) and cloud/deps.ts (hosted).

export class NinetyError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /**
   * The request creates something new each time it is sent (a To-Do, a comment, a Headline).
   * Under a policy with retryNonIdempotent=false it is re-sent only after a 429, which Ninety
   * rejected before doing anything, and never after a timeout or server error, where the first
   * attempt may have gone through.
   */
  nonIdempotent?: boolean;
}

export interface RetryPolicy {
  /** Total tries per request, including the first. */
  maxAttempts: number;
  /** A single try is abandoned after this long. */
  requestTimeoutMs: number;
  /** Longest wait between tries. */
  maxDelayMs: number;
  /**
   * Overall budget for one request, waits included. When set, the client also stops at once if
   * Ninety asks for a longer wait than maxDelayMs, and reports how long to wait instead of sleeping.
   * Unset = no overall limit (the desktop behaviour).
   */
  deadlineMs?: number;
  /** Re-send a nonIdempotent request after a timeout or server error. Can create duplicates. */
  retryNonIdempotent: boolean;
}

/** The desktop connector's behaviour since v0.1: patient, because nothing is waiting on a deadline. */
export const DESKTOP_RETRY: RetryPolicy = {
  maxAttempts: 5,
  requestTimeoutMs: 60_000,
  maxDelayMs: 60_000,
  retryNonIdempotent: true,
};

/**
 * For the hosted connector: Claude gives a tool call 240 seconds in total, so one request must
 * answer well inside that, and a phone user should get "rate limited, try again in 30 s" rather
 * than a silent multi-minute wait.
 */
export const HOSTED_RETRY: RetryPolicy = {
  maxAttempts: 3,
  requestTimeoutMs: 20_000,
  maxDelayMs: 8_000,
  deadlineMs: 60_000,
  retryNonIdempotent: false,
};

export interface NinetyClientOptions {
  baseUrl?: string;
  retry?: RetryPolicy;
  /** Appended to a 401 error: how to replace the token in this deployment. */
  tokenHelp?: string;
}

const MAY_HAVE_SUCCEEDED_NOTE =
  "\nNinety received this request and may well have carried it out, so it was not sent again. " +
  "Check (for example by listing recent items) before repeating it.";

const NOT_RETRIED_NOTE =
  "\nThis request creates something new, so it was not retried automatically: the first attempt may " +
  "already have gone through. Check (for example by listing recent items) before sending it again.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What Ninety asked for in Retry-After (seconds or an HTTP date), in milliseconds; undefined if absent. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return undefined;
}

export class NinetyClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly retry: RetryPolicy;
  private readonly tokenHelp: string;

  constructor(token: string, options: NinetyClientOptions = {}) {
    this.token = token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.retry = options.retry ?? DESKTOP_RETRY;
    this.tokenHelp = options.tokenHelp ?? `Generate a new one at ${DEVELOPER_SETTINGS_URL}.`;
  }

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseUrl + normalizedPath);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const policy = this.retry;
    const startedAt = Date.now();
    const remainingMs = (): number =>
      policy.deadlineMs === undefined ? Number.POSITIVE_INFINITY : policy.deadlineMs - (Date.now() - startedAt);
    // A request that must not be blindly re-sent under this policy.
    const guarded = options.nonIdempotent === true && !policy.retryNonIdempotent;

    let lastError: NinetyError | undefined;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const timeoutMs = Math.min(policy.requestTimeoutMs, remainingMs());
      if (timeoutMs <= 0) break;

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new NinetyError(
          `Network error calling ${method} ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (guarded) throw new NinetyError(lastError.message + NOT_RETRIED_NOTE);
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), policy.maxDelayMs);
        if (attempt < policy.maxAttempts && delayMs < remainingMs()) {
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      if (response.status === 429 || response.status >= 500) {
        const text = await response.text().catch(() => "");
        lastError = new NinetyError(
          `Ninety API ${method} ${normalizedPath} failed (${response.status}): ${text || response.statusText}`,
          response.status,
        );
        // A 429 was refused before Ninety did anything, so it is always safe to re-send.
        if (guarded && response.status !== 429) {
          throw new NinetyError(lastError.message + NOT_RETRIED_NOTE, response.status);
        }
        const askedMs = retryAfterMs(response);
        if (policy.deadlineMs !== undefined && askedMs !== undefined && askedMs > policy.maxDelayMs) {
          throw new NinetyError(
            `${lastError.message} — Ninety asked to wait ${Math.ceil(askedMs / 1000)} seconds before the next ` +
              "request. " +
              // Only a 429 is known to have been refused before Ninety did anything.
              (response.status === 429 ? "Nothing was changed by this call; try" : "Try") +
              " it again after that pause.",
            response.status,
          );
        }
        const delayMs = Math.min(askedMs ?? 1000 * 2 ** (attempt - 1), policy.maxDelayMs);
        if (attempt < policy.maxAttempts && delayMs < remainingMs()) {
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // The status arrived but the rest did not (a dropped connection or a stalled body).
        if (!response.ok) {
          // Ninety refused the request; only the explanation was lost. Refusals are final.
          throw new NinetyError(
            `Ninety API ${method} ${normalizedPath} failed (${response.status}): ` +
              (response.status === 401
                ? `Unauthorized — the Personal Access Token is missing, invalid, or expired. ${this.tokenHelp}`
                : "the response could not be read."),
            response.status,
          );
        }
        // A delete that Ninety answered with success is done. Sending it again could only come
        // back "not found" and replace the real outcome.
        if (method === "DELETE") return { ok: true, status: response.status };
        lastError = new NinetyError(
          `Ninety API ${method} ${normalizedPath} answered ${response.status}, but the rest of the response could ` +
            `not be read: ${error instanceof Error ? error.message : String(error)}`,
          response.status,
        );
        // Whatever the policy, a create that Ninety has already answered is never sent twice.
        if (options.nonIdempotent) throw new NinetyError(lastError.message + MAY_HAVE_SUCCEEDED_NOTE, response.status);
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), policy.maxDelayMs);
        if (attempt < policy.maxAttempts && delayMs < remainingMs()) {
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        let message = text;
        try {
          const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
          const detail = parsed.message ?? parsed.error;
          if (detail) message = Array.isArray(detail) ? detail.join("; ") : String(detail);
        } catch {
          // keep raw body
        }
        if (response.status === 401) {
          message =
            `${message || "Unauthorized"} — the Personal Access Token is missing, invalid, or expired. ` +
            this.tokenHelp;
        }
        if (method === "DELETE" && response.status === 404 && attempt > 1) {
          // An earlier attempt failed without an answer; it may have done the deleting.
          message = `${message || "Not found"}\nAn earlier attempt at this delete got no clear answer and may already have removed it.`;
        }
        throw new NinetyError(
          `Ninety API ${method} ${normalizedPath} failed (${response.status}): ${message}`,
          response.status,
        );
      }

      if (text.trim() === "") return { ok: true, status: response.status };
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    throw lastError ?? new NinetyError(`Ninety API ${method} ${normalizedPath} failed.`);
  }
}

/** Drop undefined values so PATCH bodies only carry the fields the caller set. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
