import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  AppConfig,
  AuthTokens,
  Profile,
  TokenSet,
  downloadsDir,
  loadConfig,
  loadTokens,
  parseMfaExpiry,
  saveTokens,
} from "./config.js";
import { GarminAuthError, apiHeaders, exchangeForOAuth2, fetchOAuthConsumer, refreshDiToken } from "./sso.js";
import { extractZip } from "./zip.js";

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type QueryValue = string | number | boolean;
/** Query parameters; an array value is sent as a repeated parameter (metricId=22&metricId=23). */
export type Query = Record<string, QueryValue | QueryValue[] | undefined>;

export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function assertDate(value: string, label = "date"): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new GarminError(`${label} must be in YYYY-MM-DD format (got "${value}").`);
  }
  return value;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function sportKey(sport: string): string {
  const key = sport.trim().toUpperCase();
  if (!/^[A-Z_]+$/.test(key)) throw new GarminError(`sport must contain only letters and underscores (got "${sport}").`);
  return key;
}

const NOT_CONNECTED =
  "No Garmin account is connected. Open a terminal in the project's garmin-mcp folder and run " +
  "`node dist/index.js auth` to sign in.";

/**
 * One refresh at a time per credential, shared across the GarminClient
 * instances that parallel tool calls create, so two calls landing inside the
 * expiry margin spend a single refresh token instead of racing each other.
 */
let inflightRefresh: { key: string; promise: Promise<TokenSet> } | undefined;

function refreshKey(auth: AuthTokens): string {
  return auth.method === "di" ? `di:${auth.di.refreshToken ?? auth.di.accessToken}` : `oauth1:${auth.oauth1.oauth_token}`;
}

function nearExpiry(auth: AuthTokens): boolean {
  const now = Date.now() / 1000;
  if (auth.method === "di") return Boolean(auth.di.expiresAt && now > auth.di.expiresAt - 900);
  return now > auth.oauth2.expires_at - 60;
}

function isNewer(candidate: AuthTokens, current: AuthTokens): boolean {
  if (candidate.method !== current.method) return false;
  if (candidate.method === "di" && current.method === "di") {
    return candidate.di.accessToken !== current.di.accessToken && (candidate.di.expiresAt ?? 0) > (current.di.expiresAt ?? 0);
  }
  if (candidate.method === "oauth1" && current.method === "oauth1") {
    return candidate.oauth2.access_token !== current.oauth2.access_token && candidate.oauth2.expires_at > current.oauth2.expires_at;
  }
  return false;
}

export class GarminClient {
  private constructor(
    private readonly config: AppConfig,
    private tokens: TokenSet,
  ) {}

  static load(): GarminClient {
    const config = loadConfig();
    const tokens = loadTokens();
    if (!tokens) throw new GarminError(NOT_CONNECTED);
    return new GarminClient({ ...config, domain: tokens.domain ?? config.domain }, tokens);
  }

  get domain(): string {
    return this.config.domain;
  }

  get tokenInfo(): TokenSet {
    return this.tokens;
  }

  // ---------------------------------------------------------------- auth

  private async refreshAuth(): Promise<void> {
    const key = refreshKey(this.tokens.auth);
    if (inflightRefresh?.key === key) {
      this.tokens = await inflightRefresh.promise;
      return;
    }
    const promise = this.performRefresh();
    inflightRefresh = { key, promise };
    try {
      this.tokens = await promise;
    } finally {
      if (inflightRefresh?.promise === promise) inflightRefresh = undefined;
    }
  }

