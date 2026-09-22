import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  AppConfig,
  Profile,
  TokenSet,
  downloadsDir,
  loadConfig,
  loadTokens,
  saveTokens,
} from "./config.js";
import { exchangeForOAuth2 } from "./sso.js";
import { extractZip } from "./zip.js";

export class GarminError extends Error {}

const UA_API = "GCM-iOS-5.7.2.1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Query = Record<string, string | number | boolean | undefined>;

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

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

const NOT_CONNECTED =
  "No Garmin account is connected. Open a terminal in the project's garmin-mcp folder and run " +
  "`node dist/index.js auth` to sign in.";

export class GarminClient {
  private constructor(
    private readonly config: AppConfig,
    private tokens: TokenSet,
  ) {}

  static load(): GarminClient {
    const config = loadConfig();
    const tokens = loadTokens();
    if (!config || !tokens) throw new GarminError(NOT_CONNECTED);
    return new GarminClient({ ...config, domain: tokens.domain ?? config.domain }, tokens);
  }

  get domain(): string {
    return this.config.domain;
  }

  get tokenInfo(): TokenSet {
    return this.tokens;
  }

  // ---------------------------------------------------------------- auth

  private async refreshOAuth2(): Promise<void> {
    const mfaExpiry = Number(this.tokens.oauth1.mfa_expiration_timestamp);
    if (mfaExpiry && Date.now() / 1000 > mfaExpiry) {
      throw new GarminError(
        "The Garmin sign-in has expired (its MFA token lapsed). Run `node dist/index.js auth` from the garmin-mcp folder to sign in again.",
      );
    }
    try {
      this.tokens = { ...this.tokens, oauth2: await exchangeForOAuth2(this.config, this.tokens.oauth1) };
    } catch (error) {
      throw new GarminError(error instanceof Error ? error.message : String(error));
    }
    saveTokens(this.tokens);
  }

  private async ensureAccessToken(): Promise<void> {
    if (Date.now() / 1000 > this.tokens.oauth2.expires_at - 60) await this.refreshOAuth2();
  }

  // ------------------------------------------------------------ requests

