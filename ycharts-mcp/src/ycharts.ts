import { AppConfig, BASE_CANDIDATES, loadConfig } from "./config.js";

export class YchartsError extends Error {}

export type SecurityType = "companies" | "mutual_funds" | "indicators" | "indices";
export type DividendSecurityType = "companies" | "mutual_funds";

/** YCharts caps list-style path segments (symbols, metric codes) at 100 items per request. */
const MAX_LIST_ITEMS = 100;

/** A date parameter: "YYYY-MM-DD", or a negative integer meaning N periods ago. */
export type DateParam = string | number;

export interface SeriesOptions {
  startDate?: DateParam;
  endDate?: DateParam;
  resampleFrequency?: string;
  resampleFunction?: string;
  fillMethod?: string;
  aggregateFunction?: string;
}

export interface EventOptions {
  startDate?: DateParam;
  endDate?: DateParam;
}

type QueryParams = Record<string, string | number | undefined>;

function joinList(items: string[] | string, what: string): string {
  const list = (Array.isArray(items) ? items : [items]).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new YchartsError(`At least one ${what} is required.`);
  if (list.length > MAX_LIST_ITEMS) {
    throw new YchartsError(`Too many ${what}s: ${list.length}. YCharts allows at most ${MAX_LIST_ITEMS} per request — split the call.`);
  }
  return list.join(",");
}

function formatDate(value: DateParam | undefined, name: string): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value >= 0) {
      throw new YchartsError(`Invalid ${name}: a numeric date must be a negative integer (N periods ago), got ${value}.`);
    }
    return value;
  }
  const text = value.trim();
  if (/^-\d+$/.test(text)) return Number(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new YchartsError(`Invalid ${name}: "${value}". Use YYYY-MM-DD or a negative integer (N periods ago).`);
  }
  return text;
}

const HTTP_HINTS: Record<number, string> = {
  400: "Bad request — check symbols, metric codes, and parameter values.",
  401: "Unauthorized — the API key was rejected. Re-run `node dist/index.js auth` in the ycharts-mcp folder, or check YCHARTS_API_KEY.",
  403: "Forbidden — the API key is valid but this endpoint or data set is not enabled for your YCharts subscription.",
  404: "Not found — the endpoint path, security symbol, or API version may be wrong. Try the ycharts_status tool to re-detect the API base, or ycharts_list_securities to look up symbols.",
  414: "Request URL too long — reduce the number of symbols/metrics per call.",
  429: "Rate limited — YCharts is throttling requests. Wait a bit and retry, batching more symbols/metrics per call.",
};

export class YchartsClient {
  constructor(private readonly config: AppConfig) {}

