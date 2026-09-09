import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BASE_CANDIDATES, loadConfig } from "./config.js";
import { REFERENCE } from "./metrics.js";
import {
  BinaryResult,
  isBinaryResult,
  joinList,
  probeApi,
  YchartsClient,
  YchartsError,
  type DateParam,
  type QueryParams,
} from "./ycharts.js";

type ContentItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentItem[]; isError?: boolean };

const MAX_INLINE_IMAGE_BYTES = 3_000_000;

function saveBinary(result: BinaryResult, label: string): string {
  const dir = join(tmpdir(), "ycharts-mcp");
  mkdirSync(dir, { recursive: true });
  const ext = result.mimeType === "image/png" ? "png" : result.mimeType === "application/pdf" ? "pdf" : "bin";
  const path = join(dir, `${Date.now()}-${label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)}.${ext}`);
  writeFileSync(path, Buffer.from(result.base64, "base64"));
  return path;
}

function binaryContent(result: BinaryResult, label: string, extra: Record<string, unknown> = {}): ContentItem[] {
  const savedTo = saveBinary(result, label);
  const content: ContentItem[] = [];
  if (result.mimeType.startsWith("image/") && result.byteLength <= MAX_INLINE_IMAGE_BYTES) {
    content.push({ type: "image", data: result.base64, mimeType: result.mimeType });
  }
  content.push({
    type: "text",
    text: JSON.stringify({ saved_to: savedTo, mime_type: result.mimeType, bytes: result.byteLength, ...result.headers, ...extra }, null, 2),
  });
  return content;
}

function ok(value: unknown): ToolResult {
  if (isBinaryResult(value)) return { content: binaryContent(value, "ycharts") };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function run(handler: () => Promise<unknown>): Promise<ToolResult> {
  return handler().then(ok, (error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: error instanceof YchartsError ? error.message : `Unexpected error: ${String(error)}`,
      },
    ],
    isError: true,
  }));
}

/** Like run(), for handlers that build their own ToolResult (chart images etc.). */
function runRich(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  return handler().catch((error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: error instanceof YchartsError ? error.message : `Unexpected error: ${String(error)}`,
      },
    ],
    isError: true,
  }));
}

function toStrings(values: Array<string | number>): string[] {
  return values.map(String);
}

// ---- shared zod fragments (mirroring the v4 OpenAPI spec) ----
const pageField = z.number().int().min(1).optional().describe("Page number (default 1)");
const pageSizeField = z.number().int().min(1).max(1000).optional().describe("Items per page (default 100, max 1000); iterate with the response's pagination.next_page");
const itemPageSizeField = z.number().int().min(1).max(500).optional().describe("Items per page (default 100, max 500); iterate with the response's pagination.next_page");
const sortDirectionField = z.string().optional().describe("asc | desc (default desc)");
const ownerFilterField = z
  .string()
  .optional()
  .describe('Packed owner filter, e.g. "me:::true,,,public:::false,,,shared_with_me:::true" (keys joined with ",,,", key/value with ":::")');
const dateField = z.union([z.string(), z.number().int()]).describe('"YYYY-MM-DD", or a negative integer / "-N" for N periods back');
const v4SeriesFields = {
  resample_frequency: z.string().optional().describe("daily | weekly | monthly | quarterly | yearly"),
  resample_function: z.string().optional().describe("min | max | mean | sum | first | last"),
  fill_method: z.string().optional().describe("backward | forward | no_fill"),
  aggregate_function: z.string().optional().describe("min | max | mean | median | sum | std (collapses each series to one statistic)"),
  force_date_range: z.boolean().optional().describe("Peg/reindex the response to the supplied date range"),
};

