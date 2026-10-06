import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadTokens } from "./config.js";
import { GarminClient, GarminError, assertDate, daysBetween, summarizeActivity, todayLocal } from "./garmin.js";
import { GarminAuthError, domainLabel } from "./sso.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const PRETTY_LIMIT = 60_000;

function ok(value: unknown): ToolResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  const compact = JSON.stringify(value) ?? "null";
  const text = compact.length > PRETTY_LIMIT ? compact : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

function run(handler: () => Promise<unknown>): Promise<ToolResult> {
  return Promise.resolve()
    .then(handler)
    .then(ok, (error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text:
          error instanceof GarminError || error instanceof GarminAuthError
            ? error.message
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  }));
}

/** Runs several requests and reports each one's result or error instead of failing the whole call. */
async function settled<T extends Record<string, Promise<unknown>>>(requests: T): Promise<Record<keyof T, unknown>> {
  const keys = Object.keys(requests) as (keyof T)[];
  const results = await Promise.allSettled(keys.map((k) => requests[k]));
  const out = {} as Record<keyof T, unknown>;
  keys.forEach((k, i) => {
    const r = results[i]!;
    out[k] = r.status === "fulfilled" ? r.value : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  });
  return out;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const dateField = DATE.optional().describe("Calendar date, YYYY-MM-DD (the user's local date). Defaults to today.");
const startField = DATE.describe("Start date, YYYY-MM-DD (inclusive)");
const endField = DATE.optional().describe("End date, YYYY-MM-DD (inclusive). Defaults to today.");
const timeField = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().describe("Local time HH:MM[:SS] (default now)");
const outputPathField = z.string().optional().describe("Destination file path or directory (default ~/.garmin-mcp/downloads/)");
const activityIdField = z.string().describe("Garmin activity ID (the number in the activity's Connect URL, or activityId from garmin_activities)");

function day(date?: string): string {
  return assertDate(date ?? todayLocal());
}

function range(start: string, end?: string): [string, string] {
  const s = assertDate(start, "start");
  const e = assertDate(end ?? todayLocal(), "end");
  if (s > e) throw new GarminError("start must be on or before end.");
  return [s, e];
}

function normalizeTime(time?: string): string | undefined {
  return time && time.length === 5 ? `${time}:00` : time;
}

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "garmin-mcp", version: "0.2.0" });
  const client = () => GarminClient.load();

  // ----------------------------------------------------------- connection

  server.registerTool(
    "garmin_auth_status",
    {
      title: "Garmin connection status",
      description: "Show whether a Garmin Connect account is signed in, which account, and how the sign-in is kept alive.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const tokens = loadTokens();
        if (!tokens) {
          return { connected: false, reason: "In a terminal, run `node dist/index.js auth` from the project's garmin-mcp folder to sign in." };
        }
        const auth = tokens.auth;
        return {
          connected: true,
          region: domainLabel(tokens.domain),
          email: tokens.email,
          profile: tokens.profile,
          signedInAt: new Date(tokens.createdAt).toISOString(),
          tokenMethod: auth.method === "di" ? "DI bearer token (auto-refreshes)" : "OAuth1 token (auto-renews for about a year)",
          accessTokenExpiresAt:
            auth.method === "di"
              ? auth.di.expiresAt
                ? new Date(auth.di.expiresAt * 1000).toISOString()
                : "unknown"
              : new Date(auth.oauth2.expires_at * 1000).toISOString(),
        };
      }),
  );

  server.registerTool(
    "garmin_profile",
    {
      title: "Garmin user profile, settings & zones",
      description:
        "The signed-in user's Garmin profile (name, display name, location, level), user settings (birth date, gender, " +
        "height, weight, VO2 max, current lactate threshold, measurement system, sleep window, step/floor/intensity goals), " +
        "profile/privacy settings, configured heart-rate zones per sport, and power zones per sport.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const c = client();
        return settled({
          socialProfile: c.socialProfile(),
          userSettings: c.userSettings(),
          profileSettings: c.profileSettings(),
          heartRateZones: c.heartRateZones(),
          powerZones: c.powerZones(),
        });
      }),
  );

  // ------------------------------------------------------------- wellness

  server.registerTool(
    "garmin_daily_summary",
    {
      title: "Garmin daily summary",
      description:
        "Everything Garmin rolls up for one day: steps and step goal, distance, floors, calories (total/active/BMR), " +
        "intensity minutes, resting/min/max heart rate, average and max stress, stress duration breakdown, " +
        "Body Battery charged/drained/high/low, sleeping seconds, average SpO2, average respiration, and sync state. " +
        "Start here for any 'how was my day' question.",
      inputSchema: { date: dateField },
      annotations: { readOnlyHint: true },
    },
    ({ date }) => run(() => client().dailySummary(day(date))),
  );

  const wellnessMetrics = [
    "sleep",
    "heartRate",
    "stress",
    "bodyBattery",
    "hrv",
    "spo2",
    "respiration",
    "intensityMinutes",
    "floors",
    "hydration",
    "stepsChart",
    "activitiesForDate",
    "dailyEvents",
    "weighIns",
    "nutritionFoodLog",
    "nutritionMeals",
    "nutritionSettings",
    "lifestyleLog",
    "menstrualCycle",
    "menstrualSummary",
    "menstrualLastConfirmed",
    "menstrualReports",
    "pregnancy",
  ] as const;

  server.registerTool(
    "garmin_wellness",
    {
      title: "Garmin wellness detail for a day",
      description:
        "Detailed per-day health data. metric: " +
        "sleep (stages, sleep score and feedback, overnight HRV, SpO2, respiration, restless moments, movement timeline), " +
        "heartRate (2-minute heart-rate timeline + resting/min/max), stress (3-minute stress and Body Battery timelines), " +
        "bodyBattery (charge/drain events such as sleep and activities), hrv (overnight HRV readings, weekly average, baseline, status), " +
        "spo2 (pulse-ox timeline and averages), respiration (breaths-per-minute timeline), " +
        "intensityMinutes (moderate/vigorous minutes and weekly goal progress), floors (15-minute floors climbed/descended), " +
        "hydration (intake vs goal, sweat loss), stepsChart (15-minute step counts and activity levels), " +
        "activitiesForDate (that day's activities with all-day heart rate, as the app shows them), " +
        "dailyEvents (device-detected events such as naps and activities), weighIns (weight and body composition measurements taken that day), " +
        "nutritionFoodLog / nutritionMeals / nutritionSettings (food logging, if used), lifestyleLog (daily lifestyle logging entries), " +
        "menstrualCycle (cycle day view), menstrualSummary, menstrualLastConfirmed, menstrualReports (last 6 cycles), " +
        "pregnancy (pregnancy snapshot; ignores date).",
      inputSchema: {
        metric: z.enum(wellnessMetrics).describe("Which wellness metric to fetch"),
        date: dateField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ metric, date }) =>
      run(async () => {
        const c = client();
        const d = day(date);
        switch (metric) {
          case "sleep":
            return c.sleep(d);
          case "heartRate":
            return c.heartRate(d);
          case "stress":
            return c.stress(d);
          case "bodyBattery":
            return settled({ events: c.bodyBatteryEvents(d), dailyReport: c.bodyBatteryReport(d, d) });
          case "hrv":
            return c.hrv(d);
          case "spo2":
            return c.spo2(d);
          case "respiration":
            return c.respiration(d);
          case "intensityMinutes":
            return c.intensityMinutes(d);
          case "floors":
            return c.floors(d);
          case "hydration":
            return c.hydration(d);
          case "stepsChart":
            return c.stepsChart(d);
          case "activitiesForDate":
            return c.activitiesForDate(d);
          case "dailyEvents":
            return c.dailyEvents(d);
          case "weighIns":
            return c.weighIns(d);
          case "nutritionFoodLog":
            return c.nutrition("foodLog", d);
          case "nutritionMeals":
            return c.nutrition("meals", d);
          case "nutritionSettings":
            return c.nutrition("settings", d);
          case "lifestyleLog":
            return c.lifestyleLog(d);
          case "menstrualCycle":
            return c.menstrualDay(d);
          case "menstrualSummary":
            return c.menstrualSummary(d);
          case "menstrualLastConfirmed":
            return c.menstrualLastConfirmed(d);
          case "menstrualReports":
            return c.menstrualReports(d);
          case "pregnancy":
            return c.pregnancySnapshot();
        }
      }),
  );

  const trendMetrics = [
    "steps",
    "stepsWeekly",
    "stress",
    "stressWeekly",
    "intensityMinutes",
    "intensityMinutesWeekly",
    "hydration",
    "calories",
    "sleep",
    "hrv",
    "bodyBattery",
    "restingHeartRate",
    "vo2max",
    "racePredictions",
    "enduranceScore",
    "hillScore",
    "runningTolerance",
    "lactateThreshold",
    "ftp",
    "trainingLoad",
    "weight",
    "bloodPressure",
    "menstrualCalendar",
  ] as const;

  server.registerTool(
    "garmin_trend",
    {
      title: "Garmin trend over a date range",
      description:
        "One row per day (or week) across a date range, for trend and comparison questions. metric: " +
        "steps / stepsWeekly (totals, goal, distance), stress / stressWeekly (average stress and rest/low/medium/high durations), " +
        "intensityMinutes / intensityMinutesWeekly, hydration, calories (active + resting/BMR + total per day), " +
        "sleep (nightly sleep summaries: score, quality/duration/recovery/restfulness sub-scores, stage durations), " +
        "hrv (nightly HRV summaries with weekly average, baseline and status), bodyBattery (daily charge/drain and min/max), " +
        "restingHeartRate, vo2max (running and cycling VO2 max history plus heat/altitude acclimation), " +
        "racePredictions (predicted 5K/10K/half/marathon times per day), enduranceScore (weekly), hillScore, " +
        "runningTolerance (weekly running tolerance / load), lactateThreshold (running LT speed and heart-rate history), " +
        "ftp (functional threshold power history; sport defaults to CYCLING), " +
        "trainingLoad (per-activity training load and training-effect labels), " +
        "weight (weight and body composition: BMI, body fat %, water %, muscle and bone mass), bloodPressure (all readings), " +
        "menstrualCalendar (cycle summaries). " +
        "Garmin's per-request caps are handled for you: daily metrics are fetched in 28-day windows, race predictions yearly, " +
        "the menstrual calendar in 90-day windows, and the weekly metrics cover at most 52 weeks ending at `end`.",
      inputSchema: {
        metric: z.enum(trendMetrics).describe("Which metric to trend"),
        start: startField,
        end: endField,
        aggregation: z.enum(["daily", "weekly", "monthly", "yearly"]).optional().describe("lactateThreshold / ftp / runningTolerance only (runningTolerance: daily or weekly)"),
        sport: z.string().optional().describe("ftp only: sport key, default CYCLING"),
        activityType: z.string().optional().describe("trainingLoad only: restrict to one activity type key"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ metric, start, end, aggregation, sport, activityType }) =>
      run(() => {
        const c = client();
        const [s, e] = range(start, end);
        const weeks = Math.min(52, Math.floor(daysBetween(s, e) / 7) + 1);
        switch (metric) {
          case "steps":
            return c.stepsRange(s, e);
          case "stepsWeekly":
            return c.stepsWeekly(e, weeks);
          case "stress":
            return c.stressRange(s, e);
          case "stressWeekly":
            return c.stressWeekly(e, weeks);
          case "intensityMinutes":
            return c.intensityMinutesRange(s, e);
          case "intensityMinutesWeekly":
            return c.intensityMinutesWeekly(s, e);
          case "hydration":
            return c.hydrationRange(s, e);
          case "calories":
            return c.caloriesRange(s, e);
          case "sleep":
            return c.sleepRange(s, e);
          case "hrv":
            return c.hrvRange(s, e);
          case "bodyBattery":
            return c.bodyBatteryReport(s, e);
          case "restingHeartRate":
            return c.restingHeartRate(s, e);
          case "vo2max":
            return c.maxMetrics(s, e);
          case "racePredictions":
            return c.racePredictionsRange(s, e);
          case "enduranceScore":
            return c.enduranceScoreRange(s, e);
          case "hillScore":
            return c.hillScoreRange(s, e);
          case "runningTolerance":
            return c.runningTolerance(s, e, aggregation === "daily" ? "daily" : "weekly");
          case "lactateThreshold":
            return c.lactateThresholdRange(s, e, aggregation ?? "daily");
          case "ftp":
            return c.ftpRange(s, e, sport ?? "CYCLING", aggregation ?? "daily");
          case "trainingLoad":
            return c.trainingLoadActivities(s, e, activityType);
          case "weight":
            return c.weightRange(s, e);
          case "bloodPressure":
            return c.bloodPressureRange(s, e);
          case "menstrualCalendar":
            return c.menstrualCalendar(s, e);
        }
      }),
  );

  // ------------------------------------------------------------- training

  const trainingMetrics = [
    "readiness",
    "status",
    "dailyStatus",
    "loadBalance",
    "vo2max",
    "racePredictions",
    "enduranceScore",
    "hillScore",
    "fitnessAge",
    "lactateThreshold",
    "ftp",
    "heartRateZones",
    "powerZones",
    "trainingPlans",
    "trainingPlan",
  ] as const;

  server.registerTool(
    "garmin_training",
    {
      title: "Garmin training & performance metrics",
      description:
        "Training-related metrics as of a date. metric: " +
        "readiness (Training Readiness entries for the day with sleep, recovery time, HRV, acute load, sleep and stress history factors; " +
        "the entry with inputContext AFTER_WAKEUP_RESET is the morning value), " +
        "status (aggregated Training Status: acute/chronic load, load focus, VO2 max, heat/altitude acclimation, recovery), " +
        "dailyStatus (that day's training status phrase and acute:chronic workload ratio), " +
        "loadBalance (four-week training load focus balance ending on the date), vo2max (latest VO2 max values), " +
        "racePredictions (latest predicted 5K/10K/half/marathon times), enduranceScore, hillScore, fitnessAge, " +
        "lactateThreshold (latest running LT speed and heart rate, plus running power-to-weight), ftp (latest cycling FTP), " +
        "heartRateZones (configured zones per sport), powerZones (configured power zones per sport; set `sport` for one), " +
        "trainingPlans (the user's training plans), trainingPlan (one plan's phases; needs `planId`).",
      inputSchema: {
        metric: z.enum(trainingMetrics).describe("Which training metric to fetch"),
        date: dateField,
        sport: z.string().optional().describe("powerZones only: sport key such as CYCLING or RUNNING"),
        planId: z.string().optional().describe("trainingPlan only"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ metric, date, sport, planId }) =>
      run(() => {
        const c = client();
        const d = day(date);
        switch (metric) {
          case "readiness":
            return c.trainingReadiness(d);
          case "status":
            return c.trainingStatus(d);
          case "dailyStatus":
            return c.dailyTrainingStatus(d);
          case "loadBalance":
            return c.trainingLoadBalance(d);
          case "vo2max":
            return c.maxMetrics(d, d);
          case "racePredictions":
            return c.racePredictionsLatest();
          case "enduranceScore":
            return c.enduranceScore(d);
          case "hillScore":
            return c.hillScore(d);
          case "fitnessAge":
            return c.fitnessAge(d);
          case "lactateThreshold":
            return c.lactateThresholdLatest();
          case "ftp":
            return c.ftpLatest();
          case "heartRateZones":
            return c.heartRateZones();
          case "powerZones":
            return c.powerZones(sport);
          case "trainingPlans":
            return c.trainingPlans();
          case "trainingPlan":
            if (!planId) throw new GarminError("planId is required for trainingPlan.");
            return c.trainingPlan(planId);
        }
      }),
  );

  // ----------------------------------------------------------- activities

  server.registerTool(
    "garmin_activities",
    {
      title: "List/search Garmin activities",
      description:
        "List recorded activities (runs, rides, swims, strength, hikes, ...), newest first unless sortOrder=asc. Filter by date range, " +
        "activity type key (e.g. running, trail_running, cycling, swimming, strength_training, walking, hiking — see garmin_activity_types), " +
        "sub-type, or free-text search on the name. Page with start/limit. countOnly=true returns just the total number of activities. " +
        "By default each activity is trimmed to its key metrics; set compact=false for every field Garmin returns.",
      inputSchema: {
        startDate: DATE.optional().describe("Only activities on/after this date (YYYY-MM-DD)"),
        endDate: DATE.optional().describe("Only activities on/before this date (YYYY-MM-DD)"),
        activityType: z.string().optional().describe("Activity type key, e.g. running"),
        activitySubType: z.string().optional().describe("Activity sub-type key (only with activityType)"),
        search: z.string().optional().describe("Text to match in the activity name"),
        sortOrder: z.enum(["asc", "desc"]).optional().describe("asc = oldest first (default newest first)"),
        start: z.number().int().min(0).optional().describe("Offset for paging (default 0)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 20)"),
        compact: z.boolean().optional().describe("Trim each activity to key fields (default true)"),
        countOnly: z.boolean().optional().describe("Return only the total activity count"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ startDate, endDate, activityType, activitySubType, search, sortOrder, start, limit, compact, countOnly }) =>
      run(async () => {
        const c = client();
        if (countOnly) return c.activityCount();
        const result = await c.activities({ startDate, endDate, activityType, activitySubType, search, sortOrder, start, limit });
        if (compact === false || !Array.isArray(result)) return result;
        return result.map((a) => summarizeActivity(a as Record<string, unknown>));
      }),
  );

  server.registerTool(
    "garmin_activity_types",
    {
      title: "Garmin activity types",
      description: "The list of activity type keys Garmin uses (for filtering garmin_activities or renaming with garmin_update_activity).",
      annotations: { readOnlyHint: true },
    },
    () => run(() => client().activityTypes()),
  );

  const activitySections = [
    "summary",
    "details",
    "splits",
    "typedSplits",
    "splitSummaries",
    "laps",
    "weather",
    "hrZones",
    "powerZones",
    "exerciseSets",
    "gear",
  ] as const;

  server.registerTool(
    "garmin_activity",
    {
      title: "Garmin activity detail",
      description:
        "Deep data for one activity. section: " +
        "summary (all summary metrics: distance, time, pace/speed, HR, cadence, power, training effect, elevation, temperature, running dynamics, swim/strength specifics), " +
        "details (time-series samples: HR, pace, speed, altitude, cadence, power, temperature, GPS polyline; resolution set by maxChartSize), " +
        "splits or laps (per-lap metrics), typedSplits (interval/rest/recovery classified splits), splitSummaries, " +
        "weather (conditions during the activity), hrZones (time in each HR zone), powerZones (time in each power zone), " +
        "exerciseSets (strength training sets, reps and weights), gear (shoes/bike linked).",
      inputSchema: {
        activityId: activityIdField,
        section: z.enum(activitySections).optional().describe("Which part to fetch (default summary)"),
        maxChartSize: z.number().int().min(10).max(10_000).optional().describe("details only: max samples per metric (default 500)"),
        maxPolylineSize: z.number().int().min(10).max(20_000).optional().describe("details only: max GPS points (default 500)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ activityId, section, maxChartSize, maxPolylineSize }) =>
      run(() => {
        const c = client();
        switch (section ?? "summary") {
          case "summary":
            return c.activity(activityId);
          case "details":
            return c.activityDetails(activityId, maxChartSize ?? 500, maxPolylineSize ?? 500);
          case "laps":
            return c.activitySection(activityId, "splits");
          case "gear":
            return c.activityGear(activityId);
          default:
            return c.activitySection(activityId, section!);
        }
      }),
  );

  server.registerTool(
    "garmin_download_activity",
    {
      title: "Download a Garmin activity file",
      description:
        "Save an activity to disk as the original FIT file (full sensor data), or as TCX, GPX, KML or CSV. " +
        "Files go to ~/.garmin-mcp/downloads/ unless outputPath (file or directory) is given. Returns the saved path.",
      inputSchema: {
        activityId: activityIdField,
        format: z.enum(["fit", "tcx", "gpx", "kml", "csv"]).optional().describe("File format (default fit)"),
        outputPath: outputPathField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ activityId, format, outputPath }) => run(() => client().downloadActivity(activityId, format ?? "fit", outputPath)),
  );

  server.registerTool(
    "garmin_download_health_snapshot",
    {
      title: "Download Health Snapshot files",
      description:
        "Save the FIT files of the Health Snapshots (the watch's 2-minute spot checks of HR, HRV, SpO2, respiration and stress) " +
        "recorded on a date. Files go to ~/.garmin-mcp/downloads/ unless outputPath is given.",
      inputSchema: { date: dateField, outputPath: outputPathField },
      annotations: { readOnlyHint: true },
    },
    ({ date, outputPath }) => run(() => client().downloadHealthSnapshot(day(date), outputPath)),
  );

  server.registerTool(
    "garmin_activity_stats",
    {
      title: "Garmin activity totals over a period",
      description:
        "Aggregate activity totals (distance, duration, calories, elevation gain, ...) between two dates, " +
        "optionally grouped by activity type or bucketed by day/week/month/year. Good for 'how far did I run this year'.",
      inputSchema: {
        start: startField,
        end: endField,
        metric: z.string().optional().describe("Metric to total: distance, duration, movingDuration, calories, elevationGain, elevationLoss (default distance)"),
        aggregation: z.enum(["lifetime", "daily", "weekly", "monthly", "yearly"]).optional().describe("Bucket size (default lifetime = one total)"),
        groupByActivityType: z.boolean().optional().describe("Split totals by parent activity type (default true)"),
        activityType: z.string().optional().describe("Restrict to one activity type key"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ start, end, metric, aggregation, groupByActivityType, activityType }) =>
      run(() => {
        const [s, e] = range(start, end);
        return client().fitnessStats({
          startDate: s,
          endDate: e,
          metric: metric ?? "distance",
          aggregation: aggregation ?? "lifetime",
          groupByActivityType: groupByActivityType ?? true,
          activityType,
        });
      }),
  );

  // ------------------------------------------------- records/badges/goals

  server.registerTool(
    "garmin_personal_records",
    {
      title: "Garmin personal records",
      description: "All personal records: fastest 1K/1mi/5K/10K/half/marathon, longest run/ride, most steps in a day/week/month, highest elevation, etc.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => client().personalRecords()),
  );

  server.registerTool(
    "garmin_badges",
    {
      title: "Garmin badges & challenges",
      description:
        "kind: earned (badges earned with dates and points), available (badges not yet earned, including exclusive ones), " +
        "availableChallenges, completedChallenges, nonCompletedChallenges, inProgressVirtualChallenges, adHocChallenges " +
        "(past head-to-head challenges). Challenge kinds page with start/limit.",
      inputSchema: {
        kind: z
          .enum(["earned", "available", "availableChallenges", "completedChallenges", "nonCompletedChallenges", "inProgressVirtualChallenges", "adHocChallenges"])
          .optional()
          .describe("Default earned"),
        start: z.number().int().min(0).optional().describe("Challenge kinds: page start (1-based, except adHocChallenges which is 0-based)"),
        limit: z.number().int().min(1).max(500).optional().describe("Challenge kinds: page size (default 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ kind, start, limit }) => run(() => client().badges(kind ?? "earned", start, limit)),
  );

  server.registerTool(
    "garmin_goals",
    {
      title: "Garmin goals",
      description: "Goals set in Garmin Connect (step, distance, activity, weight goals), by status: active, future or past.",
      inputSchema: {
        status: z.enum(["active", "future", "past"]).optional().describe("Default active"),
        start: z.number().int().min(1).optional().describe("Page start (default 1)"),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 30)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, start, limit }) => run(() => client().goals(status ?? "active", start ?? 1, limit ?? 30)),
  );

  // --------------------------------------------------------- gear/devices

  server.registerTool(
    "garmin_gear",
    {
      title: "Garmin gear (shoes, bikes, ...)",
      description:
        "Without arguments: all gear with status, purchase date, max distance and defaults. " +
        "With gearUuid: that gear's totals (distance, activities, time) plus the activities it was used for " +
        "(retired gear may have no stats). With defaults=true: which gear is default for each activity type.",
      inputSchema: {
        gearUuid: z.string().optional().describe("uuid from the gear list"),
        defaults: z.boolean().optional().describe("Return default gear per activity type"),
        start: z.number().int().min(0).optional().describe("Gear activities page offset (default 0)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Gear activities page size (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ gearUuid, defaults, start, limit }) =>
      run(async () => {
        const c = client();
        if (defaults) return c.gearDefaults();
        if (gearUuid) {
          const result = await settled({ stats: c.gearStats(gearUuid), activities: c.gearActivities(gearUuid, start ?? 0, limit ?? 20) });
          if (Array.isArray(result.activities)) result.activities = result.activities.map((a) => summarizeActivity(a as Record<string, unknown>));
          return result;
        }
        return c.gearList();
      }),
  );

  server.registerTool(
    "garmin_devices",
    {
      title: "Garmin devices",
      description:
        "kind: list (all registered watches/sensors with model, serial, software version, last sync), " +
        "lastUsed (the device most recently synced), primaryTraining (primary training device and Physio TrueUp source), " +
        "settings (full device settings incl. alarms, activity tracking, display and sensor options; needs deviceId), " +
        "solar (solar charging intensity; needs deviceId and start, intraday when start = end).",
      inputSchema: {
        kind: z.enum(["list", "lastUsed", "primaryTraining", "settings", "solar"]).optional().describe("Default list"),
        deviceId: z.string().optional().describe("deviceId from the device list (settings/solar)"),
        start: DATE.optional().describe("solar: start date"),
        end: DATE.optional().describe("solar: end date (default same as start)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ kind, deviceId, start, end }) =>
      run(() => {
        const c = client();
        switch (kind ?? "list") {
          case "list":
            return c.devices();
          case "lastUsed":
            return c.deviceLastUsed();
          case "primaryTraining":
            return c.primaryTrainingDevice();
          case "settings":
            if (!deviceId) throw new GarminError("deviceId is required for settings.");
            return c.deviceSettings(deviceId);
          case "solar": {
            if (!deviceId || !start) throw new GarminError("deviceId and start are required for solar.");
            const [s, e] = range(start, end ?? start);
            return c.deviceSolar(deviceId, s, e);
          }
        }
      }),
  );

  server.registerTool(
    "garmin_workouts",
    {
      title: "Garmin workouts & training calendar",
      description:
        "Without arguments: list saved structured workouts. With workoutId: the full workout definition (steps, targets, durations); " +
        "download=true also saves it as a FIT file. With year and month: the training calendar for that month " +
        "(scheduled workouts, completed activities, events). With scheduledWorkoutId: one scheduled workout.",
      inputSchema: {
        workoutId: z.string().optional().describe("workoutId from the list"),
        download: z.boolean().optional().describe("Save the workout as FIT (requires workoutId)"),
        outputPath: outputPathField,
        year: z.number().int().min(2000).optional().describe("Calendar year"),
        month: z.number().int().min(1).max(12).optional().describe("Calendar month, 1-12"),
        scheduledWorkoutId: z.string().optional().describe("A scheduled workout's id from the calendar"),
        start: z.number().int().min(0).optional().describe("List offset (default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("List size (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workoutId, download, outputPath, year, month, scheduledWorkoutId, start, limit }) =>
      run(async () => {
        const c = client();
        if (scheduledWorkoutId) return c.scheduledWorkout(scheduledWorkoutId);
        if (year !== undefined || month !== undefined) {
          if (year === undefined || month === undefined) throw new GarminError("year and month are both required for the calendar.");
          return c.scheduledWorkouts(year, month);
        }
        if (!workoutId) return c.workouts(start ?? 0, limit ?? 50);
        const workout = await c.workout(workoutId);
        if (!download) return workout;
        return { workout, download: await c.downloadWorkout(workoutId, outputPath) };
      }),
  );

  server.registerTool(
    "garmin_golf",
    {
      title: "Garmin golf",
      description:
        "kind: summary (recent scorecards; page with start/limit), scorecard (one scorecard's detail; needs scorecardId), " +
        "shots (shot data per hole for a scorecard; optional holes such as \"1,2,3\" for holes 1-9, otherwise all 18), " +
        "clubStats (club usage and distance stats), playerStats (overall player statistics).",
      inputSchema: {
        kind: z.enum(["summary", "scorecard", "shots", "clubStats", "playerStats"]).optional().describe("Default summary"),
        scorecardId: z.string().optional().describe("scorecard id from summary"),
        holes: z.string().optional().describe("shots: hole numbers 1-9 separated by commas"),
        start: z.number().int().min(0).optional().describe("summary: page start (default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("summary/clubStats: page size (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ kind, scorecardId, holes, start, limit }) =>
      run(() => {
        const c = client();
        switch (kind ?? "summary") {
          case "summary":
            return c.golfSummary(start ?? 0, limit ?? 20);
          case "scorecard":
            if (!scorecardId) throw new GarminError("scorecardId is required for scorecard.");
            return c.golfScorecard(scorecardId);
          case "shots":
            if (!scorecardId) throw new GarminError("scorecardId is required for shots.");
            return c.golfShots(scorecardId, holes);
          case "clubStats":
            return c.golfClubStats(limit ?? 20);
          case "playerStats":
            return c.golfPlayerStats();
        }
      }),
  );

  // --------------------------------------------------------------- writes

  server.registerTool(
    "garmin_log_weight",
    {
      title: "Log a weight measurement",
      description: "Add a manual weight entry to Garmin Connect (kg by default, or lbs). Date/time default to now.",
      inputSchema: {
        weight: z.number().positive().describe("Weight value"),
        unit: z.enum(["kg", "lbs"]).optional().describe("Default kg"),
        date: dateField,
        time: timeField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ weight, unit, date, time }) => run(() => client().logWeight({ weight, unit, date: date ? day(date) : undefined, time: normalizeTime(time) })),
  );

  server.registerTool(
    "garmin_log_blood_pressure",
    {
      title: "Log a blood pressure reading",
      description: "Add a manual blood pressure reading (systolic/diastolic mmHg, optional pulse and notes) to Garmin Connect.",
      inputSchema: {
        systolic: z.number().int().min(70).max(260),
        diastolic: z.number().int().min(40).max(150),
        pulse: z.number().int().min(20).max(250).optional(),
        notes: z.string().optional(),
        date: dateField,
        time: timeField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ systolic, diastolic, pulse, notes, date, time }) =>
      run(() => client().logBloodPressure({ systolic, diastolic, pulse, notes, date: date ? day(date) : undefined, time: normalizeTime(time) })),
  );

  server.registerTool(
    "garmin_log_hydration",
    {
      title: "Log water intake",
      description: "Add water intake (millilitres, negative to subtract) to a day's hydration total. A past date without a time is logged at midnight.",
      inputSchema: {
        valueInMl: z.number().int().min(-10_000).max(10_000).describe("Millilitres to add (e.g. 250)"),
        date: dateField,
        time: timeField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ valueInMl, date, time }) => run(() => client().logHydration({ valueInMl, date: date ? day(date) : undefined, time: normalizeTime(time) })),
  );

  server.registerTool(
    "garmin_update_activity",
    {
      title: "Rename or retype an activity",
      description: "Change an activity's name, description, or activity type (typeKey from garmin_activity_types).",
      inputSchema: {
        activityId: activityIdField,
        name: z.string().optional().describe("New activity name"),
        description: z.string().optional().describe("New description/notes"),
        activityType: z.string().optional().describe("New activity type key, e.g. trail_running"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ activityId, name, description, activityType }) =>
      run(() => {
        const changes: Record<string, unknown> = {};
        if (name !== undefined) changes.activityName = name;
        if (description !== undefined) changes.description = description;
        if (activityType !== undefined) changes.activityTypeDTO = { typeKey: activityType };
        if (Object.keys(changes).length === 0) throw new GarminError("Provide at least one of name, description, activityType.");
        return client().updateActivity(activityId, changes);
      }),
  );

  // -------------------------------------------------------------- generic

  server.registerTool(
    "garmin_api_request",
    {
      title: "Raw Garmin Connect API request",
      description:
        "Call any Garmin Connect API endpoint (connectapi.garmin.com) with the signed-in user's token — the escape hatch for data " +
        "the other tools don't cover. path is relative, e.g. /wellness-service/wellness/dailyStress/2026-09-01. " +
        "Useful services: usersummary-service, wellness-service, sleep-service, activity-service, activitylist-service, metrics-service, " +
        "hrv-service, biometric-service, weight-service, bloodpressure-service, userprofile-service, device-service, gear-service, " +
        "workout-service, calendar-service, trainingplan-service, course-service, badge-service, goal-service, personalrecord-service, " +
        "fitnessstats-service, periodichealth-service, nutrition-service, gcs-golfcommunity, download-service. " +
        "{displayName} in the path is replaced with the account's display name. A query value given as an array is sent as a repeated parameter. " +
        "Non-GET methods modify the account.",
      inputSchema: {
        path: z.string().describe("Endpoint path, e.g. /usersummary-service/usersummary/daily/{displayName}"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Default GET"),
        query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().describe("Query parameters"),
        body: z.unknown().optional().describe("JSON body for POST/PUT"),
        headers: z.record(z.string()).optional().describe("Extra request headers (rarely needed)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ path, method, query, body, headers }) =>
      run(async () => {
        const c = client();
        const resolved = path.includes("{displayName}") ? path.replaceAll("{displayName}", await c.displayName()) : path;
        return c.request(method ?? "GET", resolved, { query, body, headers });
      }),
  );

  await server.connect(new StdioServerTransport());
}
