import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NinetyClient, NinetyError, compact } from "./ninety.js";
import { baseUrl, tokenSource } from "./config.js";

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
        text: error instanceof NinetyError ? error.message : `Unexpected error: ${String(error)}`,
      },
    ],
    isError: true,
  }));
}

const teamIdField = z.string().describe("Team Id (24-char hex). List teams with ninety_teams.");
const periodStartDateField = z
  .string()
  .describe(
    'Period start date, ISO 8601 — the first day of the period, e.g. "2026-07-01" or "2026-07-01T00:00:00.000Z". ' +
      "For monthly Measurables this is the first of the month; for weekly, the first day of the week.",
  );

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "ninety-mcp", version: "0.1.0" });

  // ---------------------------------------------------------------- status

  server.registerTool(
    "ninety_auth_status",
    {
      title: "Ninety connection status",
      description:
        "Check whether a Ninety Personal Access Token is configured and working. Verifies the token by " +
        "listing the teams it can access.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const source = tokenSource();
        if (!source) {
          return {
            connected: false,
            reason:
              "No token configured. Generate a Personal Access Token at " +
              "https://app.ninety.io/settings/user/developer-settings, then run " +
              "`node dist/index.js auth` in the project's ninety-mcp folder (or set NINETY_API_TOKEN).",
          };
        }
        try {
          const teams = await NinetyClient.load().request("GET", "/v1/teams");
          return { connected: true, tokenSource: source, apiBaseUrl: baseUrl(), teams };
        } catch (error) {
          return {
            connected: false,
            tokenSource: source,
            apiBaseUrl: baseUrl(),
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
  );

  // ---------------------------------------------------------- teams & users

  server.registerTool(
    "ninety_teams",
    {
      title: "List Ninety teams",
      description: "List all Teams the authenticated user belongs to (id and name).",
      annotations: { readOnlyHint: true },
    },
    () => run(() => NinetyClient.load().request("GET", "/v1/teams")),
  );

  server.registerTool(
    "ninety_user_get",
    {
      title: "Get a Ninety user",
      description:
        "Get a User by Id (name and primary email). There is no list-users endpoint in the public API; " +
        "user Ids appear on To-Dos, Rocks, Issues, and Measurables.",
      inputSchema: { id: z.string().describe("The User Id") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("GET", `/v1/users/${encodeURIComponent(id)}`)),
  );

  // ----------------------------------------------------------------- to-dos

  server.registerTool(
    "ninety_todos_query",
    {
      title: "Query Ninety To-Dos",
      description:
        "List To-Dos matching filters. Returns an array of To-Dos (title, description, dueDate, completed, " +
        "archived, teamId/teamName, userId).",
      inputSchema: {
        teamId: teamIdField.optional(),
        isPersonal: z.boolean().optional().describe("Only personal To-Dos (not tied to a team)"),
        completed: z.boolean().optional().describe("Filter by completed status"),
        archived: z.boolean().optional().describe("Filter by archived status"),
        searchText: z.string().optional().describe("Match against To-Do title and description"),
        title: z.string().optional().describe("Exact title match"),
        sort: z.string().optional().describe('Field to sort by, e.g. "dueDate"'),
        order: z.enum(["asc", "desc"]).optional(),
        page: z.number().optional().describe("Page number (1-based)"),
        pageSize: z.number().optional().describe("Results per page (max 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => NinetyClient.load().request("POST", "/v1/todos/query", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_todo_get",
    {
      title: "Get a Ninety To-Do",
      description: "Get a single To-Do by Id.",
      inputSchema: { id: z.string().describe("The To-Do Id") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("GET", `/v1/todos/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "ninety_todo_create",
    {
      title: "Create a Ninety To-Do",
      description: "Create a To-Do. Omit teamId for a personal To-Do.",
      inputSchema: {
        title: z.string().describe("The title of the To-Do"),
        description: z.string().optional(),
        dueDate: z.string().optional().describe("Due date, YYYY-MM-DD"),
        teamId: teamIdField.optional().describe("Team to assign the To-Do to; omit for a personal To-Do"),
        repeat: z.string().optional().describe('Recurrence pattern, e.g. "weekly", "monthly"'),
        userId: z.string().optional().describe("User to assign to; defaults to the authenticated user"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => run(() => NinetyClient.load().request("POST", "/v1/todos", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_todo_update",
    {
      title: "Update a Ninety To-Do",
      description: "Partially update a To-Do — only the fields provided are changed.",
      inputSchema: {
        id: z.string().describe("The To-Do Id"),
        title: z.string().optional(),
        description: z.string().optional(),
        dueDate: z.string().optional().describe("Due date in ISO format"),
        teamId: teamIdField.optional(),
        completed: z.boolean().optional(),
        archived: z.boolean().optional(),
        repeat: z.string().optional(),
        userId: z.string().optional().describe("Reassign the To-Do to this user"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id, ...rest }) =>
      run(() => NinetyClient.load().request("PATCH", `/v1/todos/${encodeURIComponent(id)}`, { body: compact(rest) })),
  );

  server.registerTool(
    "ninety_todo_delete",
    {
      title: "Delete a Ninety To-Do",
      description: "Permanently delete a To-Do by Id.",
      inputSchema: { id: z.string().describe("The To-Do Id") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("DELETE", `/v1/todos/${encodeURIComponent(id)}`)),
  );

  // ----------------------------------------------------------------- issues

  server.registerTool(
    "ninety_issues_query",
    {
      title: "Query Ninety Issues",
      description:
        "Paginated list of Issues. Returns items plus totalCount. Issues are SHORT_TERM (weekly/session) " +
        "or LONG_TERM (ongoing).",
      inputSchema: {
        teamId: z
          .string()
          .optional()
          .describe("A team Id or comma-separated team Ids; omit to query all teams"),
        intervalCode: z.enum(["SHORT_TERM", "LONG_TERM"]).optional(),
        searchText: z.string().optional().describe("Match against title, description, and comments"),
        sortField: z.string().optional().describe('Field to sort by (default "createdDate")'),
        sortDirection: z.enum(["ASC", "DESC"]).optional(),
        pageIndex: z.number().optional().describe("Zero-based page index (default 0)"),
        pageSize: z.number().optional().describe("Items per page (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => NinetyClient.load().request("POST", "/v1/issues/query", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_issue_get",
    {
      title: "Get a Ninety Issue",
      description: "Get a single Issue by Id.",
      inputSchema: { issueId: z.string().describe("The Issue Id") },
      annotations: { readOnlyHint: true },
    },
    ({ issueId }) => run(() => NinetyClient.load().request("GET", `/v1/issues/${encodeURIComponent(issueId)}`)),
  );

  server.registerTool(
    "ninety_issue_create",
    {
      title: "Create a Ninety Issue",
      description: "Create an Issue for a team.",
      inputSchema: {
        title: z.string().describe("Title of the Issue"),
        teamId: teamIdField,
        interval: z
          .enum(["SHORT_TERM", "LONG_TERM"])
          .optional()
          .describe("Issue classification (default SHORT_TERM)"),
        description: z.string().optional().describe("HTML description"),
        priority: z.number().min(0).max(5).optional().describe("0 (none) to 5 (highest)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => run(() => NinetyClient.load().request("POST", "/v1/issues", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_issue_update",
    {
      title: "Update a Ninety Issue",
      description:
        "Partially update an Issue — only the fields provided are changed. Set completed=true to resolve it.",
      inputSchema: {
        issueId: z.string().describe("The Issue Id"),
        title: z.string().optional(),
        teamId: teamIdField.optional(),
        interval: z.enum(["SHORT_TERM", "LONG_TERM"]).optional(),
        description: z.string().optional().describe("HTML description"),
        priority: z.number().min(0).max(5).optional(),
        completed: z.boolean().optional().describe("true marks the Issue resolved"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ issueId, ...rest }) =>
      run(() =>
        NinetyClient.load().request("PATCH", `/v1/issues/${encodeURIComponent(issueId)}`, { body: compact(rest) }),
      ),
  );

  server.registerTool(
    "ninety_issue_delete",
    {
      title: "Delete a Ninety Issue",
      description: "Permanently delete an Issue by Id.",
      inputSchema: { issueId: z.string().describe("The Issue Id") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ issueId }) => run(() => NinetyClient.load().request("DELETE", `/v1/issues/${encodeURIComponent(issueId)}`)),
  );

  // ------------------------------------------------------------------ rocks

  server.registerTool(
    "ninety_rocks_query",
    {
      title: "Query Ninety Rocks",
      description:
        "List Rocks (quarterly goals), grouped by teamId, with paging. Each Rock includes its milestones. " +
        "futureScope filters the planning horizon; pass \"all\" to span every scope.",
      inputSchema: {
        teamId: teamIdField.optional(),
        userId: z.string().optional().describe("Filter by owner user Id"),
        userIds: z.string().optional().describe("Comma-separated user Ids (alternative to userId)"),
        statusCode: z.enum(["OFF_TRACK", "ON_TRACK", "DONE", "CANCELED"]).optional(),
        levelCode: z.enum(["USER", "COMPANY_AND_DEPARTMENT", "COMPANY", "DEPARTMENT"]).optional(),
        futureScope: z.enum(["Current", "Next", "Later", "Future", "all"]).optional(),
        archived: z.boolean().optional().describe("true for archived Rocks only; default active only"),
        searchText: z.string().optional().describe("Match against title or description"),
        includeRockGoals: z.boolean().optional().describe("Include linked goals in the response"),
        sortField: z
          .enum(["title", "statusCode", "dueDate", "completedDate", "owner", "team", "dueDateQuarter"])
          .optional()
          .describe("Default dueDate"),
        sortDirection: z.enum(["ASC", "DESC"]).optional().describe("Default DESC"),
        pageIndex: z.number().min(0).optional().describe("Zero-based page index (default 0)"),
        pageSize: z.number().min(1).max(200).optional().describe("Items per page, max 200 (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() =>
        NinetyClient.load().request("POST", "/v1/rocks/query", {
          body: {
            sortField: "dueDate",
            sortDirection: "DESC",
            pageSize: 50,
            pageIndex: 0,
            ...compact(args),
          },
        }),
      ),
  );

  server.registerTool(
    "ninety_rock_get",
    {
      title: "Get a Ninety Rock",
      description: "Get a single Rock by Id, including its milestones, comments, and attachments.",
      inputSchema: { id: z.string().describe("The Rock Id") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("GET", `/v1/rocks/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "ninety_rock_create",
    {
      title: "Create a Ninety Rock",
      description:
        "Create a Rock (quarterly goal) owned by the authenticated user. statusCode defaults to ON_TRACK, " +
        "levelCode to USER, quarter to None.",
      inputSchema: {
        teamId: teamIdField,
        title: z.string().describe("The title of the Rock"),
        dueDate: z.string().describe('Due date, ISO 8601, e.g. "2026-12-31T23:59:59.000Z"'),
        statusCode: z.enum(["OFF_TRACK", "ON_TRACK", "DONE", "CANCELED"]).optional(),
        levelCode: z.enum(["USER", "COMPANY_AND_DEPARTMENT", "COMPANY", "DEPARTMENT"]).optional(),
        quarter: z.enum(["Q1", "Q2", "Q3", "Q4", "None"]).optional(),
        description: z.string().optional(),
        futureScope: z.enum(["Current", "Next", "Later", "Future"]).optional(),
        additionalTeamIds: z.array(z.string()).optional().describe("Other teams that can view this Rock"),
        rockQuarterYearDueDate: z.string().optional().describe("Quarter-aligned year due date (ISO 8601)"),
        addCreatorToFollowersList: z.boolean().optional().describe("Add yourself as a follower"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ addCreatorToFollowersList, ...rock }) =>
      run(() =>
        NinetyClient.load().request("POST", "/v1/rocks", {
          body: {
            rock: {
              statusCode: "ON_TRACK",
              levelCode: "USER",
              quarter: "None",
              ...compact(rock),
            },
            ...(addCreatorToFollowersList !== undefined ? { addCreatorToFollowersList } : {}),
          },
        }),
      ),
  );

  server.registerTool(
    "ninety_rock_update",
    {
      title: "Update a Ninety Rock",
      description:
        "Partially update a Rock — only the fields provided are changed. Set statusCode=DONE to complete it, " +
        "archived=true to archive.",
      inputSchema: {
        id: z.string().describe("The Rock Id"),
        userId: z.string().optional().describe("Reassign the Rock to this user"),
        teamId: teamIdField.optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        statusCode: z.enum(["OFF_TRACK", "ON_TRACK", "DONE", "CANCELED"]).optional(),
        levelCode: z.enum(["USER", "COMPANY_AND_DEPARTMENT", "COMPANY", "DEPARTMENT"]).optional(),
        quarter: z.enum(["Q1", "Q2", "Q3", "Q4", "None"]).optional(),
        dueDate: z.string().optional().describe("ISO 8601"),
        rockQuarterYearDueDate: z.string().optional().describe("ISO 8601"),
        archived: z.boolean().optional(),
        futureScope: z.enum(["Current", "Next", "Later", "Future"]).optional(),
        additionalTeamIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id, ...rest }) =>
      run(() => NinetyClient.load().request("PATCH", `/v1/rocks/${encodeURIComponent(id)}`, { body: compact(rest) })),
  );

  server.registerTool(
    "ninety_rock_delete",
    {
      title: "Delete a Ninety Rock",
      description: "Soft-delete a Rock by Id. Returns the deleted Rock.",
      inputSchema: { id: z.string().describe("The Rock Id") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("DELETE", `/v1/rocks/${encodeURIComponent(id)}`)),
  );

  // ------------------------------------------------------------- milestones

  server.registerTool(
    "ninety_milestone_get",
    {
      title: "Get a Ninety Milestone",
      description:
        "Get a single Milestone by Id. To list a Rock's milestones, use ninety_rock_get — they are embedded " +
        "in the Rock.",
      inputSchema: { id: z.string().describe("The Milestone Id") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => NinetyClient.load().request("GET", `/v1/milestones/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "ninety_milestone_create",
    {
      title: "Create a Ninety Milestone",
      description: "Create a Milestone on a Rock.",
      inputSchema: {
        rockId: z.string().describe("The Rock this Milestone belongs to"),
        title: z.string(),
        dueDate: z.string().describe("ISO 8601"),
        teamId: teamIdField,
        description: z.string().optional(),
        userOrdinal: z.number().optional().describe("0-based position in the user's list"),
        toDoId: z.string().optional().describe("Id of a related To-Do, if any"),
        isDone: z.boolean().optional().describe("true if already done at creation"),
        completedDate: z.string().optional().describe("ISO 8601; required when isDone is true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => run(() => NinetyClient.load().request("POST", "/v1/milestones", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_milestone_update",
    {
      title: "Update a Ninety Milestone",
      description:
        "Partially update a Milestone — only the fields provided are changed. Set isDone=true (with " +
        "completedDate) to complete it. The public API has no milestone delete endpoint.",
      inputSchema: {
        id: z.string().describe("The Milestone Id"),
        title: z.string().optional(),
        description: z.string().optional(),
        dueDate: z.string().optional().describe("ISO 8601"),
        isDone: z.boolean().optional(),
        completedDate: z.string().optional().describe("ISO 8601; provide when setting isDone to true"),
        ownedByUserId: z.string().optional().describe("Reassign the Milestone to this user"),
        followers: z.array(z.string()).optional().describe("User Ids following this Milestone"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ id, ...rest }) =>
      run(() =>
        NinetyClient.load().request("PATCH", `/v1/milestones/${encodeURIComponent(id)}`, { body: compact(rest) }),
      ),
  );

  // -------------------------------------------------- scorecard / measurables

  server.registerTool(
    "ninety_kpis_query",
    {
      title: "Query Ninety Measurables (KPIs)",
      description:
        "Paginated list of Scorecard Measurables with metadata: _id, title, unit, currency, periodInterval, " +
        "defaultGoal, owner, isSmart (formula-based — never write scores to these), isUsedInFormula, " +
        "lastScoreUpdatedAt, teams, scorecards. Note: the public API does not return score VALUES — " +
        "scores are write/delete only.",
      inputSchema: {
        searchText: z.string().optional().describe("Match against Measurable title or description"),
        searchTitle: z.string().optional().describe("Match against title only"),
        searchOwner: z.string().optional().describe("Match against owner name"),
        periodInterval: z.enum(["weekly", "monthly", "quarterly", "annual"]).optional(),
        userIds: z.array(z.string()).optional().describe("Filter by owner user Ids"),
        unassignedOnly: z.boolean().optional().describe("Only Measurables with no owner"),
        excludeKpiIds: z.array(z.string()).optional().describe("Measurable Ids to exclude"),
        sortField: z.enum(["id", "owner", "title"]).optional(),
        sortDirection: z.enum(["ASC", "DESC"]).optional(),
        pageIndex: z.number().optional().describe("Page number to retrieve"),
        pageSize: z.number().optional().describe("Items per page"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => NinetyClient.load().request("POST", "/v1/scorecard/kpis/query", { body: compact(args) })),
  );

  server.registerTool(
    "ninety_put_score",
    {
      title: "Set a Measurable score",
      description:
        "Create or update the score for a Measurable (KPI) for a period. An existing score for that period " +
        "is silently overwritten. Never write to formula-based (isSmart) Measurables — they compute from " +
        "other Measurables. A Measurable with isUsedInFormula=true feeds downstream calculated Measurables.",
      inputSchema: {
        kpiId: z.string().describe("The Measurable Id"),
        periodStartDate: periodStartDateField,
        value: z.number().describe("The score value"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ kpiId, periodStartDate, value }) =>
      run(() =>
        NinetyClient.load().request("POST", `/v1/scorecard/kpis/${encodeURIComponent(kpiId)}/scores`, {
          body: { periodStartDate, value },
        }),
      ),
  );

  server.registerTool(
    "ninety_put_note",
    {
      title: "Set a Measurable note",
      description:
        "Create or update the note on a Measurable (KPI) for a period. An existing note for that period is " +
        "overwritten.",
      inputSchema: {
        kpiId: z.string().describe("The Measurable Id"),
        periodStartDate: periodStartDateField,
        note: z.string().describe("The note text"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ kpiId, periodStartDate, note }) =>
      run(() =>
        NinetyClient.load().request("POST", `/v1/scorecard/kpis/${encodeURIComponent(kpiId)}/notes`, {
          body: { periodStartDate, note },
        }),
      ),
  );

  server.registerTool(
    "ninety_delete_score",
    {
      title: "Delete a Measurable score",
      description: "Delete the score for a Measurable (KPI) for a given period start date.",
      inputSchema: {
        kpiId: z.string().describe("The Measurable Id"),
        periodStartDate: periodStartDateField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ kpiId, periodStartDate }) =>
      run(() =>
        NinetyClient.load().request(
          "DELETE",
          `/v1/scorecard/kpis/${encodeURIComponent(kpiId)}/scores/${encodeURIComponent(periodStartDate)}`,
        ),
      ),
  );

  server.registerTool(
    "ninety_delete_note",
    {
      title: "Delete a Measurable note",
      description: "Delete the note on a Measurable (KPI) for a given period start date.",
      inputSchema: {
        kpiId: z.string().describe("The Measurable Id"),
        periodStartDate: periodStartDateField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ kpiId, periodStartDate }) =>
      run(() =>
        NinetyClient.load().request(
          "DELETE",
          `/v1/scorecard/kpis/${encodeURIComponent(kpiId)}/notes/${encodeURIComponent(periodStartDate)}`,
        ),
      ),
  );

  // ---------------------------------------------------------- escape hatch

  server.registerTool(
    "ninety_request",
    {
      title: "Raw Ninety API request",
      description:
        "Call any Ninety public API endpoint directly — the escape hatch for endpoints not covered by the " +
        "typed tools or added to the API after this connector was built. The path is relative to " +
        "https://api.public.ninety.io and should start with /v1/. GET /v1/swagger.json returns the live " +
        "OpenAPI spec if you need to discover new endpoints. Requests are authenticated with the configured " +
        "Personal Access Token and retried automatically on 429 rate limits.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().describe('Endpoint path, e.g. "/v1/todos/query"'),
        query: z.record(z.string()).optional().describe("URL query parameters"),
        body: z.record(z.unknown()).optional().describe("JSON request body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ method, path, query, body }) => run(() => NinetyClient.load().request(method, path, { query, body })),
  );

  await server.connect(new StdioServerTransport());
}
