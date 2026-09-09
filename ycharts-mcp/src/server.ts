import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BASE_CANDIDATES, loadConfig } from "./config.js";
import { REFERENCE } from "./metrics.js";
import { probeApi, YchartsClient, YchartsError, type DateParam } from "./ycharts.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
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

const securityTypeField = z
  .enum(["companies", "mutual_funds", "indicators", "indices"])
  .describe(
    'Security type. "companies" covers stocks AND ETFs (e.g. AAPL, SPY); "mutual_funds" uses "M:"-prefixed symbols (M:VFINX); ' +
      '"indicators" is economic data with "I:"-prefixed symbols (I:USICSA); "indices" uses "^"-prefixed symbols (^SPX).',
  );

const symbolsField = z
  .array(z.string())
  .min(1)
  .max(100)
  .describe('Security symbols, max 100. Examples: ["AAPL","MSFT"], ["SPY"], ["M:VFINX"], ["I:USICSA"], ["^SPX"].');

const metricsField = z
  .array(z.string())
  .min(1)
  .max(100)
  .describe(
    'YCharts metric (calculation) codes, max 100, e.g. ["price","market_cap","pe_ratio","dividend_yield","total_return_price"]. ' +
      "Unknown codes fail per-item inside the response, so trying a code is cheap. See ycharts_reference for a cheat sheet.",
  );

