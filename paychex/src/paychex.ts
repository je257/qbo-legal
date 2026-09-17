import { AppConfig, CachedToken, loadConfig, loadToken, saveToken } from "./config.js";
import { BASE_URL, fetchToken } from "./auth.js";

export class PaychexError extends Error {}

type Query = Record<string, string | number | undefined>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Json = Record<string, unknown>;

// The department a worker belongs to: their organization assignment in Paychex Flex.
function departmentOf(worker: Json): string {
  const org = worker.organization as Json | undefined;
  const name = org?.name ?? org?.organizationId;
  return typeof name === "string" && name.trim() !== "" ? name : "Unassigned";
}

function workerDisplayName(worker: Json): string {
  const name = worker.name as Json | undefined;
  const parts = [name?.givenName, name?.middleName, name?.familyName].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return parts.join(" ") || String(worker.workerId ?? "(unknown)");
}

// Find the first (shallowest) occurrence of a money field in a check object,
// whatever its nesting — field names vary across Paychex resources.
function firstNumber(value: unknown, field: string): number | undefined {
  const target = field.toLowerCase();
  const queue: unknown[] = [value];
  let visited = 0;
  while (queue.length > 0 && visited < 1000) {
    const current = queue.shift();
    visited += 1;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    for (const [key, entry] of Object.entries(current)) {
      if (key.toLowerCase() !== target) continue;
      if (typeof entry === "number" && Number.isFinite(entry)) return entry;
      if (typeof entry === "string" && entry.trim() !== "" && !Number.isNaN(Number(entry))) {
        return Number(entry);
      }
      if (typeof entry === "object" && entry !== null) {
        const amount = (entry as Json).amount;
        if (typeof amount === "number" && Number.isFinite(amount)) return amount;
      }
    }
    for (const entry of Object.values(current)) {
      if (typeof entry === "object" && entry !== null) queue.push(entry);
    }
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class PaychexClient {
  private config: AppConfig;
  private token: CachedToken | undefined;

  private constructor(config: AppConfig, token: CachedToken | undefined) {
    this.config = config;
    this.token = token;
  }

  static load(): PaychexClient {
    const config = loadConfig();
    if (!config) {
      throw new PaychexError(
        "Paychex Flex credentials are not configured. Open a terminal in the project's paychex " +
          "folder and run `node dist/index.js auth` first.",
      );
    }
    return new PaychexClient(config, loadToken());
  }

  get defaultCompanyId(): string | undefined {
    return this.config.companyId;
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.token || Date.now() > this.token.expiresAt - 60_000) {
      try {
        this.token = await fetchToken(this.config);
      } catch (error) {
        throw new PaychexError(error instanceof Error ? error.message : String(error));
      }
      saveToken(this.token);
    }
    return this.token.accessToken;
  }

  async request(
    method: Method,
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    if (!path.startsWith("/")) {
      throw new PaychexError('The API path must start with "/", e.g. "/companies".');
    }
    const url = new URL(BASE_URL + path);
    if (url.origin !== BASE_URL) {
      throw new PaychexError("The API path must stay on api.paychex.com.");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const doFetch = (accessToken: string) =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

    let res = await doFetch(await this.ensureAccessToken());
    if (res.status === 401) {
      // The cached token was revoked or expired early — fetch a fresh one and retry once.
      this.token = undefined;
      res = await doFetch(await this.ensureAccessToken());
    }
    const text = await res.text();
    if (!res.ok) {
      throw new PaychexError(`Paychex API error (${res.status} ${res.statusText}): ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  get(path: string, options: { query?: Query } = {}): Promise<unknown> {
    return this.request("GET", path, options);
  }

  write(
    method: Exclude<Method, "GET">,
    path: string,
    body?: Record<string, unknown>,
    query?: Query,
  ): Promise<unknown> {
    return this.request(method, path, { body, query });
  }

  async resolveCompanyId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    if (this.config.companyId) return this.config.companyId;
    const body = (await this.get("/companies")) as { content?: { companyId?: string }[] };
    const companies = body.content ?? [];
    if (companies.length === 1 && companies[0].companyId) return companies[0].companyId;
    throw new PaychexError(
      companies.length === 0
        ? "This API key cannot see any Paychex companies yet. In the Paychex developer portal " +
            "(developer.paychex.com), link your Paychex Flex company to the application — a " +
            "company admin must approve the access."
        : "Several Paychex companies are available and no default is saved. Call " +
            "paychex_companies, then pass the desired companyId — or run " +
            "`node dist/index.js auth` in the paychex folder to save a default.",
    );
  }

  companies(): Promise<unknown> {
    return this.get("/companies");
  }

  async workers(companyId: string | undefined, query: Query): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/workers`, { query });
  }

  worker(workerId: string): Promise<unknown> {
    return this.get(`/workers/${encodeURIComponent(workerId)}`);
  }

  async payPeriods(companyId: string | undefined, query: Query): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/payperiods`, { query });
  }

  async companyChecks(companyId: string | undefined, payPeriodId: string): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/checks`, {
      query: { payperiodid: payPeriodId },
    });
  }

  workerChecks(workerId: string, payPeriodId?: string): Promise<unknown> {
    return this.get(`/workers/${encodeURIComponent(workerId)}/checks`, {
      query: { payperiodid: payPeriodId },
    });
  }

  async allWorkers(companyId: string): Promise<Json[]> {
    const workers: Json[] = [];
    const PAGE = 100;
    for (let offset = 0; offset < 5000; offset += PAGE) {
      const body = (await this.get(`/companies/${encodeURIComponent(companyId)}/workers`, {
        query: { limit: PAGE, offset },
      })) as { content?: Json[] };
      const page = body.content ?? [];
      workers.push(...page);
      if (page.length < PAGE) break;
    }
    return workers;
  }

  async workersByDepartment(companyId?: string): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    const workers = await this.allWorkers(id);
    const groups: Record<string, Json[]> = {};
    for (const worker of workers) {
      const dept = departmentOf(worker);
      (groups[dept] ??= []).push({
        workerId: worker.workerId,
        name: workerDisplayName(worker),
        jobTitle: worker.jobTitle,
        employmentType: worker.employmentType,
        currentStatus: worker.currentStatus,
      });
    }
    const departments = Object.fromEntries(
      Object.entries(groups)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dept, list]) => [dept, { count: list.length, workers: list }]),
    );
    const allUnassigned = workers.length > 0 && Object.keys(groups).join("") === "Unassigned";
    return {
      companyId: id,
      workerCount: workers.length,
      departments,
      ...(allUnassigned
        ? {
            note:
              "No worker has an organization assignment. Departments come from Paychex Flex " +
              "organization units — set them up (and assign workers) in Paychex Flex, or check " +
              "paychex_departments for the configured units.",
          }
        : {}),
    };
  }

  async departmentCosts(
    from: string,
    to: string,
    companyId?: string,
    sumFields?: string[],
  ): Promise<unknown> {
    const dateForm = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateForm.test(from) || !dateForm.test(to)) {
      throw new PaychexError("from and to must be dates in YYYY-MM-DD form.");
    }
    const id = await this.resolveCompanyId(companyId);
    const fields = sumFields && sumFields.length > 0 ? sumFields : ["grossPay", "netPay"];

    const deptByWorker = new Map<string, string>();
    for (const worker of await this.allWorkers(id)) {
      if (typeof worker.workerId === "string") {
        deptByWorker.set(worker.workerId, departmentOf(worker));
      }
    }

    const ppBody = (await this.get(`/companies/${encodeURIComponent(id)}/payperiods`)) as {
      content?: Json[];
    };
    const inRange = (value: unknown): boolean =>
      typeof value === "string" && value.slice(0, 10) >= from && value.slice(0, 10) <= to;
    const matching = (ppBody.content ?? []).filter(
      (p) => inRange(p.checkDate) || inRange(p.endDate) || inRange(p.startDate),
    );
    const MAX_PERIODS = 60;
    const periods = matching.slice(0, MAX_PERIODS);

    type Cell = { checks: number; workerIds: Set<string>; totals: Record<string, number> };
    const months = new Map<string, Map<string, Cell>>();
    let sampleCheck: Json | undefined;
    let totalChecks = 0;
    let checksMissingAllFields = 0;
    const problems: string[] = [];

    for (const period of periods) {
      const periodId = period.payPeriodId ?? period.id;
      const monthKey =
        String(period.checkDate ?? period.endDate ?? period.startDate ?? "").slice(0, 7) ||
        "unknown";
      if (typeof periodId !== "string") {
        problems.push(`A pay period dated ${monthKey} has no recognizable ID; skipped.`);
        continue;
      }
      let checks: Json[];
      try {
        const body = (await this.companyChecks(id, periodId)) as { content?: Json[] };
        checks = body.content ?? [];
      } catch (error) {
        problems.push(
          `Checks for pay period ${periodId} (${monthKey}) failed: ` +
            (error instanceof Error ? error.message.split("\n")[0] : String(error)),
        );
        continue;
      }
      for (const check of checks) {
        totalChecks += 1;
        sampleCheck ??= check;
        const workerId =
          typeof check.workerId === "string"
            ? check.workerId
            : ((check.worker as Json | undefined)?.workerId as string | undefined);
        let dept = "Unknown worker";
        if (typeof workerId === "string") {
          dept = deptByWorker.get(workerId) ?? "Not in current roster";
        }
        const byDept = months.get(monthKey) ?? new Map<string, Cell>();
        months.set(monthKey, byDept);
        const cell =
          byDept.get(dept) ??
          ({
            checks: 0,
            workerIds: new Set<string>(),
            totals: Object.fromEntries(fields.map((f) => [f, 0])),
          } as Cell);
        byDept.set(dept, cell);
        cell.checks += 1;
        if (typeof workerId === "string") cell.workerIds.add(workerId);
        let foundAny = false;
        for (const field of fields) {
          const value = firstNumber(check, field);
          if (value !== undefined) {
            cell.totals[field] += value;
            foundAny = true;
          }
        }
        if (!foundAny) checksMissingAllFields += 1;
      }
    }

    const monthsOut = Object.fromEntries(
      [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, byDept]) => [
          month,
          Object.fromEntries(
            [...byDept.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([dept, cell]) => [
                dept,
                {
                  checks: cell.checks,
                  workers: cell.workerIds.size,
                  totals: Object.fromEntries(
                    Object.entries(cell.totals).map(([f, v]) => [f, round2(v)]),
                  ),
                },
              ]),
          ),
        ]),
    );

    const notes: string[] = [...problems];
    if (matching.length > MAX_PERIODS) {
      notes.push(
        `Only the first ${MAX_PERIODS} of ${matching.length} pay periods in range were included — narrow the date range for the rest.`,
      );
    }
    if (checksMissingAllFields > 0) {
      notes.push(
        `${checksMissingAllFields} of ${totalChecks} checks contained none of the summed fields ` +
          `(${fields.join(", ")}). Inspect sampleCheck for the real money field names and call ` +
          "again with them as sumFields.",
      );
    }

    return {
      companyId: id,
      from,
      to,
      sumFields: fields,
      payPeriodsInRange: matching.length,
      totalChecks,
      months: monthsOut,
      ...(notes.length > 0 ? { notes } : {}),
      sampleCheck:
        sampleCheck ??
        "No checks found in the range — verify the dates with paychex_pay_periods.",
    };
  }

  async payrollHistory(
    from: string,
    to: string,
    companyId?: string,
    workerId?: string,
  ): Promise<unknown> {
    const dateForm = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateForm.test(from) || !dateForm.test(to)) {
      throw new PaychexError("from and to must be dates in YYYY-MM-DD form.");
    }
    const id = await this.resolveCompanyId(companyId);
    const body = (await this.get(`/companies/${encodeURIComponent(id)}/payperiods`)) as {
      content?: Record<string, unknown>[];
    };
    const inRange = (value: unknown): boolean =>
      typeof value === "string" && value.slice(0, 10) >= from && value.slice(0, 10) <= to;
    const sortKey = (p: Record<string, unknown>) =>
      String(p.checkDate ?? p.endDate ?? p.startDate ?? "");
    const matching = (body.content ?? [])
      .filter((p) => inRange(p.checkDate) || inRange(p.endDate) || inRange(p.startDate))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

    const MAX_PERIODS = 30;
    const periods = [];
    for (const payPeriod of matching.slice(0, MAX_PERIODS)) {
      const periodId = payPeriod.payPeriodId ?? payPeriod.id;
      let checks: unknown;
      if (typeof periodId === "string") {
        try {
          const checksBody = (await (workerId
            ? this.workerChecks(workerId, periodId)
            : this.companyChecks(id, periodId))) as { content?: unknown };
          checks = checksBody.content ?? checksBody;
        } catch (error) {
          checks = { error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        checks = { error: "Pay period record has no recognizable ID — fetch it via paychex_get." };
      }
      periods.push({ payPeriod, checks });
    }

    return {
      companyId: id,
      from,
      to,
      ...(workerId ? { workerId } : {}),
      payPeriodsFound: matching.length,
      ...(matching.length > MAX_PERIODS
        ? {
            note: `Only the ${MAX_PERIODS} most recent pay periods are included — narrow the date range for the rest.`,
          }
        : {}),
      periods,
    };
  }
}