  /** Obtains a fresh access token (DI refresh, or OAuth1 re-exchange), unless another process already did. */
  private async performRefresh(): Promise<TokenSet> {
    const stored = loadTokens();
    if (stored && isNewer(stored.auth, this.tokens.auth) && !nearExpiry(stored.auth)) return stored;

    const auth = this.tokens.auth;
    let next: TokenSet;
    try {
      if (auth.method === "di") {
        next = { ...this.tokens, auth: { method: "di", di: await refreshDiToken(this.config.domain, auth.di) } };
      } else {
        const mfaExpiry = parseMfaExpiry(auth.oauth1.mfa_expiration_timestamp);
        if (mfaExpiry !== undefined && Date.now() > mfaExpiry) {
          throw new GarminError(
            "The Garmin sign-in has expired (its MFA token lapsed). Run `node dist/index.js auth` from the garmin-mcp folder to sign in again.",
          );
        }
        let { consumerKey, consumerSecret } = this.config;
        if (!consumerKey || !consumerSecret) ({ consumerKey, consumerSecret } = await fetchOAuthConsumer());
        const oauth2 = await exchangeForOAuth2({ domain: this.config.domain, consumerKey, consumerSecret }, auth.oauth1);
        next = { ...this.tokens, auth: { ...auth, oauth2 } };
      }
    } catch (error) {
      if (error instanceof GarminError) throw error;
      throw new GarminError(
        error instanceof GarminAuthError
          ? error.message
          : `Could not refresh the Garmin sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    saveTokens(next);
    return next;
  }

  private async ensureAccessToken(): Promise<void> {
    if (nearExpiry(this.tokens.auth)) await this.refreshAuth();
  }

  // ------------------------------------------------------------ requests

  private buildUrl(path: string, query?: Query): URL {
    const clean = path.replace(/^\/+/, "");
    if (/^[a-z]+:\/\//i.test(path)) {
      throw new GarminError("Path must be relative to connectapi (e.g. /wellness-service/...), not a full URL.");
    }
    const url = new URL(`https://connectapi.${this.config.domain}/${clean}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async fetchRaw(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; form?: FormData; accept?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    await this.ensureAccessToken();
    const url = this.buildUrl(path, options.query);
    const doFetch = () => {
      const headers = { ...apiHeaders(this.tokens.auth), ...(options.headers ?? {}) };
      if (options.accept) headers.Accept = options.accept;
      if (this.config.domain === "garmin.cn") headers["di-backend"] = "connectapi.garmin.cn";
      let body: BodyInit | undefined;
      if (options.form) body = options.form;
      else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }
      return fetch(url, { method, headers, body });
    };
    let res = await doFetch();
    if (res.status === 401) {
      await res.arrayBuffer();
      await this.refreshAuth();
      res = await doFetch();
    }
    return res;
  }

  /** JSON (or text) request against connectapi. */
  async request(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const res = await this.fetchRaw(method, path, options);
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 429
          ? " Garmin is rate-limiting requests; wait a bit before retrying."
          : res.status === 403
            ? " Garmin refused the request. The endpoint may be unavailable for this account or the sign-in may need to be redone (`node dist/index.js auth`)."
            : "";
      throw new GarminError(`Garmin API error (${res.status} ${res.statusText}) for ${method} ${path}: ${text.slice(0, 2000)}${hint}`, res.status);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get(path: string, query?: Query, headers?: Record<string, string>): Promise<unknown> {
    return this.request("GET", path, { query, headers });
  }

  /** Binary download; returns the raw bytes plus the response content type. */
  async download(path: string, query?: Query): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.fetchRaw("GET", path, { query, accept: "*/*" });
    if (!res.ok) {
      const text = await res.text();
      throw new GarminError(`Garmin download failed (${res.status} ${res.statusText}) for ${path}: ${text.slice(0, 500)}`, res.status);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async tolerate404<T>(fn: () => Promise<unknown>, fallback: T): Promise<unknown> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GarminError && error.status === 404) return fallback;
      throw error;
    }
  }

  // -------------------------------------------------------------- profile

  async profile(): Promise<Profile> {
    if (this.tokens.profile?.displayName) return this.tokens.profile;
    // A brand-new profile can briefly lack a displayName; python-garminconnect
    // retries three times, then falls back to the login username.
    let social: Record<string, unknown> = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      social = ((await this.get("/userprofile-service/socialProfile")) ?? {}) as Record<string, unknown>;
      if (typeof social.displayName === "string" && social.displayName.trim()) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
    const displayName = (typeof social.displayName === "string" && social.displayName.trim()) || this.tokens.email;
    if (!displayName) throw new GarminError("Garmin did not return a displayName for this account.");
    const profile: Profile = {
      displayName,
      userName: social.userName as string | undefined,
      fullName: social.fullName as string | undefined,
      profileId: social.profileId as number | undefined,
      userProfileId: (social.profileId ?? social.userProfileId) as number | undefined,
    };
    this.tokens = { ...this.tokens, profile };
    saveTokens(this.tokens);
    return profile;
  }

  /** displayName as it goes into a URL path. */
  async displayName(): Promise<string> {
    return encodeURIComponent((await this.profile()).displayName);
  }

  private async profilePk(): Promise<number> {
    const profile = await this.profile();
    const pk = profile.profileId ?? profile.userProfileId;
    if (pk === undefined) throw new GarminError("Garmin did not return a profileId for this account.");
    return pk;
  }

  socialProfile(): Promise<unknown> {
    return this.get("/userprofile-service/socialProfile");
  }

  userSettings(): Promise<unknown> {
    return this.get("/userprofile-service/userprofile/user-settings");
  }

  profileSettings(): Promise<unknown> {
    return this.get("/userprofile-service/userprofile/settings");
  }

  heartRateZones(): Promise<unknown> {
    return this.get("/biometric-service/heartRateZones");
  }

  async powerZones(sport?: string): Promise<unknown> {
    if (!sport) return this.get("/biometric-service/powerZones/sports/all");
    return this.get(`/biometric-service/powerZones/sport/${sportKey(sport)}`);
  }

  // ---------------------------------------------------------- wellness/day

  async dailySummary(date: string): Promise<unknown> {
    return this.get(`/usersummary-service/usersummary/daily/${await this.displayName()}`, { calendarDate: date });
  }