const dateField = z
  .union([z.string(), z.number().int()])
  .describe('Date as "YYYY-MM-DD", or a negative integer meaning N periods back relative to the metric\'s frequency (e.g. -1 = previous period).');

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "ycharts-mcp", version: "0.1.0" });

  server.registerTool(
    "ycharts_status",
    {
      title: "YCharts connection status",
      description:
        "Check whether a YCharts API key is configured and verify connectivity, probing the known API base URLs/versions " +
        "(v4 first, then v3). Use this first if other YCharts tools return authorization or not-found errors.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const config = loadConfig();
        if (!config) {
          return {
            configured: false,
            reason:
              "No API key. In a terminal, run `node dist/index.js auth` from the project's ycharts-mcp folder, or set YCHARTS_API_KEY.",
          };
        }
        const outcome = await probeApi(config.apiKey, [
          { baseUrl: config.baseUrl, apiVersion: config.apiVersion },
          ...BASE_CANDIDATES.filter((c) => c.baseUrl !== config.baseUrl || c.apiVersion !== config.apiVersion),
        ]);
        return {
          configured: true,
          configuredEndpoint: `${config.baseUrl}/${config.apiVersion}`,
          connected: Boolean(outcome.working),
          workingEndpoint: outcome.working ? `${outcome.working.baseUrl}/${outcome.working.apiVersion}` : undefined,
          keyRejected: outcome.keyRejected,
          probeResults: outcome.results,
        };
      }),
  );

  server.registerTool(
    "ycharts_reference",
    {
      title: "YCharts symbols & metrics cheat sheet",
      description:
        "Local reference (no API call): symbol conventions per security type, commonly used metric codes, info fields, " +
        "securities-list filters, and series parameter values. Consult this before guessing metric codes.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => REFERENCE),
  );

  server.registerTool(
    "ycharts_list_securities",
    {
      title: "List / discover YCharts securities",
      description:
        "Page through the securities YCharts knows for a type, optionally filtered — the way to discover symbols and " +
        "indicator codes. Filters by type: companies (sector, industry, exchange, benchmark_index, hq_region, " +
        "incorporation_region, naics_sector, naics_industry, is_reit, is_lp, is_shell); mutual_funds (category, " +
        "broad_asset_class, broad_category, fund_family, fund_manager, fund_style, share_class, legal_structure, " +
        "domicile, prospectus_objective, attribute, benchmark_index); indicators (category, region, report, source). " +
        "One filter per call is safest.",
      inputSchema: {
        security_type: securityTypeField,
        page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1)"),
        filters: z
          .record(z.string())
          .optional()
          .describe('Optional filter(s) as {"name": "value"}, e.g. {"sector": "Technology"} or {"category": "Employment"}'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, page, filters }) => run(() => YchartsClient.load().listSecurities(security_type, page ?? 1, filters)),
  );

  server.registerTool(
    "ycharts_points",
    {
      title: "YCharts point-in-time values",
      description:
        "Get the latest (or as-of-date) value of one or more metrics for one or more securities — the workhorse for " +
        '"what is X\'s price / market cap / PE right now (or on date D)". Returns one {date, value} per symbol+metric. ' +
        "Batch up to 100 symbols x 100 metrics in a single call instead of looping.",
      inputSchema: {
        security_type: securityTypeField,
        symbols: symbolsField,
        metrics: metricsField,
        date: dateField.optional().describe("As-of date; omit for the latest value."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, metrics, date }) =>
      run(() => YchartsClient.load().points(security_type, symbols, metrics, date as DateParam | undefined)),
  );

  server.registerTool(
    "ycharts_series",
    {
      title: "YCharts historical time series",
      description:
        "Get historical date/value series for one or more metrics across one or more securities. Defaults to the full " +
        "history between start_date and end_date. For long windows, resample to keep responses small " +
        "(e.g. resample_frequency=monthly, resample_function=last). fill_method=ffill aligns sparse series; " +
        "aggregate_function combines the requested securities into one series.",
      inputSchema: {
        security_type: securityTypeField,
        symbols: symbolsField,
        metrics: metricsField,
        start_date: dateField.optional(),
        end_date: dateField.optional(),
        resample_frequency: z.string().optional().describe("daily | weekly | monthly | quarterly | yearly"),
        resample_function: z.string().optional().describe("mean | min | max | first | last | sum"),
        fill_method: z.string().optional().describe("ffill | bfill"),
        aggregate_function: z.string().optional().describe("mean | sum | min | max (aggregates across securities)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, metrics, start_date, end_date, resample_frequency, resample_function, fill_method, aggregate_function }) =>
      run(() =>
        YchartsClient.load().series(security_type, symbols, metrics, {
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
    "ycharts_info",
    {
      title: "YCharts security info",
      description:
        "Get descriptive (non-numeric) fields for securities: name, exchange, sector, industry, description, fund " +
        "category/family, indicator source, etc. For numeric data use ycharts_points/ycharts_series instead.",
      inputSchema: {
        security_type: securityTypeField,
        symbols: symbolsField,
        fields: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe('Info field codes, e.g. ["name","exchange","sector","industry","description"]'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, fields }) => run(() => YchartsClient.load().info(security_type, symbols, fields)),
  );

  server.registerTool(
    "ycharts_dividends",
    {
      title: "YCharts dividend history",
      description:
        "Dividend payments for companies/ETFs or mutual funds: ex-date, pay date, amount, and type. Dates filter on the " +
        "ex-dividend date.",
      inputSchema: {
        security_type: z.enum(["companies", "mutual_funds"]).describe('"companies" covers stocks and ETFs; mutual funds use "M:" symbols'),
        symbols: symbolsField,
        start_date: dateField.optional().describe("Earliest ex-dividend date"),
        end_date: dateField.optional().describe("Latest ex-dividend date"),
        dividend_type: z.string().optional().describe('Optional filter, e.g. "regular" or "special"'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ security_type, symbols, start_date, end_date, dividend_type }) =>
      run(() =>
        YchartsClient.load().dividends(security_type, symbols, {
          startDate: start_date as DateParam | undefined,
          endDate: end_date as DateParam | undefined,
          dividendType: dividend_type,
        }),
      ),
  );

  server.registerTool(
    "ycharts_splits",
    {
      title: "YCharts stock splits",
      description: "Stock split history for companies (date and ratio), optionally within a date range.",
      inputSchema: {
        symbols: symbolsField,
        start_date: dateField.optional(),
        end_date: dateField.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, start_date, end_date }) =>
      run(() =>
        YchartsClient.load().splits(symbols, {
          startDate: start_date as DateParam | undefined,
          endDate: end_date as DateParam | undefined,
        }),
      ),
  );

  server.registerTool(
    "ycharts_spinoffs",
    {
      title: "YCharts spinoffs",
      description: "Spinoff history for companies (dates, child company, ratio), optionally within a date range.",
      inputSchema: {
        symbols: symbolsField,
        start_date: dateField.optional(),
        end_date: dateField.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, start_date, end_date }) =>
      run(() =>
        YchartsClient.load().spinoffs(symbols, {
          startDate: start_date as DateParam | undefined,
          endDate: end_date as DateParam | undefined,
        }),
      ),
  );

  server.registerTool(
    "ycharts_raw_request",
    {
      title: "Raw YCharts API GET request",
      description:
        "Escape hatch: perform a GET against any YCharts API path (relative to the version root) with arbitrary query " +
        "parameters. Use it for endpoints the dedicated tools don't cover — e.g. fund holdings, exposure/allocation " +
        "breakdowns, or anything new in v4 (see ycharts.com/v4/docs). " +
        'Examples: path="mutual_funds/M:VFINX/holdings", path="companies/AAPL/points/price". ' +
        "The YCharts API is read-only (GET).",
      inputSchema: {
        path: z.string().describe('API path after the version, e.g. "companies/AAPL/series/price"'),
        params: z.record(z.string()).optional().describe('Query parameters, e.g. {"start_date": "2020-01-01"}'),
        api_version: z.string().optional().describe('Override the configured API version for this call, e.g. "v3"'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path, params, api_version }) => run(() => YchartsClient.load().request(path, params, api_version)),
  );

  await server.connect(new StdioServerTransport());
}