  static load(): YchartsClient {
    const config = loadConfig();
    if (!config) {
      throw new YchartsError(
        "No YCharts API key configured. In a terminal, run `node dist/index.js auth` from the project's ycharts-mcp folder, " +
          "or set the YCHARTS_API_KEY environment variable.",
      );
    }
    return new YchartsClient(config);
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get apiVersion(): string {
    return this.config.apiVersion;
  }

  async request(path: string, params?: QueryParams, apiVersionOverride?: string): Promise<unknown> {
    const version = apiVersionOverride ?? this.config.apiVersion;
    const cleaned = path.replace(/^\/+/, "");
    let url = `${this.config.baseUrl}/${version}/${cleaned}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    if (qs) url += `?${qs}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "X-YCHARTSAUTHORIZATION": this.config.apiKey, Accept: "application/json" },
      });
    } catch (error) {
      throw new YchartsError(`Network error calling YCharts (${url}): ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const hint = HTTP_HINTS[response.status] ?? "";
      const detail =
        body && typeof body === "object"
          ? JSON.stringify(body)
          : text.slice(0, 300);
      throw new YchartsError(`YCharts HTTP ${response.status} for ${url}. ${hint}${detail ? `\nResponse: ${detail}` : ""}`);
    }

    // YCharts wraps every payload in {meta: {status, error_code, error_message, url}, response: {...}}.
    // Individual symbols/metrics inside `response` carry their own per-item status,
    // so a partial failure still returns HTTP 200 with usable data.
    const meta = (body as { meta?: { status?: string; error_code?: number; error_message?: string } } | undefined)?.meta;
    if (meta?.status === "error") {
      throw new YchartsError(`YCharts error ${meta.error_code ?? ""}: ${meta.error_message ?? "unknown error"} (${url})`);
    }
    return body;
  }

  listSecurities(type: SecurityType, page = 1, filters?: Record<string, string>): Promise<unknown> {
    return this.request(type, { page, ...(filters ?? {}) });
  }

  points(type: SecurityType, symbols: string[] | string, metrics: string[] | string, date?: DateParam): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol")}/points/${joinList(metrics, "metric code")}`;
    return this.request(path, { date: formatDate(date, "date") });
  }

  series(type: SecurityType, symbols: string[] | string, metrics: string[] | string, options: SeriesOptions = {}): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol")}/series/${joinList(metrics, "metric code")}`;
    return this.request(path, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
      resample_frequency: options.resampleFrequency,
      resample_function: options.resampleFunction,
      fill_method: options.fillMethod,
      aggregate_function: options.aggregateFunction,
    });
  }

  info(type: SecurityType, symbols: string[] | string, fields: string[] | string): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol")}/info/${joinList(fields, "info field")}`;
    return this.request(path);
  }

  dividends(
    type: DividendSecurityType,
    symbols: string[] | string,
    options: EventOptions & { dividendType?: string } = {},
  ): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol")}/dividends`;
    return this.request(path, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
      dividend_type: options.dividendType,
    });
  }

  splits(symbols: string[] | string, options: EventOptions = {}): Promise<unknown> {
    const path = `companies/${joinList(symbols, "symbol")}/splits`;
    return this.request(path, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
    });
  }

  spinoffs(symbols: string[] | string, options: EventOptions = {}): Promise<unknown> {
    const path = `companies/${joinList(symbols, "symbol")}/spinoffs`;
    return this.request(path, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
    });
  }
}

export interface ProbeResult {
  baseUrl: string;
  apiVersion: string;
  ok: boolean;
  httpStatus?: number;
  detail: string;
}

export interface ProbeOutcome {
  working?: { baseUrl: string; apiVersion: string };
  keyRejected: boolean;
  results: ProbeResult[];
}

/**
 * Tries each known base URL / version combination with a minimal request
 * (AAPL price point) and reports which one works with the given key.
 */
export async function probeApi(
  apiKey: string,
  candidates: ReadonlyArray<{ baseUrl: string; apiVersion: string }> = BASE_CANDIDATES,
): Promise<ProbeOutcome> {
  const results: ProbeResult[] = [];
  let working: ProbeOutcome["working"];
  let sawUnauthorized = false;

  for (const candidate of candidates) {
    const url = `${candidate.baseUrl}/${candidate.apiVersion}/companies/AAPL/points/price`;
    let result: ProbeResult;
    try {
      const response = await fetch(url, {
        headers: { "X-YCHARTSAUTHORIZATION": apiKey, Accept: "application/json" },
      });
      let metaStatus: string | undefined;
      try {
        const body = (await response.json()) as { meta?: { status?: string; error_message?: string } };
        metaStatus = body?.meta?.status;
      } catch {
        /* non-JSON body */
      }
      if (response.ok && metaStatus === "ok") {
        result = { ...candidate, ok: true, httpStatus: response.status, detail: "works" };
        working ??= candidate;
      } else if (response.status === 401) {
        sawUnauthorized = true;
        result = { ...candidate, ok: false, httpStatus: 401, detail: "endpoint exists but the API key was rejected" };
      } else {
        result = {
          ...candidate,
          ok: false,
          httpStatus: response.status,
          detail: `HTTP ${response.status}${metaStatus ? ` (meta.status=${metaStatus})` : ""}`,
        };
      }
    } catch (error) {
      result = { ...candidate, ok: false, detail: `network error: ${error instanceof Error ? error.message : String(error)}` };
    }
    results.push(result);
    if (working) break;
  }

  return { working, keyRejected: !working && sawUnauthorized, results };
}