  private buildUrl(path: string, query?: Query): URL {
    const clean = path.replace(/^\/+/, "");
    if (/^[a-z]+:\/\//i.test(path)) {
      throw new GarminError("Path must be relative to connectapi (e.g. /wellness-service/...), not a full URL.");
    }
    const url = new URL(`https://connectapi.${this.config.domain}/${clean}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async fetchRaw(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; form?: FormData } = {},
  ): Promise<Response> {
    await this.ensureAccessToken();
    const url = this.buildUrl(path, options.query);
    const doFetch = () => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.tokens.oauth2.access_token}`,
        "User-Agent": UA_API,
        Accept: "application/json, text/plain, */*",
      };
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
      await this.refreshOAuth2();
      res = await doFetch();
    }
    return res;
  }

  /** JSON (or text) request against connectapi. */
  async request(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; form?: FormData } = {},
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
      throw new GarminError(`Garmin API error (${res.status} ${res.statusText}) for ${method} ${path}: ${text.slice(0, 2000)}${hint}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  /** Binary download; returns the raw bytes plus the response content type. */
  async download(path: string, query?: Query): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.fetchRaw("GET", path, { query });
    if (!res.ok) {
      const text = await res.text();
      throw new GarminError(`Garmin download failed (${res.status} ${res.statusText}) for ${path}: ${text.slice(0, 500)}`);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  // -------------------------------------------------------------- profile

  async profile(): Promise<Profile> {
    if (this.tokens.profile?.displayName) return this.tokens.profile;
    const social = (await this.get("/userprofile-service/socialProfile")) as Record<string, unknown>;
    const profile: Profile = {
      displayName: String(social.displayName ?? ""),
      userName: social.userName as string | undefined,
      fullName: social.fullName as string | undefined,
      profileId: social.profileId as number | undefined,
      userProfileId: (social.id ?? social.profileId ?? social.userProfileId) as number | undefined,
    };
    if (!profile.displayName) throw new GarminError("Garmin did not return a displayName for this account.");
    this.tokens = { ...this.tokens, profile };
    saveTokens(this.tokens);
    return profile;
  }

  async displayName(): Promise<string> {
    return (await this.profile()).displayName;
  }

  async socialProfile(): Promise<unknown> {
    return this.get("/userprofile-service/socialProfile");
  }

  userSettings(): Promise<unknown> {
    return this.get("/userprofile-service/userprofile/user-settings");
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

  weighIns(date: string): Promise<unknown> {
    return this.get(`/weight-service/weight/dayview/${date}`);
  }

  menstrualDay(date: string): Promise<unknown> {
    return this.get(`/periodichealth-service/menstrualcycle/dayview/${date}`);
  }

  pregnancySnapshot(): Promise<unknown> {
    return this.get("/periodichealth-service/menstrualcycle/pregnancysnapshot");
  }

  // ------------------------------------------------------------- training

  trainingReadiness(date: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/trainingreadiness/${date}`);
  }

  trainingStatus(date: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/trainingstatus/aggregated", { date });
  }

  maxMetrics(start: string, end: string): Promise<unknown> {
    return this.get(`/metrics-service/metrics/maxmet/daily/${start}/${end}`);
  }

  async racePredictionsLatest(): Promise<unknown> {
    return this.get(`/metrics-service/metrics/racepredictions/latest/${await this.displayName()}`);
  }

  async racePredictionsRange(start: string, end: string, type: "daily" | "monthly" = "daily"): Promise<unknown> {
    return this.get(`/metrics-service/metrics/racepredictions/${type}/${await this.displayName()}`, {
      fromCalendarDate: start,
      toCalendarDate: end,
    });
  }

  enduranceScore(date: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/endurancescore", { calendarDate: date });
  }

  enduranceScoreRange(start: string, end: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/endurancescore/stats", {
      startDate: start,
      endDate: end,
      aggregation: "weekly",
    });
  }

  hillScore(date: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/hillscore", { calendarDate: date });
  }

  hillScoreRange(start: string, end: string): Promise<unknown> {
    return this.get("/metrics-service/metrics/hillscore/stats", {
      startDate: start,
      endDate: end,
      aggregation: "daily",
    });
  }

  fitnessAge(date: string): Promise<unknown> {
    return this.get(`/fitnessage-service/fitnessage/${date}`);
  }

  // ------------------------------------------------------------ range stats

  /**
   * Garmin caps the daily "stats" endpoints at 28 days per call; fetch in
   * chunks and merge the results into one list.
   */
  private async chunked(
    start: string,
    end: string,
    fetchChunk: (s: string, e: string) => Promise<unknown>,
    chunkDays = 28,
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
    return wrapperKey ? { [wrapperKey]: merged } : merged;
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

  sleepScoreRange(start: string, end: string): Promise<unknown> {
    return this.chunked(start, end, (s, e) => this.get(`/wellness-service/stats/daily/sleep/score/${s}/${e}`));
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

  menstrualCalendar(start: string, end: string): Promise<unknown> {
    return this.get(`/periodichealth-service/menstrualcycle/calendar/${start}/${end}`);
  }

  // ------------------------------------------------------------ activities

  activities(params: {
    start?: number;
    limit?: number;
    activityType?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }): Promise<unknown> {
    return this.get("/activitylist-service/activities/search/activities", {
      start: params.start ?? 0,
      limit: params.limit ?? 20,
      activityType: params.activityType,
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
    });
  }

  activityTypes(): Promise<unknown> {
    return this.get("/activity-service/activity/activityTypes");
  }

  activity(id: string): Promise<unknown> {
    return this.get(`/activity-service/activity/${encodeURIComponent(id)}`);
  }

  activityDetails(id: string, maxChartSize: number, maxPolylineSize: number): Promise<unknown> {
    return this.get(`/activity-service/activity/${encodeURIComponent(id)}/details`, {
      maxChartSize,
      maxPolylineSize,
    });
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

    const targetDir = resolveTargetDir(outputPath);
    const files: { name: string; data: Buffer }[] = [];
    if (format === "fit") {
      try {
        for (const entry of extractZip(bytes)) {
          const ext = extname(entry.name) || ".fit";
          files.push({ name: `${id}${ext}`, data: entry.data });
        }
      } catch {
        files.push({ name: `${id}.zip`, data: bytes });
      }
      if (files.length === 0) files.push({ name: `${id}.zip`, data: bytes });
    } else {
      files.push({ name: `${id}.${format}`, data: bytes });
    }

    const explicitFile = outputPath && !isDirectoryPath(outputPath) && files.length === 1;
    return files.map((file) => {
      const savedTo = explicitFile ? resolve(outputPath!) : join(targetDir, file.name);
      writeFileSync(savedTo, file.data);
      return { savedTo, bytes: file.data.length, format: extname(savedTo).slice(1) || format };
    });
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

  // ------------------------------------------------ records/badges/goals

  async personalRecords(): Promise<unknown> {
    return this.get(`/personalrecord-service/personalrecord/prs/${await this.displayName()}`);
  }

  badges(kind: string): Promise<unknown> {
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
    return this.get(path);
  }

  goals(status: string, start: number, limit: number): Promise<unknown> {
    return this.get("/goal-service/goal/goals", { status, start, limit, sortOrder: "asc" });
  }

  // ---------------------------------------------------------- gear/devices

  async gearList(): Promise<unknown> {
    const profile = await this.profile();
    const pk = profile.userProfileId ?? profile.profileId;
    if (pk === undefined) {
      const social = (await this.socialProfile()) as Record<string, unknown>;
      return this.get("/gear-service/gear/filterGear", { userProfilePk: String(social.userProfileId ?? social.id) });
    }
    return this.get("/gear-service/gear/filterGear", { userProfilePk: pk });
  }

  gearStats(gearUuid: string): Promise<unknown> {
    return this.get(`/gear-service/gear/stats/${encodeURIComponent(gearUuid)}`);
  }

  gearActivities(gearUuid: string, start: number, limit: number): Promise<unknown> {
    return this.get(`/activitylist-service/activities/${encodeURIComponent(gearUuid)}/gear`, { start, limit });
  }

  async gearDefaults(): Promise<unknown> {
    const profile = await this.profile();
    const pk = profile.userProfileId ?? profile.profileId;
    return this.get(`/gear-service/gear/user/${pk}/activityTypes`);
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

  deviceSolar(deviceId: string, start: string, end: string): Promise<unknown> {
    return this.get(`/web-gateway/solar/${encodeURIComponent(deviceId)}/${start}/${end}`);
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
    const savedTo =
      outputPath && !isDirectoryPath(outputPath)
        ? resolve(outputPath)
        : join(resolveTargetDir(outputPath), `workout-${id}.fit`);
    writeFileSync(savedTo, bytes);
    return { savedTo, bytes: bytes.length };
  }

  // ---------------------------------------------------------------- writes

  logWeight(params: { weightKg: number; date?: string; time?: string }): Promise<unknown> {
    const date = params.date ?? todayLocal();
    const time = params.time ?? new Date().toTimeString().slice(0, 8);
    const { local, gmt } = manualEntryTimestamps(date, time);
    return this.request("POST", "/weight-service/user-weight", {
      body: {
        dateTimestampLocal: local,
        gmtTimestampLocal: gmt,
        unitKey: "kg",
        sourceType: "MANUAL",
        value: params.weightKg,
      },
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
        pulse: params.pulse,
        sourceType: "MANUAL",
        notes: params.notes,
      },
    });
  }

  async logHydration(params: { valueInMl: number; date?: string }): Promise<unknown> {
    const date = params.date ?? todayLocal();
    return this.request("PUT", "/usersummary-service/usersummary/hydration/log", {
      body: {
        calendarDate: date,
        valueInML: params.valueInMl,
        timestampLocal: localTimestamp(),
      },
    });
  }

  requestReload(date: string): Promise<unknown> {
    return this.request("POST", `/wellness-service/wellness/epoch/request/${date}`);
  }
}

// ---------------------------------------------------------------- helpers

/** Local wall-clock time as YYYY-MM-DDTHH:mm:ss.SSS (what Garmin's app sends). */
function localTimestamp(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** Garmin's manual-entry timestamp pair: local wall clock and the same instant in GMT, both "YYYY-MM-DDTHH:mm:ss.00". */
function manualEntryTimestamps(date: string, time: string): { local: string; gmt: string } {
  const instant = new Date(`${date}T${time}`);
  if (Number.isNaN(instant.getTime())) throw new GarminError(`Invalid date/time: ${date} ${time}`);
  return {
    local: `${date}T${time}.00`,
    gmt: instant.toISOString().slice(0, 19) + ".00",
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
