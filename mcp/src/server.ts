import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { QboClient, QboError } from "./qbo.js";
import { loadConfig, loadTokens } from "./config.js";

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
        text: error instanceof QboError ? error.message : `Unexpected error: ${String(error)}`,
      },
    ],
    isError: true,
  }));
}

const entityField = z
  .string()
  .describe(
    'QuickBooks entity type in canonical casing, e.g. "Invoice", "Bill", "Customer", "Vendor", "Payment", "JournalEntry", "PurchaseOrder", "Item", "Account".',
  );

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "qbo-mcp", version: "0.1.0" });

  server.registerTool(
    "qbo_auth_status",
    {
      title: "QuickBooks connection status",
      description:
        "Show whether a QuickBooks Online company is connected, which environment is in use, and when the tokens expire.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const config = loadConfig();
        const tokens = loadTokens();
        if (!config) return { connected: false, reason: "In a terminal, run `node dist/index.js auth` from the project's mcp folder to configure credentials." };
        if (!tokens) return { connected: false, environment: config.environment, reason: "In a terminal, run `node dist/index.js auth` from the project's mcp folder to authorize a company." };
        return {
          connected: true,
          environment: config.environment,
          realmId: tokens.realmId,
          accessTokenExpiresAt: new Date(tokens.accessTokenExpiresAt).toISOString(),
          refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt).toISOString(),
        };
      }),
  );

  server.registerTool(
    "qbo_company_info",
    {
      title: "QuickBooks company info",
      description: "Get the connected company's profile: legal name, address, fiscal year start, currency.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => QboClient.load().companyInfo()),
  );

  server.registerTool(
    "qbo_query",
    {
      title: "Query QuickBooks records",
      description:
        "Run a QuickBooks Online query (SQL-like SELECT syntax) against the connected company. " +
        'Examples: "SELECT * FROM Invoice WHERE TxnDate >= \'2026-01-01\' ORDERBY TxnDate DESC MAXRESULTS 50", ' +
        '"SELECT Id, DisplayName, Balance FROM Customer WHERE Active = true", ' +
        '"SELECT COUNT(*) FROM Bill". ' +
        "Results are capped at 1000 rows per call; page with STARTPOSITION and MAXRESULTS.",
      inputSchema: { query: z.string().describe("QuickBooks query statement (SELECT ... FROM <Entity> ...)") },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => run(() => QboClient.load().query(query)),
  );

  server.registerTool(
    "qbo_get",
    {
      title: "Get a QuickBooks record",
      description: "Fetch one record by entity type and Id, including its current SyncToken.",
      inputSchema: {
        entity: entityField,
        id: z.string().describe("The record's Id"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ entity, id }) => run(() => QboClient.load().getEntity(entity, id)),
  );

  server.registerTool(
    "qbo_report",
    {
      title: "Run a QuickBooks report",
      description:
        "Run a built-in QuickBooks Online report. Common report names: ProfitAndLoss, ProfitAndLossDetail, " +
        "BalanceSheet, CashFlow, TrialBalance, GeneralLedger, AgedReceivables, AgedPayables, " +
        "CustomerBalance, VendorBalance, TransactionList. " +
        "Common params: start_date / end_date (YYYY-MM-DD), date_macro (e.g. \"Last Fiscal Year\", \"This Month\"), " +
        "accounting_method (Cash or Accrual), summarize_column_by (Month, Quarter, Year, Total).",
      inputSchema: {
        report: z.string().describe("Report name, e.g. ProfitAndLoss"),
        params: z
          .record(z.string())
          .optional()
          .describe("Report query parameters, e.g. {\"start_date\": \"2026-01-01\", \"end_date\": \"2026-06-30\"}"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ report, params }) => run(() => QboClient.load().report(report, params ?? {})),
  );

  server.registerTool(
    "qbo_create",
    {
      title: "Create a QuickBooks record",
      description:
        "Create a new record (invoice, bill, customer, journal entry, ...) in the connected company. " +
        "The payload is the QuickBooks Online API JSON body for that entity.",
      inputSchema: {
        entity: entityField,
        payload: z.record(z.unknown()).describe("Entity JSON body per the QuickBooks Online API"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ entity, payload }) => run(() => QboClient.load().create(entity, payload)),
  );

  server.registerTool(
    "qbo_update",
    {
      title: "Update a QuickBooks record",
      description:
        "Sparse-update an existing record. The payload must include Id; SyncToken is fetched automatically " +
        "if omitted. Only the fields present in the payload are changed.",
      inputSchema: {
        entity: entityField,
        payload: z.record(z.unknown()).describe("Fields to change, plus Id (SyncToken optional)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ entity, payload }) => run(() => QboClient.load().update(entity, payload)),
  );

  server.registerTool(
    "qbo_delete",
    {
      title: "Delete a QuickBooks record",
      description:
        "Delete a transaction record (invoice, bill, payment, ...) by Id. The current SyncToken is fetched " +
        "automatically if omitted. Name-list entities (Customer, Vendor, Item, Account) cannot be deleted — " +
        "deactivate them with qbo_update {Active: false} instead.",
      inputSchema: {
        entity: entityField,
        id: z.string().describe("The record's Id"),
        syncToken: z.string().optional().describe("Current SyncToken; fetched automatically if omitted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ entity, id, syncToken }) => run(() => QboClient.load().remove(entity, id, syncToken)),
  );

  await server.connect(new StdioServerTransport());
}