  async sleep(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/dailySleepData/${await this.displayName()}`, {
      date,
      nonSleepBufferMinutes: 60,
    });
  }

  async heartRate(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/dailyHeartRate/${await this.displayName()}`, { date });
  }

  async restingHeartRate(start: string, end: string): Promise<unknown> {
    return this.get(`/userstats-service/wellness/daily/${await this.displayName()}`, {
      fromDate: start,
      untilDate: end,
      metricId: 60,
    });
  }

  /** Daily active + BMR calories (userstats metric ids 22 and 23), one row per day. */
  async caloriesRange(start: string, end: string): Promise<unknown> {
    const data = (await this.get(`/userstats-service/wellness/daily/${await this.displayName()}`, {
      fromDate: start,
      untilDate: end,
      metricId: [22, 23],
    })) as { allMetrics?: { metricsMap?: Record<string, { calendarDate?: string; value?: number }[]> } } | null;
    const map = data?.allMetrics?.metricsMap ?? {};
    const byDate = (key: string) => new Map((map[key] ?? []).filter((r) => r.calendarDate && r.value != null).map((r) => [r.calendarDate!, r.value!]));
    const active = byDate("WELLNESS_ACTIVE_CALORIES");
    const resting = byDate("WELLNESS_BMR_CALORIES");
    return [...new Set([...active.keys(), ...resting.keys()])].sort().map((calendarDate) => {
      const a = active.get(calendarDate);
      const r = resting.get(calendarDate);
      return { calendarDate, active: a ?? null, resting: r ?? null, total: (a ?? 0) + (r ?? 0) };
    });
  }

  stress(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/dailyStress/${date}`);
  }

  bodyBatteryEvents(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/bodyBattery/events/${date}`);
  }

  bodyBatteryReport(start: string, end: string): Promise<unknown> {
    return this.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: start, endDate: end });
  }

  hrv(date: string): Promise<unknown> {
    return this.get(`/hrv-service/hrv/${date}`);
  }

  spo2(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/daily/spo2/${date}`);
  }

  respiration(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/daily/respiration/${date}`);
  }

  intensityMinutes(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/daily/im/${date}`);
  }

  floors(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/floorsChartData/daily/${date}`);
  }

  hydration(date: string): Promise<unknown> {
    return this.get(`/usersummary-service/usersummary/hydration/daily/${date}`);
  }

  async stepsChart(date: string): Promise<unknown> {
    return this.get(`/wellness-service/wellness/dailySummaryChart/${await this.displayName()}`, { date });
  }

  dailyEvents(date: string): Promise<unknown> {
    return this.get("/wellness-service/wellness/dailyEvents", { calendarDate: date });
  }

  /** Activities plus all-day heart rate for one date, as the mobile app shows them. */
  activitiesForDate(date: string): Promise<unknown> {
    return this.get(`/mobile-gateway/heartRate/forDate/${date}`);
  }

  lifestyleLog(date: string): Promise<unknown> {
    return this.get(`/lifestylelogging-service/dailyLog/${date}`);
  }

  nutrition(kind: "foodLog" | "meals" | "settings", date: string): Promise<unknown> {
    const path = { foodLog: "/nutrition-service/food/logs", meals: "/nutrition-service/meals", settings: "/nutrition-service/settings" }[kind];
    return this.get(`${path}/${date}`);
  }

  weighIns(date: string): Promise<unknown> {
    return this.get(`/weight-service/weight/dayview/${date}`);
  }

  menstrualDay(date: string): Promise<unknown> {
    return this.get(`/periodichealth-service/menstrualcycle/dayview/${date}`);
  }

  menstrualSummary(date: string): Promise<unknown> {
    return this.get(`/periodichealth-service/menstrualcycle/summary/${date}`);
  }

  menstrualLastConfirmed(date: string): Promise<unknown> {
    return this.get(`/periodichealth-service/menstrualcycle/lastconfirmed/${date}`);
  }

  /** Multi-cycle report; Garmin accepts 1, 6 or 12 cycles. */
  menstrualReports(date: string, cycles: 1 | 6 | 12 = 6, reportType = "CYCLE"): Promise<unknown> {
    return this.get(`/periodichealth-service/reports/menstrualcycle/${cycles}/${date}`, { reportType, numberOfCycles: cycles });
  }

  pregnancySnapshot(): Promise<unknown> {
    return this.get("/periodichealth-service/menstrualcycle/pregnancysnapshot");
  }

  // ------------------------------------------------------------- training

  trainingReadiness(date: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/trainingreadiness/${date}`);
  }

  trainingStatus(date: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/trainingstatus/aggregated/${date}`);
  }

  dailyTrainingStatus(date: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/trainingstatus/daily/${date}`);
  }

  trainingLoadBalance(date: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/trainingloadbalance/latest/${date}`);
  }

  maxMetrics(start: string, end: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/maxmet/daily/${start}/${end}`);
  }

  async racePredictionsLatest(): Promise<unknown> {
    return this.get(`/metrics-service/metrics/racepredictions/latest/${await this.displayName()}`);
  }

  /** Garmin caps each request at one year; longer ranges are fetched in 366-day windows. */
  async racePredictionsRange(start: string, end: string, type: "daily" | "monthly" = "daily"): Promise<unknown> {
    const name = await this.displayName();
    return this.chunked(
      start,
      end,
      (s, e) => this.get(`/metrics-service/metrics/racepredictions/${type}/${name}`, { fromCalendarDate: s, toCalendarDate: e }),
      366,
    );
  }

  enduranceScore(date: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/endurancescore", { calendarDate: date });
  }

  enduranceScoreRange(start: string, end: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/endurancescore/stats", { startDate: start, endDate: end, aggregation: "weekly" });
  }

  hillScore(date: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/hillscore", { calendarDate: date });
  }

  hillScoreRange(start: string, end: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/hillscore/stats", { startDate: start, endDate: end, aggregation: "daily" });
  }

  runningTolerance(start: string, end: string, aggregation: "daily" | "weekly" = "weekly"): Promise<unknown> {
    return this.get("/metrics-service/metrics/runningtolerance/stats", { startDate: start, endDate: end, aggregation });
  }

  fitnessAge(date: string): Promise<unknown> {
    return this.get(`/fitnessage-service/fitnessage/${date}`);
  }

  /** Latest running lactate threshold (speed + HR) and running power-to-weight. */
  async lactateThresholdLatest(): Promise<unknown> {
    const [entries, power] = await Promise.all([
      this.get("/biometric-service/biometric/latestLactateThreshold") as Promise<Record<string, unknown>[] | null>,
      this.tolerate404(() => this.get(`/biometric-service/biometric/powerToWeight/latest/${todayLocal()}`, { sport: "Running" }), null),
    ]);
    // Garmin returns a list of near-identical entries; merge them like python-garminconnect does.
    const merged: Record<string, unknown> = { calendarDate: null, speed: null, heartRate: null, heartRateCycling: null };
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e.speed != null) {
        merged.calendarDate = e.calendarDate ?? merged.calendarDate;
        merged.speed = e.speed;
      }
      const hr = e.heartRate ?? e.hearRate; // Garmin's historical typo key
      if (hr != null) merged.heartRate = hr;
      if (e.heartRateCycling != null) merged.heartRateCycling = e.heartRateCycling;
    }
    return { ...merged, power, raw: entries };
  }

  lactateThresholdRange(start: string, end: string, aggregation: "daily" | "weekly" | "monthly" | "yearly" = "daily"): Promise<unknown> {
    const params = { sport: "RUNNING", aggregation, aggregationStrategy: "LATEST" };
    return Promise.all([
      this.get(`/biometric-service/stats/lactateThresholdSpeed/range/${start}/${end}`, params),
      this.get(`/biometric-service/stats/lactateThresholdHeartRate/range/${start}/${end}`, params),
    ]).then(([speed, heartRate]) => ({ speed, heartRate }));
  }

  ftpLatest(): Promise<unknown> {
    return this.get("/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING");
  }

  async ftpRange(start: string, end: string, sport = "CYCLING", aggregation: "daily" | "weekly" | "monthly" | "yearly" = "daily"): Promise<unknown> {
    return this.get(`/biometric-service/stats/functionalThresholdPower/range/${start}/${end}`, {
      sport: sportKey(sport),
      aggregation,
      aggregationStrategy: "LATEST",
    });
  }

  trainingPlans(): Promise<unknown> {
    return this.get("/trainingplan-service/trainingplan/plans");
  }

  trainingPlan(planId: string): Promise<unknown> {
    return this.get(`/trainingplan-service/trainingplan/phased/${encodeURIComponent(planId)}`);
  }

  // ------------------------------------------------------------ range stats

  /**
   * Garmin caps many range endpoints per call; fetch in windows and merge the
   * results into one list (or one wrapper object holding the merged list).
   */
  private async chunked(
    start: string,
    end: string,
    fetchChunk: (s: string, e: string) => Promise<unknown>,
    chunkDays = 28,
    dedupeKey?: (item: unknown) => string,
  ): Promise<unknown> {
    const total = daysBetween(start, end);
    if (total < 0) throw new GarminError("start must be on or before end.");
    if (total < chunkDays) return fetchChunk(start, end);

    const merged: unknown[] = [];
    let wrapperKey: string | undefined;
    for (let s = start; daysBetween(s, end) >= 0; s = addDays(s, chunkDays)) {
      const e = daysBetween(s, end) >= chunkDays - 1 ? addDays(s, chunkDays - 1) : end;
      const chunk = await fetchChunk(s, e);
      if (Array.isArray(chunk)) merged.push(...chunk);
      else if (chunk && typeof chunk === "object") {
        const entries = Object.entries(chunk as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
        if (entries.length === 1) {
          wrapperKey = entries[0][0];
          merged.push(...(entries[0][1] as unknown[]));
        } else merged.push(chunk);
      } else if (chunk !== null && chunk !== undefined) merged.push(chunk);
    }
    let items = merged;
    if (dedupeKey) {
      const seen = new Set<string>();
      items = merged.filter((item) => {
        const k = dedupeKey(item);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return wrapperKey ? { [wrapperKey]: items } : items;
  }

  stepsRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/usersummary-service/stats/steps/daily/${s}/${e}`));
  }

  stressRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/usersummary-service/stats/stress/daily/${s}/${e}`));
  }

  intensityMinutesRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/usersummary-service/stats/im/daily/${s}/${e}`));
  }

  hydrationRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/usersummary-service/stats/hydration/daily/${s}/${e}`));
  }

  /** Nightly sleep summaries (score, sub-scores, durations) from the sleep-service stats endpoint. */
  async sleepRange(start: string, end: string): Promise<unknown> {
    if (daysBetween(start, end) < 0) throw new GarminError("start must be on or before end.");
    const byDate = new Map<string, unknown>();
    for (let s = start; daysBetween(s, end) >= 0; s = addDays(s, 28)) {
      const e = daysBetween(s, end) >= 27 ? addDays(s, 27) : end;
      const data = (await this.get(`/sleep-service/stats/sleep/daily/${s}/${e}`)) as { individualStats?: { calendarDate?: string }[] } | null;
      for (const row of data?.individualStats ?? []) {
        if (row?.calendarDate && !byDate.has(row.calendarDate)) byDate.set(row.calendarDate, row);
      }
    }
    return [...byDate.keys()].sort().map((k) => byDate.get(k));
  }

  hrvRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/hrv-service/hrv/daily/${s}/${e}`));
  }

  weightRange(start: string, end: string): Promise<unknown> {
    return this.get("/weight-service/weight/dateRange", { startDate: start, endDate: end });
  }

  bloodPressureRange(start: string, end: string): Promise<unknown> {
    return this.get(`/bloodpressure-service/bloodpressure/range/${start}/${end}`, { includeAll: true });
  }

  /** Garmin rejects calendar windows of 92+ days; fetched in 90-day windows, de-duplicated. */
  menstrualCalendar(start: string, end: string): Promise<unknown> {
    return this.chunked(
      start,
      end,
      (s, e) => this.get(`/periodichealth-service/menstrualcycle/calendar/${s}/${e}`),
      90,
      (item) => {
        const o = (item ?? {}) as Record<string, unknown>;
        return String(o.cycleId ?? o.id ?? o.startDate ?? JSON.stringify(item));
      },
    );
  }

  stepsWeekly(end: string, weeks: number): Promise<unknown> {
    return this.get(`/usersummary-service/stats/steps/weekly/${end}/${weeks}`);
  }

  stressWeekly(end: string, weeks: number): Promise<unknown> {
    return this.get(`/usersummary-service/stats/stress/weekly/${end}/${weeks}`);
  }

  intensityMinutesWeekly(start: string, end: string): Promise<unknown> {
    return this.get(`/usersummary-service/stats/im/weekly/${start}/${end}`);
  }

  // ------------------------------------------------------------ activities

  activities(params: {
    start?: number;
    limit?: number;
    activityType?: string;
    activitySubType?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    sortOrder?: "asc" | "desc";
  }): Promise<unknown> {
    return this.get("/activitylist-service/activities/search/activities", {
      start: params.start ?? 0,
      limit: params.limit ?? 20,
      activityType: params.activityType,
      activitySubType: params.activityType ? params.activitySubType : undefined,
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      sortOrder: params.sortOrder,
    });
  }

  activityCount(): Promise<unknown> {
    return this.get("/activitylist-service/activities/count");
  }

  activityTypes(): Promise<unknown> {
    return this.get("/activity-service/activity/activityTypes");
  }

  activity(id: string): Promise<unknown> {
    return this.get(`/activity-service/activity/${encodeURIComponent(id)}`);
  }

  activityDetails(id: string, maxChartSize: number, maxPolylineSize: number): Promise<unknown> {
    return this.get(`/activity-service/activity/${encodeURIComponent(id)}/details`, { maxChartSize, maxPolylineSize });
  }

  activitySection(id: string, section: string): Promise<unknown> {
    const map: Record<string, string> = {
      splits: "splits",
      typedSplits: "typedsplits",
      splitSummaries: "split_summaries",
      weather: "weather",
      hrZones: "hrTimeInZones",
      powerZones: "powerTimeInZones",
      exerciseSets: "exerciseSets",
    };
    const suffix = map[section];
    if (!suffix) throw new GarminError(`Unknown activity section "${section}".`);
    return this.get(`/activity-service/activity/${encodeURIComponent(id)}/${suffix}`);
  }

  activityGear(id: string): Promise<unknown> {
    return this.get("/gear-service/gear/filterGear", { activityId: id });
  }

  async updateActivity(id: string, changes: Record<string, unknown>): Promise<unknown> {
    const body: Record<string, unknown> = { activityId: Number(id), ...changes };
    const typeDto = body.activityTypeDTO as { typeKey?: string; typeId?: number } | undefined;
    if (typeDto?.typeKey && typeDto.typeId === undefined) {
      const types = (await this.activityTypes()) as { typeKey: string; typeId: number; parentTypeId?: number }[];
      const match = Array.isArray(types) ? types.find((t) => t.typeKey === typeDto.typeKey) : undefined;
      if (!match) throw new GarminError(`Unknown activity type key "${typeDto.typeKey}". See garmin_activity_types.`);
      body.activityTypeDTO = { typeId: match.typeId, typeKey: match.typeKey, parentTypeId: match.parentTypeId };
    }
    return this.request("PUT", `/activity-service/activity/${encodeURIComponent(id)}`, { body });
  }

  async downloadActivity(
    id: string,
    format: "fit" | "tcx" | "gpx" | "kml" | "csv",
    outputPath?: string,
  ): Promise<{ savedTo: string; bytes: number; format: string }[]> {
    const path =
      format === "fit"
        ? `/download-service/files/activity/${encodeURIComponent(id)}`
        : `/download-service/export/${format}/activity/${encodeURIComponent(id)}`;
    const { bytes } = await this.download(path);
    return saveDownload(bytes, format === "fit" ? { zipped: true, baseName: id, fallbackExt: "fit" } : { baseName: id, ext: format }, outputPath);
  }

  /** Health Snapshot (the watch's 2-minute spot check) files for a date; Garmin serves a zip of FIT files. */
  async downloadHealthSnapshot(date: string, outputPath?: string): Promise<{ savedTo: string; bytes: number; format: string }[]> {
    const { bytes } = await this.download(`/download-service/files/wellness/${date}`);
    return saveDownload(bytes, { zipped: true, baseName: `health-snapshot-${date}`, fallbackExt: "fit" }, outputPath);
  }

  fitnessStats(params: {
    startDate: string;
    endDate: string;
    metric: string;
    aggregation: string;
    groupByActivityType: boolean;
    activityType?: string;
  }): Promise<unknown> {
    return this.get("/fitnessstats-service/activity", {
      startDate: params.startDate,
      endDate: params.endDate,
      aggregation: params.aggregation,
      groupByParentActivityType: params.groupByActivityType,
      metric: params.metric,
      activityType: params.activityType,
    });
  }

  /** Per-activity training load and training-effect labels over a range. */
  trainingLoadActivities(start: string, end: string, activityType?: string): Promise<unknown> {
    return this.get("/fitnessstats-service/activity/all", {
      startDate: start,
      endDate: end,
      metric: ["activityTrainingLoad", "trainingEffectLabel", "trainingEffectLabelSrvrCalc"],
      activityType,
    });
  }

  // ------------------------------------------------ records/badges/goals

  async personalRecords(): Promise<unknown> {
    return this.get(`/personalrecord-service/personalrecord/prs/${await this.displayName()}`);
  }

  badges(kind: string, start?: number, limit?: number): Promise<unknown> {
    const map: Record<string, string> = {
      earned: "/badge-service/badge/earned",
      available: "/badge-service/badge/available",
      availableChallenges: "/badgechallenge-service/badgeChallenge/available",
      completedChallenges: "/badgechallenge-service/badgeChallenge/completed",
      nonCompletedChallenges: "/badgechallenge-service/badgeChallenge/non-completed",
      inProgressVirtualChallenges: "/badgechallenge-service/virtualChallenge/inProgress",
      adHocChallenges: "/adhocchallenge-service/adHocChallenge/historical",
    };
    const path = map[kind];
    if (!path) throw new GarminError(`Unknown badge kind "${kind}".`);
    if (kind === "earned") return this.get(path);
    if (kind === "available") return this.get(path, { showExclusiveBadge: true });
    // badgechallenge-service pages are 1-based; adHocChallenge is 0-based.
    const firstPage = kind === "adHocChallenges" ? 0 : 1;
    return this.get(path, { start: start ?? firstPage, limit: limit ?? 100 });
  }

  goals(status: string, start: number, limit: number): Promise<unknown> {
    // goal-service omits newer goal types unless this fetch-metadata header is present.
    return this.get("/goal-service/goal/goals", { status, start, limit, sortOrder: "asc" }, { "Sec-Fetch-Site": "same-origin" });
  }

  // ---------------------------------------------------------- gear/devices

  async gearList(): Promise<unknown> {
    return this.get("/gear-service/gear/filterGear", { userProfilePk: await this.profilePk() });
  }

  /** Empty object when the gear was retired/removed (Garmin answers 404). */
  gearStats(gearUuid: string): Promise<unknown> {
    return this.tolerate404(() => this.get(`/gear-service/gear/stats/${encodeURIComponent(gearUuid)}`), {});
  }

  gearActivities(gearUuid: string, start: number, limit: number): Promise<unknown> {
    return this.tolerate404(() => this.get(`/activitylist-service/activities/${encodeURIComponent(gearUuid)}/gear`, { start, limit }), []);
  }

  async gearDefaults(): Promise<unknown> {
    return this.get(`/gear-service/gear/user/${await this.profilePk()}/activityTypes`);
  }

  devices(): Promise<unknown> {
    return this.get("/device-service/deviceregistration/devices");
  }

  deviceLastUsed(): Promise<unknown> {
    return this.get("/device-service/deviceservice/mylastused");
  }

  deviceSettings(deviceId: string): Promise<unknown> {
    return this.get(`/device-service/deviceservice/device-info/settings/${encodeURIComponent(deviceId)}`);
  }

  primaryTrainingDevice(): Promise<unknown> {
    return this.get("/web-gateway/device-info/primary-training-device");
  }

  async deviceSolar(deviceId: string, start: string, end: string): Promise<unknown> {
    const data = (await this.get(`/web-gateway/solar/${encodeURIComponent(deviceId)}/${start}/${end}`, {
      singleDayView: start === end,
    })) as { deviceSolarInput?: unknown } | null;
    return data?.deviceSolarInput ?? data;
  }

  // -------------------------------------------------------------- workouts

  workouts(start: number, limit: number): Promise<unknown> {
    return this.get("/workout-service/workouts", { start, limit });
  }

  workout(id: string): Promise<unknown> {
    return this.get(`/workout-service/workout/${encodeURIComponent(id)}`);
  }

  async downloadWorkout(id: string, outputPath?: string): Promise<{ savedTo: string; bytes: number }> {
    const { bytes } = await this.download(`/workout-service/workout/FIT/${encodeURIComponent(id)}`);
    const [saved] = await saveDownload(bytes, { baseName: `workout-${id}`, ext: "fit" }, outputPath);
    return { savedTo: saved!.savedTo, bytes: saved!.bytes };
  }

  /** Calendar view for a month: scheduled workouts, activities and events (Garmin's month index is zero-based). */
  scheduledWorkouts(year: number, month: number): Promise<unknown> {
    return this.get(`/calendar-service/year/${year}/month/${month - 1}`);
  }

  scheduledWorkout(scheduledWorkoutId: string): Promise<unknown> {
    return this.get(`/workout-service/schedule/${encodeURIComponent(scheduledWorkoutId)}`);
  }

  // ------------------------------------------------------------------ golf

  golfSummary(start: number, limit: number): Promise<unknown> {
    return this.get("/gcs-golfcommunity/api/v2/scorecard/summary", { "per-page": limit, start });
  }

  golfScorecard(scorecardId: string): Promise<unknown> {
    return this.get("/gcs-golfcommunity/api/v2/scorecard/detail", { "scorecard-ids": scorecardId, "include-longest-shot-distance": true });
  }

  golfShots(scorecardId: string, holeNumbers?: string): Promise<unknown> {
    const query: Query = {};
    // Garmin only filters single-digit holes reliably; ask for all holes otherwise.
    if (holeNumbers && !/\d{2}/.test(holeNumbers)) query["hole-numbers"] = holeNumbers.replace(/,/g, "-");
    return this.get(`/gcs-golfcommunity/api/v2/shot/scorecard/${encodeURIComponent(scorecardId)}/hole`, query);
  }

  golfClubStats(limit: number): Promise<unknown> {
    return this.get("/gcs-golfcommunity/api/v2/club/player", { "per-page": limit, "include-stats": true });
  }

  golfPlayerStats(): Promise<unknown> {
    return this.get("/gcs-golfcommunity/api/v2/player/stats");
  }

  // ---------------------------------------------------------------- writes

  logWeight(params: { weight: number; unit?: "kg" | "lbs"; date?: string; time?: string }): Promise<unknown> {
    const date = params.date ?? todayLocal();
    const time = params.time ?? new Date().toTimeString().slice(0, 8);
    const { local, gmt } = manualEntryTimestamps(date, time);
    return this.request("POST", "/weight-service/user-weight", {
      body: { dateTimestamp: local, gmtTimestamp: gmt, unitKey: params.unit ?? "kg", sourceType: "MANUAL", value: params.weight },
    });
  }

  logBloodPressure(params: {
    systolic: number;
    diastolic: number;
    pulse?: number;
    date?: string;
    time?: string;
    notes?: string;
  }): Promise<unknown> {
    const date = params.date ?? todayLocal();
    const time = params.time ?? new Date().toTimeString().slice(0, 8);
    const { local, gmt } = manualEntryTimestamps(date, time);
    return this.request("POST", "/bloodpressure-service/bloodpressure", {
      body: {
        measurementTimestampLocal: local,
        measurementTimestampGMT: gmt,
        systolic: params.systolic,
        diastolic: params.diastolic,
        ...(params.pulse !== undefined ? { pulse: params.pulse } : {}),
        sourceType: "MANUAL",
        notes: params.notes ?? "",
      },
    });
  }

  /** The timestamp's date must equal calendarDate; a back-dated entry without a time is logged at local midnight. */
  logHydration(params: { valueInMl: number; date?: string; time?: string }): Promise<unknown> {
    const date = params.date ?? todayLocal();
    const time = params.time ?? (date === todayLocal() ? new Date().toTimeString().slice(0, 8) : "00:00:00");
    return this.request("PUT", "/usersummary-service/usersummary/hydration/log", {
      body: { calendarDate: date, valueInML: params.valueInMl, timestampLocal: manualEntryTimestamps(date, time).local },
    });
  }

  requestReload(date: string): Promise<unknown> {
    return this.request("POST", `/wellness-service/wellness/epoch/request/${date}`);
  }
}

