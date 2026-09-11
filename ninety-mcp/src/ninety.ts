import { DEVELOPER_SETTINGS_URL, baseUrl, loadToken } from "./config.js";

export class NinetyError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is seconds or an HTTP date; fall back to exponential backoff starting at 1s. */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return 1000 * 2 ** (attempt - 1);
}

export class NinetyClient {
  private token: string;

  private constructor(token: string) {
    this.token = token;
  }

  static load(): NinetyClient {
    const token = loadToken();
    if (!token) {
      throw new NinetyError(
        "No Ninety Personal Access Token is configured. Generate one at " +
          `${DEVELOPER_SETTINGS_URL}, then either set the NINETY_API_TOKEN environment variable ` +
          "or open a terminal in the project's ninety-mcp folder and run `node dist/index.js auth`.",
      );
    }
    return new NinetyClient(token);
  }

  async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(baseUrl() + normalizedPath);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: NinetyError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new NinetyError(
          `Network error calling ${method} ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1000 * 2 ** (attempt - 1));
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
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();

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
            `Generate a new one at ${DEVELOPER_SETTINGS_URL} and re-run ` +
            "`node dist/index.js auth` (or update NINETY_API_TOKEN).";
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
