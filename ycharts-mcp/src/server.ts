import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { keySource, loadApiKey, maskKey } from "./config.js";
import { runDiagnostics } from "./diagnose.js";
import { YchartsClient, YchartsError } from "./ycharts.js";

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

const kindField = z
  .enum(["companies", "mutual_funds", "indices", "indicators"])
  .default("companies")
  .describe('v3 security kind; use "companies" for stocks (default).');

const symbolsField = z.array(z.string()).min(1).max(100).describe('Ticker symbols, e.g. ["NVDA", "BRK.B"].');

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "ycharts-mcp", version: "0.1.0" });

  server.registerTool(
    "ycharts_status",
    {
      title: "YCharts connection status",
      description: "Show whether a YCharts API key is configured and where it came from (env var or config file).",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const key = loadApiKey();
        if (!key) {
          return {
            configured: false,
            reason:
              "No API key. Set YCHARTS_API_KEY, or in a terminal run `node dist/index.js setup` in the ycharts-mcp folder.",
          };
        }
        return { configured: true, source: keySource(), key: maskKey(key) };
      }),
  );

  server.registerTool(
    "ycharts_diagnose",
    {
      title: "Diagnose YCharts API entitlements",
      description:
        "Run a battery of live probes against the YCharts v3 and v4 APIs to map what this API key can access: " +
        "auth validity, screener reads, fund data, v4 company fundamentals, and v3 per-stock points/info " +
        "(price, pe_ratio, market_cap, earnings dates). Run this FIRST on a new setup — it answers whether raw " +
        "per-stock fundamentals are available or whether screener exports are still needed.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => runDiagnostics(YchartsClient.load())),
  );

  // ---- v3: raw per-security data ----

  server.registerTool(
    "ycharts_company_points",
    {
      title: "YCharts point-in-time values (v3)",
      description:
        "Get the latest (or as-of-date) value of one or more metrics for one or more securities via the v3 API. " +
        'Metric codes are YCharts calc codes, e.g. "price", "pe_ratio", "market_cap", "return_on_invested_capital", ' +
        '"dividend_yield", "sma_50". Returns raw numbers per symbol per metric.',
      inputSchema: {
        symbols: symbolsField,
        calc_codes: z.array(z.string()).min(1).max(25).describe('YCharts calc codes, e.g. ["pe_ratio", "market_cap"].'),
        date: z.string().optional().describe("Optional as-of date, YYYY-MM-DD. Omit for latest."),
        kind: kindField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, calc_codes, date, kind }) => run(() => YchartsClient.load().v3Points(kind, symbols, calc_codes, date)),
  );

  server.registerTool(
    "ycharts_company_series",
    {
      title: "YCharts time series (v3)",
      description:
        "Get a historical time series of one or more metrics for one or more securities via the v3 API. " +
        "Dates are YYYY-MM-DD. Supports optional resampling (e.g. resample_frequency=monthly).",
      inputSchema: {
        symbols: symbolsField,
        calc_codes: z.array(z.string()).min(1).max(25).describe("YCharts calc codes."),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        end_date: z.string().optional().describe("YYYY-MM-DD"),
        resample_frequency: z.string().optional().describe("e.g. daily, weekly, monthly, quarterly, annually"),
        resample_function: z.string().optional().describe("e.g. last, mean, min, max"),
        kind: kindField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, calc_codes, start_date, end_date, resample_frequency, resample_function, kind }) =>
      run(() =>
        YchartsClient.load().v3Series(kind, symbols, calc_codes, {
          start_date,
          end_date,
          resample_frequency,
          resample_function,
        }),
      ),
  );

  server.registerTool(
    "ycharts_company_info",
    {
      title: "YCharts security info fields (v3)",
      description:
        "Get non-numeric info fields for one or more securities via the v3 API, e.g. " +
        '"sector", "industry", "next_earnings_release", "exchange". Useful for GICS sectors and earnings dates.',
      inputSchema: {
        symbols: symbolsField,
        info_fields: z.array(z.string()).min(1).max(25).describe('Info field codes, e.g. ["sector", "next_earnings_release"].'),
        kind: kindField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ symbols, info_fields, kind }) => run(() => YchartsClient.load().v3Info(kind, symbols, info_fields)),
  );

  // ---- v4: screeners, security lists, funds ----

  server.registerTool(
    "ycharts_screeners_list",
    {
      title: "List saved screeners (v4)",
      description: "List saved YCharts screeners (metadata only). screener_type is company or fund.",
      inputSchema: {
        screener_type: z.enum(["company", "fund"]).default("company"),
        name: z.string().optional().describe("Partial name filter"),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ screener_type, name, page, page_size }) =>
      run(() => YchartsClient.load().listScreeners({ screener_type, name, page, page_size })),
  );

  server.registerTool(
    "ycharts_screener",
    {
      title: "Run a saved screener (v4)",
      description:
        "Re-run a saved screener and get its criteria plus the current matching tickers (paginated; rows carry " +
        "identity fields only — fetch metric values separately with ycharts_company_points).",
      inputSchema: {
        screener_type: z.enum(["company", "fund"]).default("company"),
        screener_id: z.number().int(),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ screener_type, screener_id, page, page_size }) =>
      run(() => YchartsClient.load().getScreener(screener_type, screener_id, page, page_size)),
  );

  server.registerTool(
    "ycharts_security_lists",
    {
      title: "Search security lists (v4)",
      description:
        'Search universes usable as screener filters (e.g. "s&p 500" -> internal_name "index_sandp_500") and the ' +
        "user's own saved objects (watchlists, screens, model portfolios).",
      inputSchema: {
        query: z.string().optional(),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, page, page_size }) => run(() => YchartsClient.load().securityLists(query, page, page_size)),
  );

  server.registerTool(
    "ycharts_fund_data",
    {
      title: "Fund/ETF data (v4)",
      description:
        "Get fund-level data for up to 25 mutual funds/ETFs: weighted average fundamentals (P/E, P/B), returns, " +
        "risk stats, expense ratio, AUM. Equities are rejected by this endpoint — use ycharts_company_points for stocks.",
      inputSchema: { symbols: z.array(z.string()).min(1).max(25) },
      annotations: { readOnlyHint: true },
    },
    ({ symbols }) => run(() => YchartsClient.load().fundData(symbols)),
  );

  server.registerTool(
    "ycharts_fund_holdings",
    {
      title: "Fund/ETF top holdings (v4)",
      description: "Get a fund/ETF's top holdings (up to 25) with portfolio weights — e.g. SPY for exact S&P 500 top-25 weights.",
      inputSchema: { symbol: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ symbol }) => run(() => YchartsClient.load().fundHoldings(symbol)),
  );

  // ---- v4: model portfolios ----

  server.registerTool(
    "ycharts_model_portfolios",
    {
      title: "List model portfolios (v4)",
      description:
        "List model portfolios. Defaults to portfolios you own (the full shared/public list can run to hundreds).",
      inputSchema: {
        name: z.string().optional().describe("Partial name filter"),
        owner: z
          .string()
          .optional()
          .describe('Owner filter; defaults to "me:::true,,,shared_with_me:::false,,,public:::false".'),
        portfolio_type: z.string().optional().describe('e.g. "model_portfolio"'),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ name, owner, portfolio_type, page, page_size }) =>
      run(() =>
        YchartsClient.load().modelPortfolios({
          name,
          owner: owner ?? "me:::true,,,shared_with_me:::false,,,public:::false",
          portfolio_type,
          page,
          page_size: page_size ?? 25,
        }),
      ),
  );

  server.registerTool(
    "ycharts_model_portfolio_holdings",
    {
      title: "Model portfolio holdings (v4)",
      description:
        'Get holdings with weights for one or more model portfolios. weight_type "target" returns target weights, ' +
        '"current" returns drifted live weights — comparing the two is the basis for drift-band monitoring.',
      inputSchema: {
        portfolio_ids: z.string().describe('Portfolio id or comma-separated ids, e.g. "2031783".'),
        weight_type: z.enum(["target", "current"]),
      },
      annotations: { readOnlyHint: true },
    },
    ({ portfolio_ids, weight_type }) => run(() => YchartsClient.load().modelPortfolioHoldings(portfolio_ids, weight_type)),
  );

  server.registerTool(
    "ycharts_model_portfolio_points",
    {
      title: "Model portfolio point values (v4)",
      description:
        "Get point-in-time calc values for model portfolios: drift, returns, sector exposures, weighted average " +
        "fundamentals (weighted_average_pe_ratio, average_market_cap_generic), and more.",
      inputSchema: {
        portfolio_ids: z.string(),
        calc_names: z.array(z.string()).min(1).max(25),
        date: z.string().optional().describe("YYYY-MM-DD; omit for latest."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ portfolio_ids, calc_names, date }) => run(() => YchartsClient.load().modelPortfolioPoints(portfolio_ids, calc_names, date)),
  );

  server.registerTool(
    "ycharts_model_portfolio_series",
    {
      title: "Model portfolio time series (v4)",
      description: "Get historical series of calc values (e.g. drift, daily returns) for model portfolios.",
      inputSchema: {
        portfolio_ids: z.string(),
        calc_names: z.array(z.string()).min(1).max(25),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ portfolio_ids, calc_names, start_date, end_date }) =>
      run(() => YchartsClient.load().modelPortfolioSeries(portfolio_ids, calc_names, { start_date, end_date })),
  );

  server.registerTool(
    "ycharts_model_portfolio_status",
    {
      title: "Model portfolio calc status (v4)",
      description: "Check a model portfolio's calculation status (available / calculating / needs_review / calc_failed).",
      inputSchema: { portfolio_id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    ({ portfolio_id }) => run(() => YchartsClient.load().modelPortfolioStatus(portfolio_id)),
  );

  server.registerTool(
    "ycharts_create_fixed_model_portfolio",
    {
      title: "Create a fixed model portfolio (v4)",
      description:
        "Create a fixed-weight model portfolio (async: poll ycharts_model_portfolio_status afterwards). The body " +
        "is the v4 API JSON payload with portfolio labels, benchmark, and items with target_weighting per ticker.",
      inputSchema: { body: z.record(z.unknown()).describe("v4 POST /model_portfolios/fixed JSON body") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ body }) => run(() => YchartsClient.load().createFixedModelPortfolio(body)),
  );

  server.registerTool(
    "ycharts_update_fixed_model_portfolio",
    {
      title: "Update a fixed model portfolio (v4)",
      description:
        "PATCH a fixed model portfolio (e.g. replace portfolio_items with a new full target-weight list on rebalance). " +
        "portfolio_items REPLACES all holdings — send the complete list.",
      inputSchema: {
        portfolio_id: z.number().int(),
        body: z.record(z.unknown()).describe("v4 PATCH /model_portfolios/fixed/{id} JSON body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ portfolio_id, body }) => run(() => YchartsClient.load().updateFixedModelPortfolio(portfolio_id, body)),
  );

  // ---- escape hatch ----

  server.registerTool(
    "ycharts_request",
    {
      title: "Raw YCharts API request",
      description:
        "Escape hatch: make a raw request to any YCharts API v3/v4 path (api.ycharts.com only — the key never " +
        "goes anywhere else). Use for endpoints not wrapped by a dedicated tool.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "PUT"]).default("GET"),
        path: z.string().regex(/^\/v[34]\//, "Path must start with /v3/ or /v4/"),
        params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    ({ method, path, params, body }) => run(() => YchartsClient.load().request(method, path, { params, body })),
  );

  await server.connect(new StdioServerTransport());
}
