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

// The worker's position: their job title in Paychex Flex, whichever shape it takes.
function positionOf(worker: Json): string {
  const candidates = [worker.jobTitle, worker.job, worker.position];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    if (typeof candidate === "object" && candidate !== null) {
      const title = (candidate as Json).title ?? (candidate as Json).name;
      if (typeof title === "string" && title.trim() !== "") return title;
    }
  }
  return "No position on file";
}

function workerDisplayName(worker: Json): string {
  const name = worker.name as Json | undefined;
  const parts = [name?.givenName, name?.middleName, name?.familyName].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return parts.join(" ") || String(worker.workerId ?? "(unknown)");
}

// Extract a money field from a check, wherever it nests — field names vary
// across Paychex resources. Two shapes exist in the wild: a check-level total
// (a value outside any array; the shallowest one wins), and per-line amounts
// (the same field repeated across earnings/tax/deduction line items, which
// must be SUMMED, not sampled). usedScalar reports which shape was taken so
// the caller can flag ambiguity when both were present.
function extractMoney(
  value: unknown,
  field: string,
): { value: number; occurrences: number; usedScalar: boolean } | undefined {
  const target = field.toLowerCase();
  const toNumber = (entry: unknown): number | undefined => {
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (typeof entry === "string" && entry.trim() !== "" && !Number.isNaN(Number(entry))) {
      return Number(entry);
    }
    if (typeof entry === "object" && entry !== null) {
      const amount = (entry as Json).amount;
      if (typeof amount === "number" && Number.isFinite(amount)) return amount;
    }
    return undefined;
  };

  type Node = { node: unknown; inArray: boolean };
  const queue: Node[] = [{ node: value, inArray: false }];
  let scalar: number | undefined; // BFS ⇒ the first non-array match is the shallowest
  let lineSum = 0;
  let occurrences = 0;
  let visited = 0;
  while (queue.length > 0 && visited < 2000) {
    const { node, inArray } = queue.shift() as Node;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, inArray: true });
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    for (const [key, entry] of Object.entries(node)) {
      if (key.toLowerCase() === target) {
        const num = toNumber(entry);
        if (num !== undefined) {
          occurrences += 1;
          if (inArray) lineSum += num;
          else scalar ??= num;
        }
      }
      if (typeof entry === "object" && entry !== null) queue.push({ node: entry, inArray });
    }
  }
  if (occurrences === 0) return undefined;
  return scalar !== undefined
    ? { value: scalar, occurrences, usedScalar: true }
    : { value: lineSum, occurrences, usedScalar: false };
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

  async payrollCosts(
    from: string,
    to: string,
    companyId?: string,
    sumFields?: string[],
    breakdown = false,
    groupBy: "department" | "position" | "employee" = "department",
  ): Promise<unknown> {
    const dateForm = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateForm.test(from) || !dateForm.test(to)) {
      throw new PaychexError("from and to must be dates in YYYY-MM-DD form.");
    }
    const id = await this.resolveCompanyId(companyId);
    const fields = sumFields && sumFields.length > 0 ? sumFields : ["grossPay", "netPay"];

    const deptByWorker = new Map<string, string>();
    const positionByWorker = new Map<string, string>();
    const nameByWorker = new Map<string, string>();
    const roster = await this.allWorkers(id);
    for (const worker of roster) {
      if (typeof worker.workerId === "string") {
        deptByWorker.set(worker.workerId, departmentOf(worker));
        positionByWorker.set(worker.workerId, positionOf(worker));
        nameByWorker.set(worker.workerId, workerDisplayName(worker));
      }
    }
    // Employee group keys: names, disambiguated by ID only when two workers share one.
    const nameCounts = new Map<string, number>();
    for (const name of nameByWorker.values()) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const employeeKeyByWorker = new Map<string, string>();
    for (const [workerId, name] of nameByWorker) {
      employeeKeyByWorker.set(
        workerId,
        (nameCounts.get(name) ?? 0) > 1 ? `${name} (${workerId})` : name,
      );
    }

    const ppBody = (await this.get(`/companies/${encodeURIComponent(id)}/payperiods`)) as {
      content?: Json[];
    };
    // One date decides BOTH range membership and month bucket, so no period can
    // be pulled in by one date and bucketed by another (partial "leaked" months).
    const periodDate = (p: Json): string | undefined => {
      for (const key of ["checkDate", "endDate", "startDate"]) {
        const value = p[key];
        if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
      }
      return undefined;
    };
    const matching = (ppBody.content ?? [])
      .map((p) => ({ period: p, date: periodDate(p) }))
      .filter((e): e is { period: Json; date: string } =>
        e.date !== undefined && e.date >= from && e.date <= to,
      )
      .sort((a, b) => b.date.localeCompare(a.date)); // most recent first
    const MAX_PERIODS = 60;
    const included = matching.slice(0, MAX_PERIODS);

    type Cell = {
      checks: number;
      workerIds: Set<string>;
      totals: Record<string, number>;
      byWorker: Map<string, { checks: number; totals: Record<string, number> }>;
    };
    const months = new Map<string, Map<string, Cell>>();
    let sampleCheck: Json | undefined;
    let totalChecks = 0;
    let checksMissingAllFields = 0;
    let checksWithOwnDept = 0;
    const fieldsSummedAsLines = new Set<string>();
    const fieldsWithAmbiguousShape = new Set<string>();
    const problems: string[] = [];

    for (const { period, date } of included) {
      const periodId = period.payPeriodId ?? period.id;
      const monthKey = date.slice(0, 7);
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
        // Grouping key by dimension. For departments, prefer a department recorded
        // on the check itself (historically accurate); positions and departments
        // otherwise use the worker's CURRENT attribute, applied retroactively.
        let dept: string;
        const orgOnCheck = (check.organization as Json | undefined)?.name;
        if (
          groupBy === "department" &&
          typeof orgOnCheck === "string" &&
          orgOnCheck.trim() !== ""
        ) {
          dept = orgOnCheck;
          checksWithOwnDept += 1;
        } else if (typeof workerId === "string") {
          const byWorkerMap =
            groupBy === "department"
              ? deptByWorker
              : groupBy === "position"
                ? positionByWorker
                : employeeKeyByWorker;
          dept = byWorkerMap.get(workerId) ?? (groupBy === "employee" ? workerId : "Not in current roster");
        } else {
          dept = "Unknown worker";
        }
        const byDept = months.get(monthKey) ?? new Map<string, Cell>();
        months.set(monthKey, byDept);
        const cell =
          byDept.get(dept) ??
          ({
            checks: 0,
            workerIds: new Set<string>(),
            totals: Object.fromEntries(fields.map((f) => [f, 0])),
            byWorker: new Map(),
          } as Cell);
        byDept.set(dept, cell);
        cell.checks += 1;
        if (typeof workerId === "string") cell.workerIds.add(workerId);
        const workerKey =
          typeof workerId === "string"
            ? (nameByWorker.get(workerId) ?? workerId)
            : "(no worker on check)";
        const workerCell = cell.byWorker.get(workerKey) ?? {
          checks: 0,
          totals: Object.fromEntries(fields.map((f) => [f, 0])),
        };
        cell.byWorker.set(workerKey, workerCell);
        workerCell.checks += 1;
        let foundAny = false;
        for (const field of fields) {
          const extracted = extractMoney(check, field);
          if (extracted !== undefined) {
            cell.totals[field] += extracted.value;
            workerCell.totals[field] += extracted.value;
            foundAny = true;
            if (extracted.occurrences > 1) {
              (extracted.usedScalar ? fieldsWithAmbiguousShape : fieldsSummedAsLines).add(field);
            }
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
                  ...(breakdown && groupBy !== "employee"
                    ? {
                        byWorker: Object.fromEntries(
                          [...cell.byWorker.entries()]
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([who, wc]) => [
                              who,
                              {
                                checks: wc.checks,
                                totals: Object.fromEntries(
                                  Object.entries(wc.totals).map(([f, v]) => [f, round2(v)]),
                                ),
                              },
                            ]),
                        ),
                      }
                    : {}),
                },
              ]),
          ),
        ]),
    );

    const notes: string[] = [...problems];
    if (matching.length > MAX_PERIODS) {
      const oldestIncluded = included[included.length - 1].date;
      notes.push(
        `Only the ${MAX_PERIODS} most recent of ${matching.length} pay periods in range were ` +
          `included; periods dated before ${oldestIncluded} were dropped, so the ` +
          `${oldestIncluded.slice(0, 7)} cell may be incomplete. Narrow the date range to cover ` +
          "the rest.",
      );
    }
    const lastDayOfToMonth = new Date(
      Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0),
    ).getUTCDate();
    if (from.slice(8) !== "01") {
      notes.push(
        `The range starts mid-month (${from}), so the ${from.slice(0, 7)} cell covers only part of that month.`,
      );
    }
    if (Number(to.slice(8)) !== lastDayOfToMonth) {
      notes.push(
        `The range ends mid-month (${to}), so the ${to.slice(0, 7)} cell covers only part of that month.`,
      );
    }
    if (groupBy !== "employee") {
      if (totalChecks > 0 && checksWithOwnDept === 0) {
        notes.push(
          `Every check is attributed to the worker's CURRENT ${groupBy}` +
            (groupBy === "department" ? " (none of the checks carried their own)" : "") +
            ", applied retroactively — a worker whose " +
            `${groupBy} changed mid-range books all past checks to the current one.`,
        );
      } else if (checksWithOwnDept > 0 && checksWithOwnDept < totalChecks) {
        notes.push(
          `${checksWithOwnDept} of ${totalChecks} checks carried their own department; the rest ` +
            "were attributed to each worker's current assignment.",
        );
      }
    }
    if (fieldsSummedAsLines.size > 0) {
      notes.push(
        `Field(s) ${[...fieldsSummedAsLines].join(", ")} appear as repeated line items on ` +
          "checks; all lines were summed per check.",
      );
    }
    if (fieldsWithAmbiguousShape.size > 0) {
      notes.push(
        `Field(s) ${[...fieldsWithAmbiguousShape].join(", ")} appear several times per check ` +
          "including a check-level value; the check-level value was used once per check and " +
          "line items with the same name were ignored — verify against sampleCheck.",
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
      groupBy,
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
