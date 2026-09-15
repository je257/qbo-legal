import { loadApiKey } from "./config.js";

export type V3Kind = "companies" | "mutual_funds" | "indices" | "indicators";

export class YchartsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly blockedField?: string,
  ) {
    super(message);
    this.name = "YchartsError";
  }
}

const BASE = process.env.YCHARTS_API_BASE?.trim() || "https://api.ycharts.com";
const FIELD_BLOCK = /Field '([^']+)' is not available/;
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const meta = parsed.meta as Record<string, unknown> | undefined;
    const candidate = meta?.error_message ?? parsed.error ?? parsed.detail ?? parsed.message;
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  } catch {
    // not JSON — fall through to raw text
  }
  return text;
}

function toError(status: number, path: string, bodyText: string): YchartsError {
  const message = extractMessage(bodyText);
  const blocked = FIELD_BLOCK.exec(message);
  if (blocked) {
    return new YchartsError(
      `YCharts rejected field '${blocked[1]}' (HTTP ${status} on ${path}): this API key is not licensed for that field. ` +
        `Run ycharts_diagnose to map entitlements, and ask YCharts support to license the field for API access.`,
      status,
      blocked[1],
    );
  }
  if (status === 401 || status === 403) {
    return new YchartsError(
      `YCharts authentication failed (HTTP ${status} on ${path}): the API key was rejected. ` +
        `Check the key with the "status" command, or reconfigure it with "setup".`,
      status,
    );
  }
  return new YchartsError(`YCharts API error ${status} on ${path}: ${truncate(message)}`, status);
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class YchartsClient {
  constructor(private readonly apiKey: string) {}

  static load(): YchartsClient {
    const key = loadApiKey();
    if (!key) {
      throw new YchartsError(
        "No YCharts API key configured. Set the YCHARTS_API_KEY environment variable, " +
          "or run `node dist/index.js setup` in the ycharts-mcp folder to store one.",
      );
    }
    return new YchartsClient(key);
  }

  async request(method: "GET" | "POST" | "PATCH" | "PUT", path: string, opts: RequestOptions = {}): Promise<unknown> {
    if (!/^\/v[34]\//.test(path)) {
      throw new YchartsError(`Refusing request to non-YCharts-API path: ${path}`);
    }
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (value !== undefined && value !== null && String(value) !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: YchartsError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "X-YCHARTSAUTHORIZATION": this.apiKey,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        lastError = new YchartsError(`Network error calling ${url.pathname}: ${String(err)}`);
        await sleep(1000 * attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        lastError = new YchartsError(`YCharts API ${res.status} on ${url.pathname} (attempt ${attempt}/${MAX_ATTEMPTS})`, res.status);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.startsWith("image/")) {
        const bytes = await res.arrayBuffer();
        if (!res.ok) throw toError(res.status, url.pathname, "");
        return { content_type: contentType, byte_length: bytes.byteLength, note: "Binary response body omitted." };
      }

      const text = await res.text();
      if (!res.ok) throw toError(res.status, url.pathname, text);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { content_type: contentType, raw: truncate(text, 4000) };
      }
    }
    throw lastError ?? new YchartsError(`Request to ${path} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  private seg(items: string[]): string {
    return items.map((item) => encodeURIComponent(item.trim())).join(",");
  }

  // ---- v3: raw per-security data (points / series / info) ----

  v3Points(kind: V3Kind, symbols: string[], calcCodes: string[], date?: string): Promise<unknown> {
    return this.request("GET", `/v3/${kind}/${this.seg(symbols)}/points/${this.seg(calcCodes)}`, {
      params: { date },
    });
  }

  v3Series(
    kind: V3Kind,
    symbols: string[],
    calcCodes: string[],
    params: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.request("GET", `/v3/${kind}/${this.seg(symbols)}/series/${this.seg(calcCodes)}`, { params });
  }

  v3Info(kind: V3Kind, symbols: string[], infoFields: string[]): Promise<unknown> {
    return this.request("GET", `/v3/${kind}/${this.seg(symbols)}/info/${this.seg(infoFields)}`);
  }

  // ---- v4 helpers ----

  listScreeners(params: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request("GET", "/v4/screeners", { params });
  }

  getScreener(screenerType: string, screenerId: number, page?: number, pageSize?: number): Promise<unknown> {
    return this.request("GET", `/v4/screeners/${encodeURIComponent(screenerType)}/${screenerId}`, {
      params: { page, page_size: pageSize },
    });
  }

  securityLists(query?: string, page?: number, pageSize?: number): Promise<unknown> {
    return this.request("GET", "/v4/securitylists", { params: { query, page, page_size: pageSize } });
  }

  fundData(symbols: string[]): Promise<unknown> {
    return this.request("GET", `/v4/funds/${this.seg(symbols)}`);
  }

  fundHoldings(symbol: string): Promise<unknown> {
    return this.request("GET", `/v4/funds/${encodeURIComponent(symbol)}/holdings`);
  }

  modelPortfolios(params: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request("GET", "/v4/model_portfolios", { params });
  }

  modelPortfolioHoldings(portfolioIds: string, weightType: string): Promise<unknown> {
    return this.request("GET", `/v4/model_portfolios/${encodeURIComponent(portfolioIds)}/holdings`, {
      params: { weight_type: weightType },
    });
  }

  modelPortfolioPoints(portfolioIds: string, calcNames: string[], date?: string): Promise<unknown> {
    return this.request(
      "GET",
      `/v4/model_portfolios/${encodeURIComponent(portfolioIds)}/points/${this.seg(calcNames)}`,
      { params: { date } },
    );
  }

  modelPortfolioSeries(
    portfolioIds: string,
    calcNames: string[],
    params: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/v4/model_portfolios/${encodeURIComponent(portfolioIds)}/series/${this.seg(calcNames)}`,
      { params },
    );
  }

  modelPortfolioStatus(portfolioId: number): Promise<unknown> {
    return this.request("GET", `/v4/model_portfolios/${portfolioId}/status`);
  }

  createFixedModelPortfolio(body: unknown): Promise<unknown> {
    return this.request("POST", "/v4/model_portfolios/fixed", { body });
  }

  updateFixedModelPortfolio(portfolioId: number, body: unknown): Promise<unknown> {
    return this.request("PATCH", `/v4/model_portfolios/fixed/${portfolioId}`, { body });
  }
}