// ---------------------------------------------------------------- helpers

/** Garmin's manual-entry timestamp pair: local wall clock and the same instant in GMT, both "YYYY-MM-DDTHH:mm:ss.SSS". */
function manualEntryTimestamps(date: string, time: string): { local: string; gmt: string } {
  const instant = new Date(`${date}T${time}`);
  if (Number.isNaN(instant.getTime())) throw new GarminError(`Invalid date/time: ${date} ${time}`);
  return {
    local: `${date}T${time}.000`,
    gmt: instant.toISOString().slice(0, 19) + ".000",
  };
}

function isDirectoryPath(p: string): boolean {
  if (p.endsWith("/") || p.endsWith("\\")) return true;
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveTargetDir(outputPath?: string): string {
  let dir: string;
  if (!outputPath) dir = downloadsDir;
  else if (isDirectoryPath(outputPath)) dir = resolve(outputPath);
  else dir = resolve(outputPath, "..");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a download (unpacking a zip when asked) to the downloads dir or the given file/directory. */
async function saveDownload(
  bytes: Buffer,
  naming: { baseName: string; ext?: string; zipped?: boolean; fallbackExt?: string },
  outputPath?: string,
): Promise<{ savedTo: string; bytes: number; format: string }[]> {
  const files: { name: string; data: Buffer }[] = [];
  if (naming.zipped) {
    try {
      for (const entry of extractZip(bytes)) {
        const ext = extname(entry.name) || `.${naming.fallbackExt ?? "bin"}`;
        files.push({ name: `${naming.baseName}${files.length ? `-${files.length + 1}` : ""}${ext}`, data: entry.data });
      }
    } catch {
      files.push({ name: `${naming.baseName}.zip`, data: bytes });
    }
    if (files.length === 0) files.push({ name: `${naming.baseName}.zip`, data: bytes });
  } else {
    files.push({ name: `${naming.baseName}.${naming.ext ?? "bin"}`, data: bytes });
  }
  const targetDir = resolveTargetDir(outputPath);
  const explicitFile = outputPath && !isDirectoryPath(outputPath) && files.length === 1;
  return files.map((file) => {
    const savedTo = explicitFile ? resolve(outputPath!) : join(targetDir, file.name);
    writeFileSync(savedTo, file.data);
    return { savedTo, bytes: file.data.length, format: extname(savedTo).slice(1) || "bin" };
  });
}

/** Trims an activity summary down to the fields most useful in conversation. */
export function summarizeActivity(activity: Record<string, unknown>): Record<string, unknown> {
  const type = activity.activityType as Record<string, unknown> | undefined;
  const pick: Record<string, unknown> = {
    activityId: activity.activityId,
    activityName: activity.activityName,
    activityType: type?.typeKey,
    startTimeLocal: activity.startTimeLocal,
    locationName: activity.locationName,
    distanceMeters: activity.distance,
    durationSeconds: activity.duration,
    movingDurationSeconds: activity.movingDuration,
    elapsedDurationSeconds: activity.elapsedDuration,
    elevationGainMeters: activity.elevationGain,
    elevationLossMeters: activity.elevationLoss,
    averageSpeedMps: activity.averageSpeed,
    maxSpeedMps: activity.maxSpeed,
    averageHR: activity.averageHR,
    maxHR: activity.maxHR,
    calories: activity.calories,
    steps: activity.steps,
    averageRunningCadenceInStepsPerMinute: activity.averageRunningCadenceInStepsPerMinute,
    averageBikingCadenceInRevPerMinute: activity.averageBikingCadenceInRevPerMinute,
    avgPower: activity.avgPower,
    normPower: activity.normPower,
    trainingStressScore: activity.trainingStressScore,
    intensityFactor: activity.intensityFactor,
    aerobicTrainingEffect: activity.aerobicTrainingEffect,
    anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
    trainingEffectLabel: activity.trainingEffectLabel,
    activityTrainingLoad: activity.activityTrainingLoad,
    vO2MaxValue: activity.vO2MaxValue,
    avgStrideLength: activity.avgStrideLength,
    avgVerticalOscillation: activity.avgVerticalOscillation,
    avgGroundContactTime: activity.avgGroundContactTime,
    minTemperature: activity.minTemperature,
    maxTemperature: activity.maxTemperature,
    waterEstimated: activity.waterEstimated,
    lapCount: activity.lapCount,
    hasPolyline: activity.hasPolyline,
    deviceId: activity.deviceId,
    manufacturer: activity.manufacturer,
    description: activity.description,
  };
  for (const key of Object.keys(pick)) if (pick[key] === undefined || pick[key] === null) delete pick[key];
  return pick;
}
