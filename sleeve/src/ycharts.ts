// Minimal YCharts v4 client for the sleeve app. Deliberately duplicated from
// ../ycharts-mcp (single-file, no shared build step); consolidate if the two drift.
import { loadApiKey } from "./config.js";

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

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const meta = parsed.meta as Record<string, unknown> | undefined;
    const candidate = meta?.error_message ?? parsed.error ?? parsed.detail ?? parsed.message;
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  } catch {
    // not JSON
  }
  return text;
}

function toError(status: number, path: string, bodyText: string): YchartsError {
  const message = extractMessage(bodyText);
  const blocked = FIELD_BLOCK.exec(message);
  if (blocked) {
    return new YchartsError(
      `YCharts rejected field '${blocked[1]}' (HTTP ${status} on ${path}): the API key is not licensed for it.`,
      status,
      blocked[1],
    );
  }
  return new YchartsError(`YCharts API error ${status} on ${path}: ${message.slice(0, 600)}`, status);
}

export class YchartsClient {
  constructor(private readonly apiKey: string) {}

  static load(): YchartsClient {
    const key = loadApiKey();
    if (!key) {
      throw new YchartsError(
        "No YCharts API key found. Run `node dist/index.js setup` in the ycharts-mcp folder, or set YCHARTS_API_KEY.",
      );
    }
    return new YchartsClient(key);
  }

  async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<any> {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
    }
    let lastError: YchartsError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { "X-YCHARTSAUTHORIZATION": this.apiKey, Accept: "application/json" } });
      } catch (err) {
        lastError = new YchartsError(`Network error calling ${url.pathname}: ${String(err)}`);
        await sleep(1000 * attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new YchartsError(`YCharts API ${res.status} on ${url.pathname}`, res.status);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw toError(res.status, url.pathname, text);
      return JSON.parse(text);
    }
    throw lastError ?? new YchartsError(`Request to ${path} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  private seg(items: string[]): string {
    return items.map((item) => encodeURIComponent(item.trim())).join(",");
  }

  modelPortfolios(params: Record<string, string | number | undefined>): Promise<any> {
    return this.get("/v4/model_portfolios", params);
  }

  holdings(portfolioId: number, weightType: "target" | "current"): Promise<any> {
    return this.get(`/v4/model_portfolios/${portfolioId}/holdings`, { weight_type: weightType });
  }

  points(portfolioIds: string, calcNames: string[], date?: string): Promise<any> {
    return this.get(`/v4/model_portfolios/${encodeURIComponent(portfolioIds)}/points/${this.seg(calcNames)}`, { date });
  }

  info(portfolioIds: string, fields: string[]): Promise<any> {
    return this.get(`/v4/model_portfolios/${encodeURIComponent(portfolioIds)}/info/${this.seg(fields)}`);
  }

  fundData(symbols: string[]): Promise<any> {
    return this.get(`/v4/funds/${this.seg(symbols)}`);
  }

  fundHoldings(symbol: string): Promise<any> {
    return this.get(`/v4/funds/${encodeURIComponent(symbol)}/holdings`);
  }

  screener(screenerId: number, page: number, pageSize: number): Promise<any> {
    return this.get(`/v4/screeners/company/${screenerId}`, { page, page_size: pageSize });
  }
}