const stateNote =
  "Call ycharts_reference first for the exact state/body formats (screener metric-filter tokens, securitylist_filters, timeseries table state, portfolio shapes).";

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "ycharts-mcp", version: "0.2.0" });
  const client = () => YchartsClient.load();

  // ------------------------------------------------------------------
  // Meta
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_status",
    {
      title: "YCharts connection status",
      description:
        "Check whether a YCharts API key is configured and verify connectivity against v4 (api.ycharts.com/v4) and the legacy v3 data API. " +
        "Use this first if other YCharts tools return authorization or not-found errors.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const config = loadConfig();
        if (!config) {
          return {
            configured: false,
            reason:
              "No API key. In a terminal, run `node dist/index.js auth` from the project's ycharts-mcp folder, or set YCHARTS_API_KEY. Keys: https://ycharts.com/api_v4",
          };
        }
        const outcome = await probeApi(
          config.apiKey,
          [
            { baseUrl: config.baseUrl, apiVersion: config.apiVersion },
            ...BASE_CANDIDATES.filter((c) => c.baseUrl !== config.baseUrl || c.apiVersion !== config.apiVersion),
          ],
          false,
        );
        return {
          configured: true,
          configuredEndpoint: `${config.baseUrl}/${config.apiVersion}`,
          v4Works: outcome.results.some((r) => r.apiVersion === "v4" && r.ok),
          v3Works: outcome.results.some((r) => r.apiVersion === "v3" && r.ok),
          keyRejected: outcome.keyRejected,
          probeResults: outcome.results,
        };
      }),
  );

  server.registerTool(
    "ycharts_reference",
    {
      title: "YCharts API cheat sheet",
      description:
        "Local reference (no API call): the v4 endpoint catalog, security-id conventions (AAPL, M:VFIAX, ^SPX, I:USGDP, P:12345, cash), " +
        "pagination and packed-filter formats, series parameters, fundamental-chart options, and the exact body formats for screeners, " +
        "timeseries tables, and portfolio creation. Consult this before building request bodies or guessing codes.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => REFERENCE),
  );

  // ------------------------------------------------------------------
  // Funds
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_funds",
    {
      title: "Fund/ETF default data",
      description:
        "GET /v4/funds/{symbols}: default (Lipper/NASDAQ/Quodd) data for 1-25 mutual fund or ETF symbols, including each symbol's " +
        "normalized security_type ('mutual_fund' or 'etf'). Rejects plain equities. Per-symbol errors come back inline in a multi-symbol request.",
      inputSchema: {
        symbols: z.array(z.string()).min(1).max(25).describe('Fund/ETF tickers, e.g. ["VFIAX","SPY"] (1-25)'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols }) => run(() => client().request(`funds/${joinList(symbols, "symbol")}`)),
  );

  server.registerTool(
    "ycharts_fund_holdings",
    {
      title: "Fund/ETF top holdings",
      description: "GET /v4/funds/{symbol}/holdings: the top (up to 25) holdings of a single mutual fund or ETF, with weights.",
      inputSchema: { symbol: z.string().describe('Fund/ETF ticker, e.g. "SPY"') },
      annotations: { readOnlyHint: true },
    },
    ({ symbol }) => run(() => client().request(`funds/${encodeURIComponent(symbol.trim())}/holdings`)),
  );

  // ------------------------------------------------------------------
  // Indicators
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_indicators_search",
    {
      title: "Search economic indicators",
      description:
        "GET /v4/indicators: paginated search for economic indicators (returns symbol + name), optionally filtered by region " +
        '(e.g. "USA","CAN"), source internal name (e.g. "department_of_labor"), category internal name (e.g. "gdp","interest_rates"), ' +
        'or report internal name (e.g. "house_price_index"). The way to discover I: indicator codes.',
      inputSchema: {
        page: pageField,
        page_size: pageSizeField,
        region: z.string().optional(),
        source: z.string().optional(),
        category: z.string().optional(),
        report: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ page, page_size, region, source, category, report }) =>
      run(() => client().request("indicators", { params: { page, page_size, region, source, category, report } })),
  );

  server.registerTool(
    "ycharts_indicator_info",
    {
      title: "Indicator info fields",
      description: 'GET /v4/indicators/{codes}/info/{fields}: info fields (e.g. "security_name","description") for one or more indicators.',
      inputSchema: {
        indicator_codes: z.array(z.string()).min(1).describe('Indicator codes, e.g. ["I:USGDP","I:USCPI"]'),
        info_fields: z.array(z.string()).min(1).describe('Info field codes, e.g. ["security_name","description"]'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ indicator_codes, info_fields }) =>
      run(() => client().request(`indicators/${joinList(indicator_codes, "indicator code")}/info/${joinList(info_fields, "info field")}`)),
  );

  server.registerTool(
    "ycharts_indicator_points",
    {
      title: "Indicator data points",
      description:
        "GET /v4/indicators/{codes}/points: the latest (or as-of-date) value of one or more economic indicators. " +
        "Each code returns a (date, value) pair; per-code errors come back inline.",
      inputSchema: {
        indicator_codes: z.array(z.string()).min(1).describe('Indicator codes, e.g. ["I:USGDP","I:USCPI"]'),
        date: dateField.optional().describe("Omit for the latest value"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ indicator_codes, date }) =>
      run(() => client().request(`indicators/${joinList(indicator_codes, "indicator code")}/points`, { params: { date: date as DateParam | undefined } })),
  );

  server.registerTool(
    "ycharts_indicator_series",
    {
      title: "Indicator time series",
      description:
        "GET /v4/indicators/{codes}/series: historical time series for one or more economic indicators. start_date AND end_date are " +
        "required. Supports resampling, fill, and aggregation. For long windows resample (e.g. monthly/last) to keep responses small.",
      inputSchema: {
        indicator_codes: z.array(z.string()).min(1).describe('Indicator codes, e.g. ["I:USGDP"]'),
        start_date: dateField,
        end_date: dateField,
        ...v4SeriesFields,
      },
      annotations: { readOnlyHint: true },
    },
    ({ indicator_codes, start_date, end_date, resample_frequency, resample_function, fill_method, aggregate_function, force_date_range }) =>
      run(() =>
        client().request(`indicators/${joinList(indicator_codes, "indicator code")}/series`, {
          params: {
            start_date: start_date as DateParam,
            end_date: end_date as DateParam,
            resample_frequency,
            resample_function,
            fill_method,
            aggregate_function,
            force_date_range,
          },
        }),
      ),
  );

  // ------------------------------------------------------------------
  // Fundamental Charts
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_fundamental_chart",
    {
      title: "Render a Fundamental Chart (PNG)",
      description:
        "POST /v4/fundamental_charts: renders a YCharts Fundamental Chart (same engine as the web app's Presentation Mode) and returns " +
        "the PNG inline plus a saved file path. 1-10 securities x metrics, at most 12 rendered items " +
        "(single panel: securities x metrics + overlays; per_security: # metrics; per_metric: # securities). " +
        "Securities that don't report a metric are dropped and listed in x-ycharts-omitted-series. " +
        "Optional ratio/spread/correlation overlays (Advanced Charting feature). Set get_download_url to also store the image and get a " +
        "temporary browser-downloadable URL.",
      inputSchema: {
        securities: z.array(z.string()).min(1).max(10).describe('Tickers or security names, e.g. ["AAPL","MSFT"], ["M:VFIAX"], ["^SPX"]'),
        metrics: z.array(z.string()).min(1).describe('Metric calc-names, e.g. ["price"], ["pe_ratio","eps_ttm"]'),
        date_range: z.string().optional().describe("1D | 5D | 1M | 3M | 6M | YTD | 1Y | 3Y | 5Y | 10Y | Max — OR use start_date+end_date"),
        start_date: z.string().optional().describe("YYYY-MM-DD (with end_date, instead of date_range)"),
        end_date: z.string().optional().describe("YYYY-MM-DD (with start_date)"),
        data_format: z.string().optional().describe("original (default) | normalized_pct_change | growth_custom | pct_off_high"),
        panel_layout: z.string().optional().describe("single (default) | per_metric | per_security"),
        overlays: z
          .array(z.record(z.unknown()))
          .optional()
          .describe(
            'Up to 10 overlays: {type: "ratio"|"spread"|"correlation", security_a, security_b, metric_a, metric_b, lag_a?, lag_b?, weight_a?, weight_b?}',
          ),
        get_download_url: z.boolean().optional().describe("Also store the rendered chart and return a temporary download URL"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ securities, metrics, date_range, start_date, end_date, data_format, panel_layout, overlays, get_download_url }) =>
      runRich(async () => {
        const securitiesParam = joinList(securities, "security");
        const result = await client().request("fundamental_charts", {
          method: "POST",
          params: { securities: securitiesParam, metrics: joinList(metrics, "metric"), date_range, start_date, end_date, data_format, panel_layout },
          body: { overlays: overlays ?? [] },
        });
        if (!isBinaryResult(result)) return ok(result);

        const extra: Record<string, unknown> = {};
        if (get_download_url) {
          const form = new FormData();
          form.append("image", new Blob([Buffer.from(result.base64, "base64")], { type: "image/png" }), "chart.png");
          const download = await client().request("fundamental_charts/downloads", {
            method: "POST",
            params: { securities: securitiesParam },
            form,
          });
          extra.download = download;
        }
        return { content: binaryContent(result, `chart-${securities.join("-")}`, extra) };
      }),
  );

  // ------------------------------------------------------------------
  // Model Portfolios
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_model_portfolios_list",
    {
      title: "List model portfolios",
      description:
        "GET /v4/model_portfolios: paginated list of portfolios (model, client, household, blended benchmark) visible to the user. " +
        'Filters: name (partial), benchmark symbol, watchlist_id, and packed filters owner ("me:::true,,,public:::true,,,shared_with_me:::true"), ' +
        'portfolio_type ("model_portfolio:::true,,,client_portfolio:::false,..."), edit_state ("completed:::true,,,draft:::true"). ' +
        "sort_column: name | label | owner_name | user_modify_date.",
      inputSchema: {
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional(),
        sort_direction: sortDirectionField,
        name: z.string().optional().describe("Filter by portfolio name (partial match)"),
        benchmark: z.string().optional().describe("Filter by benchmark security symbol"),
        watchlist_id: z.string().optional(),
        owner: ownerFilterField,
        portfolio_type: z.string().optional().describe('Packed: keys blended_benchmark, client_portfolio, household_portfolio, model_portfolio'),
        edit_state: z.string().optional().describe("Packed: keys completed, draft"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => client().request("model_portfolios", { params: args as QueryParams })),
  );

  server.registerTool(
    "ycharts_model_portfolio_get",
    {
      title: "Get a model portfolio (detail or status)",
      description:
        'GET /v4/model_portfolios/fixed/{id} (what="detail": metadata + holdings/items) or GET /v4/model_portfolios/{id}/status ' +
        '(what="status": available | calculating (+calc_progress) | needs_review (+message) | calc_scheduled | calc_failed).',
      inputSchema: {
        portfolio_id: z.number().int().describe("Portfolio ID"),
        what: z.enum(["detail", "status"]).optional().describe("Default: detail"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ portfolio_id, what }) =>
      run(() => client().request(what === "status" ? `model_portfolios/${portfolio_id}/status` : `model_portfolios/fixed/${portfolio_id}`)),
  );

  server.registerTool(
    "ycharts_model_portfolio_data",
    {
      title: "Model portfolio data (info/points/series/holdings)",
      description:
        "Bulk data for one or more model portfolios: data_type=info (info fields), points (calc values as of a date; calc names e.g. " +
        '"level","one_year_total_return"), series (calc time series), or holdings (weight_type "target" or "current" REQUIRED). ' +
        "codes = info fields for info, calc names for points/series (unused for holdings). Per-portfolio/per-code errors come back inline.",
      inputSchema: {
        data_type: z.enum(["info", "points", "series", "holdings"]),
        portfolio_ids: z.array(z.union([z.number().int(), z.string()])).min(1).describe("Portfolio IDs, e.g. [123456, 567899]"),
        codes: z.array(z.string()).optional().describe("Info fields (info) or calc names (points/series); required for those types"),
        date: dateField.optional().describe("points only: as-of date (defaults to latest)"),
        start_date: dateField.optional().describe("series only (defaults to one day ago)"),
        end_date: dateField.optional().describe("series only (defaults to today)"),
        ...v4SeriesFields,
        weight_type: z.string().optional().describe('holdings only, REQUIRED there: "target" or "current"'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ data_type, portfolio_ids, codes, date, start_date, end_date, resample_frequency, resample_function, fill_method, aggregate_function, force_date_range, weight_type }) =>
      run(() => {
        const ids = joinList(toStrings(portfolio_ids), "portfolio id");
        if (data_type === "holdings") {
          if (!weight_type) throw new YchartsError('holdings requires weight_type: "target" or "current".');
          return client().request(`model_portfolios/${ids}/holdings`, { params: { weight_type } });
        }
        if (!codes?.length) throw new YchartsError(`${data_type} requires codes (info fields or calc names).`);
        const codePath = joinList(codes, data_type === "info" ? "info field" : "calc name");
        if (data_type === "info") return client().request(`model_portfolios/${ids}/info/${codePath}`);
        if (data_type === "points") return client().request(`model_portfolios/${ids}/points/${codePath}`, { params: { date: date as DateParam | undefined } });
        return client().request(`model_portfolios/${ids}/series/${codePath}`, {
          params: {
            start_date: start_date as DateParam | undefined,
            end_date: end_date as DateParam | undefined,
            resample_frequency,
            resample_function,
            fill_method,
            aggregate_function,
            force_date_range,
          },
        });
      }),
  );

  server.registerTool(
    "ycharts_model_portfolio_create",
    {
      title: "Create a fixed model portfolio",
      description:
        "POST /v4/model_portfolios/fixed: creates a model, client, household, or blended-benchmark portfolio (discriminated by " +
        '"label"). Returns the new portfolio_id; calculations start immediately (poll with ycharts_model_portfolio_get what=status). ' +
        "Required (all types): name, level_type (custom|auto), start_of_series (oldest|newest|custom), items (min 1, each " +
        "{security_id, <weight field matching weight_type>}). model/client/household additionally need benchmark_id; client needs " +
        "tax_status (qualified|non_qualified). " +
        stateNote,
      inputSchema: {
        portfolio: z.record(z.unknown()).describe('The portfolio body, e.g. {"label":"model_portfolio","name":...,"weight_type":"Target","items":[{"security_id":"AAPL","target_weighting":0.5},...],...}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ portfolio }) => run(() => client().request("model_portfolios/fixed", { method: "POST", body: portfolio })),
  );

  server.registerTool(
    "ycharts_model_portfolio_update",
    {
      title: "Update a fixed model portfolio",
      description:
        "PATCH /v4/model_portfolios/fixed/{id}: replaces the portfolio's items (portfolio_items replaces EVERY item) and/or sets " +
        "base_currency (3-letter code; null puts the portfolio back in the currency of its holdings). Triggers a full recalculation. " +
        "A portfolio with auto level and Dollar/Share weights must send portfolio_items along with a base_currency change.",
      inputSchema: {
        portfolio_id: z.number().int(),
        portfolio_items: z.array(z.record(z.unknown())).min(1).optional().describe("Replaces every item; omit to keep existing items"),
        base_currency: z.union([z.string(), z.null()]).optional().describe("3-letter code, null to clear; omit to keep"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ portfolio_id, portfolio_items, base_currency }) =>
      run(() => {
        const body: Record<string, unknown> = {};
        if (portfolio_items !== undefined) body.portfolio_items = portfolio_items;
        if (base_currency !== undefined) body.base_currency = base_currency;
        if (!Object.keys(body).length) throw new YchartsError("Provide portfolio_items and/or base_currency.");
        return client().request(`model_portfolios/fixed/${portfolio_id}`, { method: "PATCH", body });
      }),
  );

  // ------------------------------------------------------------------
  // Screeners
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_screeners_list",
    {
      title: "List screeners",
      description:
        'GET /v4/screeners: paginated list of saved stock/fund screeners. screener_type ("company" or "fund") is REQUIRED. ' +
        "Filters: name (partial), packed owner filter. sort_column: name | owner_name | user_modify_date.",
      inputSchema: {
        screener_type: z.enum(["company", "fund"]),
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional(),
        sort_direction: sortDirectionField,
        name: z.string().optional(),
        owner: ownerFilterField,
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => client().request("screeners", { params: args as QueryParams })),
  );

  server.registerTool(
    "ycharts_screener_get",
    {
      title: "Get a screener's state and matches",
      description:
        "GET /v4/screeners/{screener_type}/{screener_id}: the screener's saved state (filters, columns, sort) plus a page of the " +
        "securities currently matching it — i.e. run the screen and read the results.",
      inputSchema: {
        screener_type: z.enum(["company", "fund"]),
        screener_id: z.number().int(),
        page: pageField,
        page_size: itemPageSizeField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ screener_type, screener_id, page, page_size }) =>
      run(() => client().request(`screeners/${screener_type}/${screener_id}`, { params: { page, page_size } })),
  );

  server.registerTool(
    "ycharts_screener_create",
    {
      title: "Create a screener",
      description:
        "POST /v4/screeners: creates a saved screener. Body: name, screener_type (company|fund), and optional state " +
        "(metric_filters with token expressions, securitylist_filters, exposure_filters for funds, rating_filters for companies, " +
        "ordered_columns, sort). " +
        stateNote,
      inputSchema: {
        name: z.string().min(1).max(200),
        screener_type: z.enum(["company", "fund"]),
        state: z.record(z.unknown()).optional().describe("Screener state object; see ycharts_reference screener_state_format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, screener_type, state }) => run(() => client().request("screeners", { method: "POST", body: { name, screener_type, state } })),
  );

  server.registerTool(
    "ycharts_screener_update",
    {
      title: "Update a screener",
      description: "PATCH /v4/screeners/{screener_type}/{screener_id}: rename and/or replace the screener's state. " + stateNote,
      inputSchema: {
        screener_type: z.enum(["company", "fund"]),
        screener_id: z.number().int(),
        name: z.string().max(200).optional(),
        state: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ screener_type, screener_id, name, state }) =>
      run(() => client().request(`screeners/${screener_type}/${screener_id}`, { method: "PATCH", body: { name, state } })),
  );

  server.registerTool(
    "ycharts_screener_to_watchlist",
    {
      title: "Save screener matches as a watchlist",
      description: "POST /v4/screeners/{screener_type}/{screener_id}/watchlist: creates a multi-security watchlist from the securities the screener currently matches.",
      inputSchema: {
        screener_type: z.enum(["company", "fund"]),
        screener_id: z.number().int(),
        name: z.string().min(1).max(100).describe("Name for the new watchlist"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ screener_type, screener_id, name }) =>
      run(() => client().request(`screeners/${screener_type}/${screener_id}/watchlist`, { method: "POST", body: { name } })),
  );

  // ------------------------------------------------------------------
  // Security lists / Timeseries tables / Watchlists
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_security_lists",
    {
      title: "Search security lists (universe filters)",
      description:
        "GET /v4/securitylists: search every security list usable as a universe filter — the built-in catalog, YCharts Proprietary " +
        "lists, and the user's own saved lists. Returns internal_name/group values to plug into securitylist_filters (screeners, " +
        'timeseries tables). query is ranked matching (e.g. "dividend", "s&p 500"); omit to browse all in label order.',
      inputSchema: { query: z.string().optional(), page: pageField, page_size: pageSizeField },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => client().request("securitylists", { params: args as QueryParams })),
  );

  server.registerTool(
    "ycharts_timeseries_tables_list",
    {
      title: "List timeseries tables",
      description: "GET /v4/timeseries_tables: paginated list of saved timeseries tables. Filters: name (partial), packed owner filter; sort_column: name | owner_name | user_modify_date.",
      inputSchema: {
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional(),
        sort_direction: sortDirectionField,
        name: z.string().optional(),
        owner: ownerFilterField,
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => client().request("timeseries_tables", { params: args as QueryParams })),
  );

  server.registerTool(
    "ycharts_timeseries_table_get",
    {
      title: "Get a timeseries table with computed data",
      description:
        "GET /v4/timeseries_tables/{id}: the saved table (metrics/info fields x securities over a date axis) plus a page of its " +
        "computed rows, summary stats, and pinned rows. Page/page_size page the returned rows; the state's own page/items_per_page " +
        "window the date axis.",
      inputSchema: { timeseries_table_id: z.number().int(), page: pageField, page_size: itemPageSizeField },
      annotations: { readOnlyHint: true },
    },
    ({ timeseries_table_id, page, page_size }) => run(() => client().request(`timeseries_tables/${timeseries_table_id}`, { params: { page, page_size } })),
  );

  server.registerTool(
    "ycharts_timeseries_table_create",
    {
      title: "Create a timeseries table",
      description:
        "POST /v4/timeseries_tables: creates a saved timeseries table — an ad-hoc data grid of metrics/info fields for a set of " +
        "securities (and/or security-list filters) over a date range and frequency. This is the closest v4 gets to bulk raw stock " +
        "data: create a table with the securities+metrics you need, then read it back with ycharts_timeseries_table_get. " +
        stateNote,
      inputSchema: {
        name: z.string().min(1).max(200),
        state: z.record(z.unknown()).optional().describe("Table state; see ycharts_reference timeseries_table_state_format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, state }) => run(() => client().request("timeseries_tables", { method: "POST", body: { name, state } })),
  );

  server.registerTool(
    "ycharts_timeseries_table_update",
    {
      title: "Update a timeseries table",
      description: "PATCH /v4/timeseries_tables/{id}: rename and/or replace the table's state (the new state replaces the old one entirely). " + stateNote,
      inputSchema: {
        timeseries_table_id: z.number().int(),
        name: z.string().min(1).max(200).optional(),
        state: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ timeseries_table_id, name, state }) => run(() => client().request(`timeseries_tables/${timeseries_table_id}`, { method: "PATCH", body: { name, state } })),
  );

  server.registerTool(
    "ycharts_watchlists_list",
    {
      title: "List watchlists",
      description:
        "GET /v4/watchlists: paginated list of watchlists. Filters: name (partial), packed owner filter, packed watchlist_type " +
        '("multi:::true,,,indicator:::false"), security_ids (comma-separated, lists containing them). sort_column: name | owner_name | watchlist_type | user_modify_date.',
      inputSchema: {
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional(),
        sort_direction: sortDirectionField,
        name: z.string().optional(),
        owner: ownerFilterField,
        watchlist_type: z.string().optional().describe("Packed: keys multi, indicator"),
        security_ids: z.string().optional().describe("Comma-separated security IDs to filter by"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => client().request("watchlists", { params: args as QueryParams })),
  );

  server.registerTool(
    "ycharts_watchlist_get",
    {
      title: "Get a watchlist with items",
      description:
        "GET /v4/watchlists/{id}: the watchlist's metadata plus a page of its items (multi: security_id, display_security_id, name, " +
        "currency_code, exchange, url; indicator: security_id, name, source, url).",
      inputSchema: { watchlist_id: z.number().int(), page: pageField, page_size: itemPageSizeField },
      annotations: { readOnlyHint: true },
    },
    ({ watchlist_id, page, page_size }) => run(() => client().request(`watchlists/${watchlist_id}`, { params: { page, page_size } })),
  );

  server.registerTool(
    "ycharts_watchlist_create",
    {
      title: "Create a watchlist",
      description:
        'POST /v4/watchlists: creates a watchlist. watchlist_type "multi" holds securities (AAPL, M:VFIAX, ^SPX, P:12345...); ' +
        '"indicator" holds I: indicator codes.',
      inputSchema: {
        name: z.string().min(1).max(100),
        watchlist_type: z.enum(["multi", "indicator"]),
        security_ids: z.array(z.string()).min(1).describe('e.g. ["AAPL","M:VFIAX"] or ["I:USGDP"]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ name, watchlist_type, security_ids }) => run(() => client().request("watchlists", { method: "POST", body: { name, watchlist_type, security_ids } })),
  );

  server.registerTool(
    "ycharts_watchlist_update",
    {
      title: "Update a watchlist",
      description: "PATCH /v4/watchlists/{id}: rename and/or replace the watchlist's securities (security_ids replaces the full set).",
      inputSchema: {
        watchlist_id: z.number().int(),
        name: z.string().max(100).optional(),
        security_ids: z.array(z.string()).min(1).optional().describe("Replaces the full set; omit to keep"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ watchlist_id, name, security_ids }) => run(() => client().request(`watchlists/${watchlist_id}`, { method: "PATCH", body: { name, security_ids } })),
  );

  // ------------------------------------------------------------------
  // Custom PDF Reports
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_custom_pdf_reports",
    {
      title: "List PDF reports / get generation parameters",
      description:
        "Without report_id: GET /v4/custom_pdf_reports — the custom PDF report templates available to the user. " +
        "With report_id: GET /v4/custom_pdf_reports/{id}/generation_parameters — which parameters that report requires/accepts " +
        "(security_ids, report_title, prepared_for/by, contact info, as_of_date_option latest|quarter_end|month_end, sections, " +
        "talking_points, risk_profile, ...) plus supplemental object IDs to fill them with. Always call this before generating.",
      inputSchema: {
        report_id: z.number().int().optional(),
        page: pageField,
        page_size: pageSizeField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ report_id, page, page_size }) =>
      run(() =>
        report_id !== undefined
          ? client().request(`custom_pdf_reports/${report_id}/generation_parameters`)
          : client().request("custom_pdf_reports", { params: { page, page_size } }),
      ),
  );

  server.registerTool(
    "ycharts_generate_pdf_report",
    {
      title: "Generate a custom PDF report",
      description:
        "POST /v4/custom_pdf_reports/{id}/generate: generates the report with the given parameters. Default output 'url' returns " +
        "{report_url} (link valid 1 hour); output 'file' downloads the PDF to a local temp file. params must satisfy the report's " +
        "generation_parameters (required: security_ids, report_title, prepared_for, prepared_by, contact_phone, contact_url, " +
        "as_of_date_option latest|quarter_end|month_end; plus whatever else that report lists).",
      inputSchema: {
        report_id: z.number().int(),
        params: z.record(z.unknown()).describe("CustomPDFReportGenerateRequestBody fields"),
        output: z.enum(["url", "file"]).optional().describe("Default url"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ report_id, params, output }) =>
      run(() =>
        client().request(`custom_pdf_reports/${report_id}/generate`, {
          method: "POST",
          body: params,
          accept: output === "file" ? "application/pdf" : "application/json",
        }),
      ),
  );

  // ------------------------------------------------------------------
  // Risk Profiles / Registrations / Integrations
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_risk_profiles",
    {
      title: "Risk profiles",
      description:
        "Without risk_profile_id: GET /v4/risk_profiles (paginated; filters name, packed owner). With risk_profile_id: " +
        "GET /v4/risk_profiles/{id} — full detail: risk level value/range, broad asset class targets, financial metric targets, benchmark.",
      inputSchema: {
        risk_profile_id: z.number().int().optional(),
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional().describe("name | owner_name | display_name | user_modify_date"),
        sort_direction: sortDirectionField,
        name: z.string().optional(),
        owner: ownerFilterField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ risk_profile_id, ...params }) =>
      run(() => (risk_profile_id !== undefined ? client().request(`risk_profiles/${risk_profile_id}`) : client().request("risk_profiles", { params: params as QueryParams }))),
  );

  server.registerTool(
    "ycharts_registrations",
    {
      title: "Registrations (clients/households)",
      description:
        "Without registration_id: GET /v4/registrations — paginated client registrations with summary data (AUM, risk profile, " +
        'portfolios). Filters: name, packed owner ("me:::true,,,shared_with_me:::true"), packed registration_type ' +
        '(household/client/joint/trust), packed registration_status (active/lead/inactive), include_metrics (alignment + drift). ' +
        "With registration_id: GET /v4/registrations/{id}.",
      inputSchema: {
        registration_id: z.number().int().optional(),
        include_metrics: z.boolean().optional().describe("Include is_aligned_with_risk_profile and asset_allocation_drift"),
        page: pageField,
        page_size: pageSizeField,
        sort_column: z.string().optional().describe("name | owner_name | user_modify_date | registration_status"),
        sort_direction: sortDirectionField,
        name: z.string().optional(),
        owner: ownerFilterField,
        registration_type: z.string().optional().describe("Packed: keys household, client, joint, trust"),
        registration_status: z.string().optional().describe("Packed: keys active, lead, inactive"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ registration_id, include_metrics, ...params }) =>
      run(() =>
        registration_id !== undefined
          ? client().request(`registrations/${registration_id}`, { params: { include_metrics } })
          : client().request("registrations", { params: { include_metrics, ...(params as QueryParams) } }),
      ),
  );

  server.registerTool(
    "ycharts_registrations_search",
    {
      title: "Search integration partner records",
      description:
        "GET /v4/registrations/search/{households|registrations}: search the connected integration partner (CRM/custodian) for " +
        "records to import. Returns SerializedBookOfBusinessObject entries to pass to ycharts_registration_import.",
      inputSchema: {
        search_type: z.enum(["households", "registrations"]),
        search_terms: z.string().describe("Terms to match against partner records"),
        page: pageField,
        page_size: pageSizeField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ search_type, search_terms, page, page_size }) =>
      run(() => client().request(`registrations/search/${search_type}`, { params: { search_terms, page, page_size } })),
  );

  server.registerTool(
    "ycharts_registration_create",
    {
      title: "Create a registration",
      description:
        "POST /v4/registrations: creates a client registration. params: name, registration_type (client|trust|joint|household), " +
        "registration_status (active|inactive|lead), portfolios, children (both may be []), plus optional tax_rate, investment_goal, " +
        "parent_id, risk_profile, contact ({name, email?, phone_number?, ...}).",
      inputSchema: { params: z.record(z.unknown()).describe("RegistrationParams body") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ params }) => run(() => client().request("registrations", { method: "POST", body: params })),
  );

  server.registerTool(
    "ycharts_registration_update",
    {
      title: "Update a registration",
      description: "PUT /v4/registrations/{id}: replaces an existing registration with the given RegistrationParams (same shape as create).",
      inputSchema: {
        registration_id: z.number().int(),
        params: z.record(z.unknown()).describe("RegistrationParams body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ registration_id, params }) => run(() => client().request(`registrations/${registration_id}`, { method: "PUT", body: params })),
  );

  server.registerTool(
    "ycharts_registration_import",
    {
      title: "Import from integration partner",
      description:
        "POST /v4/registrations/import/{household|registration}: imports a record found via ycharts_registrations_search (pass the " +
        "SerializedBookOfBusinessObject back verbatim — it carries an integrity signature). Returns a background job_id; poll with ycharts_background_job.",
      inputSchema: {
        import_type: z.enum(["household", "registration"]),
        book_of_business_object: z.record(z.unknown()).describe("A result object from ycharts_registrations_search, unmodified"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ import_type, book_of_business_object }) => run(() => client().request(`registrations/import/${import_type}`, { method: "POST", body: book_of_business_object })),
  );

  // ------------------------------------------------------------------
  // Quick Extract / Quickflows / Background jobs
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_quick_extract",
    {
      title: "Extract holdings from a statement file",
      description:
        "POST /v4/quick_extract: starts a Quick Extract job that parses a local portfolio/statement file (from file_path on this " +
        "machine) or a previously staged upload session, extracting accounts and holdings. weight_type says how the file's values are " +
        "denominated (Current|Dollars|Shares, default Dollars); set multiple_accounts if the file holds more than one account. " +
        "Returns an extraction id — poll with ycharts_quick_extract_status.",
      inputSchema: {
        file_path: z.string().optional().describe("Absolute path of the local file to extract (exactly one of file_path / upload_session_id)"),
        upload_session_id: z.string().optional().describe("ID of an upload session holding a staged file"),
        weight_type: z.enum(["Current", "Dollars", "Shares"]).optional().describe("Default Dollars"),
        multiple_accounts: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ file_path, upload_session_id, weight_type, multiple_accounts }) =>
      run(() => {
        if (!file_path === !upload_session_id) throw new YchartsError("Provide exactly one of file_path or upload_session_id.");
        const form = new FormData();
        if (weight_type) form.append("weight_type", weight_type);
        if (multiple_accounts !== undefined) form.append("multiple_accounts", String(multiple_accounts));
        if (upload_session_id) form.append("upload_session_id", upload_session_id);
        if (file_path) {
          const data = readFileSync(file_path);
          form.append("file", new Blob([data]), basename(file_path));
        }
        return client().request("quick_extract", { method: "POST", form });
      }),
  );

  server.registerTool(
    "ycharts_quick_extract_status",
    {
      title: "Quick Extract job / upload session status",
      description:
        "With extraction_id: GET /v4/quick_extract/{id} — job status (pending|running|completed|failed|canceled) and, when completed, " +
        "the extracted accounts with holdings (symbol, cusip, weight, shares, market_value...). With session_id: " +
        "GET /v4/quick_extract/upload_sessions/{id} — upload session status (pending|uploaded|expired).",
      inputSchema: {
        extraction_id: z.string().optional().describe("Quick Extract job ID (exactly one of the two)"),
        session_id: z.string().optional().describe("Upload session ID"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ extraction_id, session_id }) =>
      run(() => {
        if (!extraction_id === !session_id) throw new YchartsError("Provide exactly one of extraction_id or session_id.");
        return extraction_id
          ? client().request(`quick_extract/${encodeURIComponent(extraction_id)}`)
          : client().request(`quick_extract/upload_sessions/${encodeURIComponent(session_id!)}`);
      }),
  );

  server.registerTool(
    "ycharts_quickflows",
    {
      title: "Get the quickflows list",
      description: "GET /v4/quickflows_list: the user's quickflows securities list, paginated, in stored order.",
      inputSchema: { page: pageField, page_size: itemPageSizeField },
      annotations: { readOnlyHint: true },
    },
    ({ page, page_size }) => run(() => client().request("quickflows_list", { params: { page, page_size } })),
  );

  server.registerTool(
    "ycharts_quickflows_update",
    {
      title: "Replace the quickflows list",
      description:
        "PATCH /v4/quickflows_list: replaces the ENTIRE quickflows list with the given canonical security ids (e.g. \"M:VFIAX\"). " +
        "Duplicates and inaccessible securities are dropped during validation — compare against the returned list.",
      inputSchema: { security_ids: z.array(z.string()).describe("The full new list contents") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ security_ids }) => run(() => client().request("quickflows_list", { method: "PATCH", body: { security_ids } })),
  );

  server.registerTool(
    "ycharts_background_job",
    {
      title: "Background job status",
      description: "GET /v4/background_jobs/{job_id}: status/progress of a background job (e.g. a registration import).",
      inputSchema: { job_id: z.string().describe("Job UUID") },
      annotations: { readOnlyHint: true },
    },
    ({ job_id }) => run(() => client().request(`background_jobs/${encodeURIComponent(job_id)}`)),
  );

  // ------------------------------------------------------------------
  // Escape hatch
  // ------------------------------------------------------------------

  server.registerTool(
    "ycharts_raw_request",
    {
      title: "Raw YCharts API GET request",
      description:
        "Escape hatch: perform a GET against any YCharts API path (relative to the version root) with arbitrary query parameters — " +
        'for anything the dedicated tools don\'t cover. Examples: path="funds/SPY/holdings", path="indicators" with params. ' +
        'Set api_version="v3" for legacy v3 paths. GET only; writes go through the dedicated tools.',
      inputSchema: {
        path: z.string().describe('Path after the version, e.g. "watchlists/123"'),
        params: z.record(z.string()).optional().describe("Query parameters"),
        api_version: z.string().optional().describe('Override the API version for this call, e.g. "v3"'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path, params, api_version }) => run(() => client().request(path, { params, version: api_version })),
  );

  // ------------------------------------------------------------------
  // Legacy v3 data API (raw security data; separate entitlement)
  // ------------------------------------------------------------------

  const v3TypeField = z
    .enum(["companies", "mutual_funds", "indicators", "indices"])
    .describe('v3 security type. "companies" covers stocks AND ETFs (AAPL, SPY); mutual_funds use "M:" symbols; indicators "I:"; indices "^".');
  const v3SymbolsField = z.array(z.string()).min(1).max(100).describe('Symbols, max 100, e.g. ["AAPL","MSFT"], ["M:VFINX"], ["^SPX"]');
  const v3MetricsField = z
    .array(z.string())
    .min(1)
    .max(100)
    .describe('v3 metric codes, e.g. ["price","market_cap","pe_ratio"]. Unknown codes fail per-item, so trying one is cheap.');
  const v3Note = "Legacy v3 data API (not part of v4 — separate entitlement; check ycharts_status). ";

  server.registerTool(
    "ycharts_v3_securities",
    {
      title: "v3: list/discover securities",
      description:
        v3Note +
        "GET /v3/{type}: page through known securities with optional filters — companies: sector, industry, exchange, benchmark_index, " +
        "hq_region, incorporation_region, naics_sector, naics_industry, is_reit, is_lp, is_shell; mutual_funds: category, broad_asset_class, " +
        "fund_family, share_class, ...; indicators: category, region, report, source.",
      inputSchema: {
        security_type: v3TypeField,
        page: pageField,
        filters: z.record(z.string()).optional().describe('One filter is safest, e.g. {"sector": "Technology"}'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, page, filters }) => run(() => client().v3ListSecurities(security_type, page ?? 1, filters)),
  );

  server.registerTool(
    "ycharts_v3_points",
    {
      title: "v3: point-in-time values (stocks etc.)",
      description:
        v3Note +
        "GET /v3/{type}/{symbols}/points/{metrics}: latest or as-of-date values — the workhorse for raw stock data " +
        "(price, market_cap, pe_ratio, ...). Batch up to 100 symbols x 100 metrics per call.",
      inputSchema: {
        security_type: v3TypeField,
        symbols: v3SymbolsField,
        metrics: v3MetricsField,
        date: dateField.optional().describe("Omit for the latest value"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, metrics, date }) => run(() => client().v3Points(security_type, symbols, metrics, date as DateParam | undefined)),
  );

  server.registerTool(
    "ycharts_v3_series",
    {
      title: "v3: historical time series (stocks etc.)",
      description:
        v3Note +
        "GET /v3/{type}/{symbols}/series/{metrics}: historical date/value series. For long windows resample " +
        "(e.g. resample_frequency=monthly, resample_function=last) to keep responses small.",
      inputSchema: {
        security_type: v3TypeField,
        symbols: v3SymbolsField,
        metrics: v3MetricsField,
        start_date: dateField.optional(),
        end_date: dateField.optional(),
        resample_frequency: z.string().optional().describe("daily | weekly | monthly | quarterly | yearly"),
        resample_function: z.string().optional().describe("mean | min | max | first | last | sum"),
        fill_method: z.string().optional(),
        aggregate_function: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, metrics, start_date, end_date, resample_frequency, resample_function, fill_method, aggregate_function }) =>
      run(() =>
        client().v3Series(security_type, symbols, metrics, {
          startDate: start_date as DateParam | undefined,
          endDate: end_date as DateParam | undefined,
          resampleFrequency: resample_frequency,
          resampleFunction: resample_function,
          fillMethod: fill_method,
          aggregateFunction: aggregate_function,
        }),
      ),
  );

  server.registerTool(
    "ycharts_v3_info",
    {
      title: "v3: security info fields",
      description: v3Note + 'GET /v3/{type}/{symbols}/info/{fields}: descriptive fields, e.g. ["name","exchange","sector","industry","description"].',
      inputSchema: {
        security_type: v3TypeField,
        symbols: v3SymbolsField,
        fields: z.array(z.string()).min(1).max(100),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, fields }) => run(() => client().v3Info(security_type, symbols, fields)),
  );

  server.registerTool(
    "ycharts_v3_dividends",
    {
      title: "v3: dividend history",
      description: v3Note + "GET /v3/{type}/{symbols}/dividends: dividend payments (ex-date, pay date, amount, type). Date params filter on the ex-dividend date.",
      inputSchema: {
        security_type: z.enum(["companies", "mutual_funds"]),
        symbols: v3SymbolsField,
        start_date: dateField.optional(),
        end_date: dateField.optional(),
        dividend_type: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, start_date, end_date, dividend_type }) =>
      run(() =>
        client().v3Dividends(security_type, symbols, {
          startDate: start_date as DateParam | undefined,
          endDate: end_date as DateParam | undefined,
          dividendType: dividend_type,
        }),
      ),
  );

  server.registerTool(
    "ycharts_v3_splits",
    {
      title: "v3: stock splits",
      description: v3Note + "GET /v3/companies/{symbols}/splits: stock split history.",
      inputSchema: { symbols: v3SymbolsField, start_date: dateField.optional(), end_date: dateField.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, start_date, end_date }) =>
      run(() => client().v3Splits(symbols, { startDate: start_date as DateParam | undefined, endDate: end_date as DateParam | undefined })),
  );

  server.registerTool(
    "ycharts_v3_spinoffs",
    {
      title: "v3: spinoffs",
      description: v3Note + "GET /v3/companies/{symbols}/spinoffs: spinoff history.",
      inputSchema: { symbols: v3SymbolsField, start_date: dateField.optional(), end_date: dateField.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, start_date, end_date }) =>
      run(() => client().v3Spinoffs(symbols, { startDate: start_date as DateParam | undefined, endDate: end_date as DateParam | undefined })),
  );

  await server.connect(new StdioServerTransport());
}
