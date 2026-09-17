import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaychexClient, PaychexError } from "./paychex.js";
import { loadConfig, loadToken } from "./config.js";

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
        text: error instanceof PaychexError ? error.message : `Unexpected error: ${String(error)}`,
      },
    ],
    isError: true,
  }));
}

const companyIdField = z
  .string()
  .optional()
  .describe(
    "Paychex companyId (the internal ID from paychex_companies, not the human display ID). " +
      "Optional when a default company is saved or the API key sees exactly one company.",
  );

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "paychex-mcp", version: "0.4.0" });

  server.registerTool(
    "paychex_auth_status",
    {
      title: "Paychex connection status",
      description:
        "Show whether Paychex Flex credentials are configured, the default company, and the cached access token's expiry.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const config = loadConfig();
        if (!config) {
          return {
            configured: false,
            reason:
              "In a terminal, run `node dist/index.js auth` from the project's paychex folder to configure credentials.",
          };
        }
        const token = loadToken();
        return {
          configured: true,
          apiKeyEndsWith: config.clientId.slice(-6),
          defaultCompanyId: config.companyId ?? null,
          accessToken: token
            ? {
                expiresAt: new Date(token.expiresAt).toISOString(),
                expired: Date.now() > token.expiresAt,
                note: "Renewed automatically from the stored key/secret.",
              }
            : "None cached — one is requested automatically on first use.",
        };
      }),
  );

  server.registerTool(
    "paychex_companies",
    {
      title: "List Paychex companies",
      description:
        "List the Paychex Flex companies this API key can access, with their companyId, display ID, and legal name. " +
        "Use the companyId value in other tools.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => PaychexClient.load().companies()),
  );

  server.registerTool(
    "paychex_workers",
    {
      title: "List workers",
      description:
        "List the workers (employees and contractors) of a Paychex company: names, employment status, " +
        "job title, worker IDs. Collections are paged — pass limit/offset to page through large rosters.",
      inputSchema: {
        companyId: companyIdField,
        limit: z.number().int().positive().optional().describe("Page size"),
        offset: z.number().int().nonnegative().optional().describe("Zero-based row offset for paging"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ companyId, limit, offset }) =>
      run(() => PaychexClient.load().workers(companyId, { limit, offset })),
  );

  server.registerTool(
    "paychex_worker",
    {
      title: "Get a worker",
      description: "Fetch one worker's full record by workerId (from paychex_workers).",
      inputSchema: {
        workerId: z.string().describe("The worker's ID"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workerId }) => run(() => PaychexClient.load().worker(workerId)),
  );

  server.registerTool(
    "paychex_pay_periods",
    {
      title: "List pay periods",
      description:
        "List a company's pay periods (check dates, period start/end, status). " +
        'Optional params are passed straight to the API as query parameters, e.g. {"status": "COMPLETED"}.',
      inputSchema: {
        companyId: companyIdField,
        params: z
          .record(z.string())
          .optional()
          .describe("Extra query parameters per the Paychex API, e.g. {\"status\": \"COMPLETED\"}"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ companyId, params }) => run(() => PaychexClient.load().payPeriods(companyId, params ?? {})),
  );

  server.registerTool(
    "paychex_checks",
    {
      title: "List pay checks",
      description:
        "List pay checks (gross/net pay, earnings, taxes, deductions). Two modes: pass payPeriodId " +
        "(from paychex_pay_periods) for all of a company's checks in that period, or pass workerId for one " +
        "worker's checks (optionally narrowed to a pay period).",
      inputSchema: {
        payPeriodId: z
          .string()
          .optional()
          .describe("Pay period ID from paychex_pay_periods (required unless workerId is given)"),
        workerId: z.string().optional().describe("Worker ID — lists that worker's checks instead"),
        companyId: companyIdField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ payPeriodId, workerId, companyId }) =>
      run(async () => {
        const client = PaychexClient.load();
        if (workerId) return client.workerChecks(workerId, payPeriodId);
        if (!payPeriodId) {
          throw new PaychexError(
            "Pass a payPeriodId (see paychex_pay_periods) or a workerId to list checks.",
          );
        }
        return client.companyChecks(companyId, payPeriodId);
      }),
  );

  server.registerTool(
    "paychex_payroll_history",
    {
      title: "Payroll history",
      description:
        "Payroll history for a date range in one call: finds every pay period whose start, end, or " +
        "check date falls in the range and returns each with its pay checks (gross/net, earnings, " +
        "taxes, deductions) — company-wide, or one worker's when workerId is given. Most recent " +
        "first, capped at 30 periods per call. For a single known pay period use paychex_checks.",
      inputSchema: {
        from: z.string().describe("Range start, YYYY-MM-DD"),
        to: z.string().describe("Range end, YYYY-MM-DD"),
        workerId: z.string().optional().describe("Restrict to this worker's checks"),
        companyId: companyIdField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ from, to, workerId, companyId }) =>
      run(() => PaychexClient.load().payrollHistory(from, to, companyId, workerId)),
  );

  server.registerTool(
    "paychex_departments",
    {
      title: "List departments",
      description:
        "List the company's organization units (departments) as configured in Paychex Flex — " +
        "names, numbers, organizationIds. Use paychex_workers_by_department to see who is in each.",
      inputSchema: { companyId: companyIdField },
      annotations: { readOnlyHint: true },
    },
    ({ companyId }) =>
      run(async () => {
        const client = PaychexClient.load();
        const id = await client.resolveCompanyId(companyId);
        return client.get(`/companies/${encodeURIComponent(id)}/organizations`);
      }),
  );

  server.registerTool(
    "paychex_workers_by_department",
    {
      title: "Workers grouped by department",
      description:
        "The full worker roster segmented by department (each worker's organization assignment in " +
        "Paychex Flex): per department, a headcount and the workers' IDs, names, job titles, and " +
        "status. Fetches all pages automatically. Workers with no organization assignment appear " +
        'under "Unassigned".',
      inputSchema: { companyId: companyIdField },
      annotations: { readOnlyHint: true },
    },
    ({ companyId }) => run(() => PaychexClient.load().workersByDepartment(companyId)),
  );

  server.registerTool(
    "paychex_department_costs",
    {
      title: "Monthly payroll cost by department",
      description:
        "Total payroll cost per department per calendar month for a date range. A pay period " +
        "belongs to the month of its check date, and the from/to range filters by that same date, " +
        "so months are never split across range boundaries (up to the 60 most recent periods per " +
        "call; the notes name any truncation or partial month). Each check is attributed to a " +
        "department recorded on the check itself when present, otherwise to the worker's CURRENT " +
        "organization assignment applied retroactively (a mid-range transfer books all history to " +
        "the new department — the notes say when this applies). Money fields (default grossPay and " +
        "netPay) found once per check are used directly; found as repeated line items, the lines " +
        "are summed. The response includes a sampleCheck with the raw check fields — if totals " +
        "come back zero or you need employer-side costs (employer taxes, benefits), read " +
        "sampleCheck for the actual field names and call again passing them as sumFields. Checks " +
        'of departed workers appear under "Not in current roster". Read the notes array before ' +
        "presenting numbers. Pass breakdown: true for per-employee subtotals inside every " +
        "department cell.",
      inputSchema: {
        from: z.string().describe("Range start, YYYY-MM-DD"),
        to: z.string().describe("Range end, YYYY-MM-DD"),
        sumFields: z
          .array(z.string())
          .optional()
          .describe('Money fields to sum per check (default ["grossPay", "netPay"])'),
        breakdown: z
          .boolean()
          .optional()
          .describe("Also include per-employee subtotals within each department (default false)"),
        companyId: companyIdField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ from, to, sumFields, breakdown, companyId }) =>
      run(() => PaychexClient.load().departmentCosts(from, to, companyId, sumFields, breakdown)),
  );

  server.registerTool(
    "paychex_write",
    {
      title: "Write to the Paychex API",
      description:
        "Create or change Paychex Flex data through any documented write endpoint — the body is the " +
        "JSON per the Paychex API reference (developer.paychex.com), and the call succeeds only for " +
        "operations the API key's entitlements allow. Examples: POST /companies/{companyId}/workers " +
        "to add a worker; PATCH /workers/{workerId} to update one; POST " +
        "/workers/{workerId}/communications to add an address or phone. THIS CHANGES REAL PAYROLL " +
        "DATA — restate exactly what will change and confirm with the user before calling.",
      inputSchema: {
        method: z.enum(["POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method per the endpoint's docs"),
        path: z.string().describe('API path starting with "/", with real IDs substituted'),
        body: z.record(z.unknown()).optional().describe("JSON request body per the Paychex API"),
        query: z.record(z.string()).optional().describe("Query parameters, if the endpoint takes any"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ method, path, body, query }) =>
      run(() => PaychexClient.load().write(method, path, body, query)),
  );

  server.registerTool(
    "paychex_get",
    {
      title: "Raw Paychex API GET",
      description:
        "Fetch any Paychex Flex API GET endpoint not covered by the other tools. Substitute real IDs into " +
        'the path. Examples: "/companies/{companyId}/jobs", "/companies/{companyId}/paycomponents", ' +
        '"/companies/{companyId}/locations", "/workers/{workerId}/compensation/payrates", ' +
        '"/workers/{workerId}/communications". See developer.paychex.com for the full API reference.',
      inputSchema: {
        path: z.string().describe('API path starting with "/", with real IDs substituted'),
        query: z.record(z.string()).optional().describe("Query parameters, e.g. paging limit/offset"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path, query }) => run(() => PaychexClient.load().get(path, { query })),
  );

  await server.connect(new StdioServerTransport());
}
