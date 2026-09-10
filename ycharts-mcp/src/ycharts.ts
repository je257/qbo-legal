import { AppConfig, BASE_CANDIDATES, loadConfig } from "./config.js";

export class YchartsError extends Error {}

/** Security types of the legacy v3 data API (raw stock/fund/index data). */
export type V3SecurityType = "companies" | "mutual_funds" | "indicators" | "indices";
export type V3DividendSecurityType = "companies" | "mutual_funds";

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

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  params?: QueryParams;
  /** Override the configured API version path segment ("v4" default, "v3" for the legacy data API). */
  version?: string;
  method?: "GET" | "POST" | "PATCH" | "PUT";
  /** JSON request body for write methods. */
  body?: unknown;
  /** Multipart body (quick extract file, chart download image). Takes precedence over `body`. */
  form?: FormData;
  /**
   * Accept header override. Some endpoints pick the response format from it:
   * custom_pdf_reports/{id}/generate returns application/pdf by default but a
   * JSON {report_url} when Accept is application/json.
   */
  accept?: string;
}

/** Non-JSON response (PNG chart, generated PDF, ...) surfaced as base64. */
export interface BinaryResult {
  binary: true;
  mimeType: string;
  base64: string;
  byteLength: number;
  /** Interesting response headers, e.g. x-ycharts-omitted-series on chart renders. */
  headers?: Record<string, string>;
}

export function isBinaryResult(value: unknown): value is BinaryResult {
  return typeof value === "object" && value !== null && (value as BinaryResult).binary === true;
}

/**
 * Builds a comma-separated path segment from symbols/codes. Each item is
 * URL-encoded individually (so "#", "?", "/" in a symbol can't truncate or
 * reroute the request path) while the separating commas stay literal, as the
 * API expects. `max` enforces an endpoint-documented cap (v3: 100 per list;
 * v4 funds: 25; v4 chart securities: 10); omit it where the spec sets none.
 */
export function joinList(items: string[] | string, what: string, max?: number): string {
  const list = (Array.isArray(items) ? items : [items]).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new YchartsError(`At least one ${what} is required.`);
  if (max !== undefined && list.length > max) {
    throw new YchartsError(`Too many ${what}s: ${list.length}. This endpoint allows at most ${max} per request — split the call.`);
  }
  return list.map((s) => encodeURIComponent(s)).join(",");
}

export function formatDate(value: DateParam | undefined, name: string): string | number | undefined {
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
  400: "Bad request — check symbols, codes, and parameter values against ycharts.com/v4/docs.",
  401: "Unauthorized — the API key was rejected. Keys live at https://ycharts.com/api_v4 (API V4 Add-On required). Re-run `node dist/index.js auth`, or check YCHARTS_API_KEY.",
  403: "Forbidden — the API key is valid but this endpoint or data set is not enabled for your YCharts subscription.",
  404: "Not found — the endpoint path, symbol, or object ID may be wrong, or this endpoint may not exist in this API version. ycharts_status re-detects connectivity; ycharts_reference lists the v4 endpoint catalog.",
  405: "Method not allowed — check the HTTP method against the endpoint catalog in ycharts_reference.",
  414: "Request URL too long — reduce the number of symbols/codes per call.",
  422: "Unprocessable — the request body or parameters failed validation; compare against ycharts.com/v4/docs.",
  429: "Rate limited — YCharts is throttling requests. Wait a bit and retry, batching more symbols/codes per call.",
};

export class YchartsClient {
  constructor(private readonly config: AppConfig) {}

  static load(): YchartsClient {
    const config = loadConfig();
    if (!config) {
      throw new YchartsError(
        "No YCharts API key configured. In a terminal, run `node dist/index.js auth` from the project's ycharts-mcp folder, " +
          "or set the YCHARTS_API_KEY environment variable. Keys are managed at https://ycharts.com/api_v4.",
      );
    }
    return new YchartsClient(config);
  }

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    // v4 tools always hit /v4/ and v3 tools /v3/, each on its own configured
    // host — a stored or env-supplied endpoint can move the host, never
    // reroute one API generation's paths onto the other.
    const version = options.version ?? "v4";
    const baseUrl = version === "v3" ? this.config.v3BaseUrl : this.config.v4BaseUrl;
    const method = options.method ?? "GET";
    let cleaned = path.replace(/^\/+/, "");
    if (cleaned.startsWith(`${version}/`)) cleaned = cleaned.slice(version.length + 1);
    let url = `${baseUrl}/${version}/${cleaned}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    if (qs) url += `?${qs}`;

    const headers: Record<string, string> = {
      "x-ychartsauthorization": this.config.apiKey,
      Accept: options.accept ?? "application/json, image/png, */*",
    };
    const init: RequestInit = { method, headers };
    if (options.form !== undefined) {
      // fetch sets the multipart Content-Type (with boundary) itself.
      init.body = options.form;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new YchartsError(`Network error calling YCharts (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json") || contentType === "";

    if (!isJson && response.ok) {
      // Binary payload: rendered chart PNG, generated PDF report, file download, ...
      const buffer = Buffer.from(await response.arrayBuffer());
      const interesting: Record<string, string> = {};
      for (const name of ["x-ycharts-omitted-series", "content-disposition"]) {
        const value = response.headers.get(name);
        if (value) interesting[name] = value;
      }
      return {
        binary: true,
        mimeType: contentType.split(";")[0] || "application/octet-stream",
        base64: buffer.toString("base64"),
        byteLength: buffer.byteLength,
        headers: Object.keys(interesting).length ? interesting : undefined,
      } satisfies BinaryResult;
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
      const detail = body && typeof body === "object" ? JSON.stringify(body) : text.slice(0, 500);
      throw new YchartsError(`YCharts HTTP ${response.status} for ${method} ${url}. ${hint}${detail ? `\nResponse: ${detail}` : ""}`);
    }

    // Both API generations wrap payloads in an envelope with a `meta` object
    // (v3: {meta:{status,error_code,error_message}, response:{...}};
    //  v4: OkResponse[...] / ErrorResponse with OkResponseMeta / ErrorResponseMeta).
    // Individual symbols/codes inside the payload carry their own per-item
    // status, so a partial failure still returns usable data — only reject
    // when the envelope itself says error.
    const meta = (body as { meta?: { status?: string; error_code?: number; error_message?: string } } | undefined)?.meta;
    if (meta?.status === "error") {
      throw new YchartsError(`YCharts error ${meta.error_code ?? ""}: ${meta.error_message ?? "unknown error"} (${method} ${url})`);
    }
    if (body === undefined) {
      // 2xx whose body isn't JSON (or is empty): surface something explicit
      // rather than `undefined`, which would break the MCP text content item.
      return text.trim() === ""
        ? { ok: true, http_status: response.status, note: "Empty response body" }
        : { ok: true, http_status: response.status, note: "Non-JSON response body", raw: text.slice(0, 2000) };
    }
    return body;
  }

  // ---- Legacy v3 data API (raw security data: stocks, funds, indices) ----

  private v3(path: string, params?: QueryParams): Promise<unknown> {
    return this.request(path, { params, version: "v3" });
  }

  /** The v3 API caps list-style path segments at 100 items per request. */
  private static readonly V3_MAX = 100;

  v3ListSecurities(type: V3SecurityType, page = 1, filters?: Record<string, string>): Promise<unknown> {
    return this.v3(type, { page, ...(filters ?? {}) });
  }

  v3Points(type: V3SecurityType, symbols: string[] | string, metrics: string[] | string, date?: DateParam): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/points/${joinList(metrics, "metric code", YchartsClient.V3_MAX)}`;
    return this.v3(path, { date: formatDate(date, "date") });
  }

  v3Series(type: V3SecurityType, symbols: string[] | string, metrics: string[] | string, options: SeriesOptions = {}): Promise<unknown> {
    const path = `${type}/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/series/${joinList(metrics, "metric code", YchartsClient.V3_MAX)}`;
    return this.v3(path, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
      resample_frequency: options.resampleFrequency,
      resample_function: options.resampleFunction,
      fill_method: options.fillMethod,
      aggregate_function: options.aggregateFunction,
    });
  }

  v3Info(type: V3SecurityType, symbols: string[] | string, fields: string[] | string): Promise<unknown> {
    return this.v3(`${type}/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/info/${joinList(fields, "info field", YchartsClient.V3_MAX)}`);
  }

  v3Dividends(
    type: V3DividendSecurityType,
    symbols: string[] | string,
    options: EventOptions & { dividendType?: string } = {},
  ): Promise<unknown> {
    return this.v3(`${type}/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/dividends`, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
      dividend_type: options.dividendType,
    });
  }

  v3Splits(symbols: string[] | string, options: EventOptions = {}): Promise<unknown> {
    return this.v3(`companies/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/splits`, {
      start_date: formatDate(options.startDate, "start_date"),
      end_date: formatDate(options.endDate, "end_date"),
    });
  }

  v3Spinoffs(symbols: string[] | string, options: EventOptions = {}): Promise<unknown> {
    return this.v3(`companies/${joinList(symbols, "symbol", YchartsClient.V3_MAX)}/spinoffs`, {
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

/** Cheapest known GET per API generation, used to verify a key/endpoint combination. */
function probePath(apiVersion: string): string {
  return apiVersion === "v3" ? "companies/AAPL/points/price" : "indicators";
}

/**
 * Tries each base URL / version combination with a minimal request and
 * reports which ones work with the given key. Unlike the auth flow's
 * first-hit search, `stopAtFirst: false` checks every candidate — used by
 * status to report v4 and v3 availability independently.
 */
export async function probeApi(
  apiKey: string,
  candidates: ReadonlyArray<{ baseUrl: string; apiVersion: string }> = BASE_CANDIDATES,
  stopAtFirst = true,
): Promise<ProbeOutcome> {
  const results: ProbeResult[] = [];
  let working: ProbeOutcome["working"];
  let sawUnauthorized = false;

  for (const candidate of candidates) {
    const url = `${candidate.baseUrl}/${candidate.apiVersion}/${probePath(candidate.apiVersion)}`;
    let result: ProbeResult;
    try {
      const response = await fetch(url, {
        headers: { "x-ychartsauthorization": apiKey, Accept: "application/json" },
      });
      let metaStatus: string | undefined;
      try {
        const body = (await response.json()) as { meta?: { status?: string } };
        metaStatus = body?.meta?.status;
      } catch {
        /* non-JSON body */
      }
      // Positive envelope confirmation required: a 200 HTML page (login
      // redirect, marketing-site catch-all) must not count as a working API.
      if (response.ok && metaStatus === "ok") {
        result = { ...candidate, ok: true, httpStatus: response.status, detail: "works" };
        working ??= candidate;
      } else if (response.ok) {
        result = {
          ...candidate,
          ok: false,
          httpStatus: response.status,
          detail: `HTTP ${response.status} but not a YCharts API envelope${metaStatus ? ` (meta.status=${metaStatus})` : ""}`,
        };
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
    if (working && stopAtFirst) break;
  }

  return { working, keyRejected: !working && sawUnauthorized, results };
}
