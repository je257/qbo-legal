import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, loadTokens } from "./config.js";
import { GarminClient, GarminError, assertDate, summarizeActivity, todayLocal } from "./garmin.js";
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
  return handler().then(ok, (error: unknown) => ({
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

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .describe("Calendar date, YYYY-MM-DD (the user's local date). Defaults to today.");
const startField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Start date, YYYY-MM-DD (inclusive)");
const endField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .describe("End date, YYYY-MM-DD (inclusive). Defaults to today.");
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

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "garmin-mcp", version: "0.1.0" });
  const client = () => GarminClient.load();

  // ----------------------------------------------------------- connection

  server.registerTool(
    "garmin_auth_status",
    {
      title: "Garmin connection status",
      description: "Show whether a Garmin Connect account is signed in, which account, and when the sign-in expires.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const config = loadConfig();
        const tokens = loadTokens();
        if (!config || !tokens) {
          return {
            connected: false,
            reason: "In a terminal, run `node dist/index.js auth` from the project's garmin-mcp folder to sign in.",
          };
        }
        const mfaExpiry = Number(tokens.oauth1.mfa_expiration_timestamp);
        return {
          connected: true,
          region: domainLabel(tokens.domain),
          email: tokens.email,
          profile: tokens.profile,
          signedInAt: new Date(tokens.createdAt).toISOString(),
          accessTokenExpiresAt: new Date(tokens.oauth2.expires_at * 1000).toISOString(),
          signInValidUntil: mfaExpiry ? new Date(mfaExpiry * 1000).toISOString() : "about one year after sign-in",
        };
      }),
  );

  server.registerTool(
    "garmin_profile",
    {
      title: "Garmin user profile & settings",
      description:
        "The signed-in user's Garmin profile (name, display name, location, level) plus user settings: " +
        "birth date, gender, height, weight, VO2 max, lactate threshold, heart-rate zones, power zones, " +
        "measurement system, sleep window, step/floor/intensity goals, and more.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const c = client();
        const [social, settings] = await Promise.all([c.socialProfile(), c.userSettings()]);
        return { socialProfile: social, userSettings: settings };
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
    "weighIns",
    "menstrualCycle",
    "pregnancy",
    "dailyEvents",
  ] as const;

  server.registerTool(
    "garmin_wellness",
    {
      title: "Garmin wellness detail for a day",
      description:
        "Detailed per-day health data. metric: " +
        "sleep (stages, sleep score and feedback, overnight HRV, SpO2, respiration, restless moments, movement timeline), " +
        "heartRate (2-minute heart-rate timeline + resting/min/max), " +
        "stress (3-minute stress and Body Battery timelines), " +
        "bodyBattery (charge/drain events such as sleep and activities for the day), " +
        "hrv (overnight HRV readings, weekly average, baseline and status), " +
        "spo2 (pulse-ox timeline and averages), respiration (breaths-per-minute timeline), " +
        "intensityMinutes (moderate/vigorous minutes and weekly goal progress), floors (15-minute floors climbed/descended), " +
        "hydration (intake vs goal, sweat loss), stepsChart (15-minute step counts and activity levels), " +
        "weighIns (weight and body composition measurements taken that day), " +
        "menstrualCycle (cycle day view), pregnancy (pregnancy snapshot; ignores date), dailyEvents (device-detected events such as naps and activities).",
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
          case "bodyBattery": {
            const [events, report] = await Promise.all([c.bodyBatteryEvents(d), c.bodyBatteryReport(d, d)]);
            return { events, dailyReport: report };
          }
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
          case "weighIns":
            return c.weighIns(d);
          case "menstrualCycle":
            return c.menstrualDay(d);
          case "pregnancy":
            return c.pregnancySnapshot();
          case "dailyEvents":
            return c.dailyEvents(d);
        }
      }),
  );

  const trendMetrics = [
    "steps",
    "stress",
    "intensityMinutes",
    "hydration",
    "sleepScore",
    "hrv",
    "bodyBattery",
    "restingHeartRate",
    "vo2max",
    "racePredictions",
    "enduranceScore",
    "hillScore",
    "weight",
    "bloodPressure",
    "menstrualCalendar",
  ] as const;

  server.registerTool(
    "garmin_trend",
    {
      title: "Garmin day-by-day trend over a date range",
      description:
        "One value (or summary) per day across a date range, for trend and comparison questions. metric: " +
        "steps (total steps, goal, distance per day), stress (average stress, rest/low/medium/high durations), " +
        "intensityMinutes, hydration, sleepScore (score plus quality/duration/recovery/restfulness sub-scores per night), " +
        "hrv (nightly HRV summaries with weekly average, baseline and status), bodyBattery (daily charge/drain and min/max), " +
        "restingHeartRate, vo2max (running and cycling VO2 max history plus heat/altitude acclimation), " +
        "racePredictions (predicted 5K/10K/half/marathon times per day), enduranceScore (weekly), hillScore, " +
        "weight (weight and body composition: BMI, body fat %, water %, muscle and bone mass), " +
        "bloodPressure (all readings), menstrualCalendar. " +
        "Long ranges are fetched in 28-day chunks automatically, so a 90- or 365-day range is fine.",
      inputSchema: {
        metric: z.enum(trendMetrics).describe("Which metric to trend"),
        start: startField,
        end: endField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ metric, start, end }) =>
      run(() => {
        const c = client();
        const [s, e] = range(start, end);
        switch (metric) {
          case "steps":
            return c.stepsRange(s, e);
          case "stress":
            return c.stressRange(s, e);
          case "intensityMinutes":
            return c.intensityMinutesRange(s, e);
          case "hydration":
            return c.hydrationRange(s, e);
          case "sleepScore":
            return c.sleepScoreRange(s, e);
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
    "vo2max",
    "racePredictions",
    "enduranceScore",
    "hillScore",
    "fitnessAge",
  ] as const;

  server.registerTool(
    "garmin_training",
    {
      title: "Garmin training & performance metrics",
      description:
        "Training-related metrics as of a date. metric: " +
        "readiness (Training Readiness score with sleep, recovery time, HRV, acute load, sleep history and stress history factors), " +
        "status (Training Status, acute/chronic load, load focus balance, VO2 max, heat/altitude acclimation, recovery), " +
        "vo2max (latest VO2 max values), racePredictions (latest predicted 5K/10K/half/marathon times), " +
        "enduranceScore, hillScore, fitnessAge (fitness age with contributing factors).",
      inputSchema: {
        metric: z.enum(trainingMetrics).describe("Which training metric to fetch"),
        date: dateField,
      },
      annotations: { readOnlyHint: true },
    },
    ({ metric, date }) =>
      run(() => {
        const c = client();
        const d = day(date);
        switch (metric) {
          case "readiness":
            return c.trainingReadiness(d);
          case "status":
            return c.trainingStatus(d);
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
        }
      }),
  );

  // ----------------------------------------------------------- activities

  server.registerTool(
    "garmin_activities",
    {
      title: "List/search Garmin activities",
      description:
        "List recorded activities (runs, rides, swims, strength, hikes, ...), newest first. Filter by date range, " +
        "activity type key (e.g. running, trail_running, cycling, swimming, strength_training, walking, hiking — " +
        "see garmin_activity_types), or free-text search on the name. Page with start/limit. " +
        "By default each activity is trimmed to its key metrics; set compact=false for every field Garmin returns.",
      inputSchema: {
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only activities on/after this date (YYYY-MM-DD)"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only activities on/before this date (YYYY-MM-DD)"),
        activityType: z.string().optional().describe("Activity type key, e.g. running"),
        search: z.string().optional().describe("Text to match in the activity name"),
        start: z.number().int().min(0).optional().describe("Offset for paging (default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20)"),
        compact: z.boolean().optional().describe("Trim each activity to key fields (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ startDate, endDate, activityType, search, start, limit, compact }) =>
      run(async () => {
        const result = await client().activities({ startDate, endDate, activityType, search, start, limit });
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
        "weather (conditions during the activity), hrZones (time in each HR zone), powerZones, " +
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
        outputPath: z.string().optional().describe("Destination file path or directory"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ activityId, format, outputPath }) => run(() => client().downloadActivity(activityId, format ?? "fit", outputPath)),
  );

  server.registerTool(
    "garmin_activity_stats",
    {
      title: "Garmin activity totals over a period",
      description:
        "Aggregate activity totals (distance, duration, calories, elevation gain, activity count, ...) between two dates, " +
        "optionally grouped by activity type or bucketed by day/week/month/year. Good for 'how far did I run this year'.",
      inputSchema: {
        start: startField,
        end: endField,
        metric: z
          .string()
          .optional()
          .describe("Metric to total: distance, duration, movingDuration, calories, elevationGain, elevationLoss (default distance)"),
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
        "kind: earned (badges earned with dates and points), available (badges not yet earned), availableChallenges, " +
        "completedChallenges, nonCompletedChallenges, inProgressVirtualChallenges, adHocChallenges (past head-to-head challenges).",
      inputSchema: {
        kind: z
          .enum(["earned", "available", "availableChallenges", "completedChallenges", "nonCompletedChallenges", "inProgressVirtualChallenges", "adHocChallenges"])
          .optional()
          .describe("Default earned"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ kind }) => run(() => client().badges(kind ?? "earned")),
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
        "With gearUuid: that gear's totals (distance, activities, time) plus the activities it was used for. " +
        "With defaults=true: which gear is default for each activity type.",
      inputSchema: {
        gearUuid: z.string().optional().describe("uuid from the gear list"),
        defaults: z.boolean().optional().describe("Return default gear per activity type"),
        start: z.number().int().min(0).optional().describe("Gear activities page offset (default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("Gear activities page size (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ gearUuid, defaults, start, limit }) =>
      run(async () => {
        const c = client();
        if (defaults) return c.gearDefaults();
        if (gearUuid) {
          const [stats, activities] = await Promise.all([c.gearStats(gearUuid), c.gearActivities(gearUuid, start ?? 0, limit ?? 20)]);
          return {
            stats,
            activities: Array.isArray(activities) ? activities.map((a) => summarizeActivity(a as Record<string, unknown>)) : activities,
          };
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
        "solar (solar charging intensity per day; needs deviceId, start, end).",
      inputSchema: {
        kind: z.enum(["list", "lastUsed", "primaryTraining", "settings", "solar"]).optional().describe("Default list"),
        deviceId: z.string().optional().describe("deviceId from the device list (settings/solar)"),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("solar: start date"),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("solar: end date (default today)"),
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
            const [s, e] = range(start, end);
            return c.deviceSolar(deviceId, s, e);
          }
        }
      }),
  );

  server.registerTool(
    "garmin_workouts",
    {
      title: "Garmin structured workouts",
      description:
        "Without workoutId: list saved structured workouts. With workoutId: the full workout definition (steps, targets, durations). " +
        "Set download=true to also save it as a FIT file.",
      inputSchema: {
        workoutId: z.string().optional().describe("workoutId from the list"),
        download: z.boolean().optional().describe("Save the workout as FIT (requires workoutId)"),
        outputPath: z.string().optional().describe("Destination file path or directory for the download"),
        start: z.number().int().min(0).optional().describe("List offset (default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("List size (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workoutId, download, outputPath, start, limit }) =>
      run(async () => {
        const c = client();
        if (!workoutId) return c.workouts(start ?? 0, limit ?? 50);
        const workout = await c.workout(workoutId);
        if (!download) return workout;
        return { workout, download: await c.downloadWorkout(workoutId, outputPath) };
      }),
  );

  // --------------------------------------------------------------- writes

  server.registerTool(
    "garmin_log_weight",
    {
      title: "Log a weight measurement",
      description: "Add a manual weight entry to Garmin Connect. Weight in kilograms; date/time default to now.",
      inputSchema: {
        weightKg: z.number().positive().describe("Weight in kg"),
        date: dateField,
        time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().describe("Local time HH:MM[:SS] (default now)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ weightKg, date, time }) =>
      run(() => client().logWeight({ weightKg, date: date ? day(date) : undefined, time: time && time.length === 5 ? `${time}:00` : time })),
  );

  server.registerTool(
    "garmin_log_blood_pressure",
    {
      title: "Log a blood pressure reading",
      description: "Add a manual blood pressure reading (systolic/diastolic mmHg, optional pulse and notes) to Garmin Connect.",
      inputSchema: {
        systolic: z.number().int().positive(),
        diastolic: z.number().int().positive(),
        pulse: z.number().int().positive().optional(),
        notes: z.string().optional(),
        date: dateField,
        time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().describe("Local time HH:MM[:SS] (default now)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ systolic, diastolic, pulse, notes, date, time }) =>
      run(() =>
        client().logBloodPressure({
          systolic,
          diastolic,
          pulse,
          notes,
          date: date ? day(date) : undefined,
          time: time && time.length === 5 ? `${time}:00` : time,
        }),
      ),
  );

  server.registerTool(
    "garmin_log_hydration",
    {
      title: "Log water intake",
      description: "Add water intake (millilitres, negative to subtract) to a day's hydration total.",
      inputSchema: {
        valueInMl: z.number().int().describe("Millilitres to add (e.g. 250)"),
        date: dateField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ valueInMl, date }) => run(() => client().logHydration({ valueInMl, date: date ? day(date) : undefined })),
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
        "Useful services: usersummary-service, wellness-service, activity-service, activitylist-service, metrics-service, hrv-service, " +
        "sleep via wellness-service/wellness/dailySleepData/{displayName}, weight-service, bloodpressure-service, " +
        "userprofile-service, device-service, gear-service, workout-service, course-service, badge-service, goal-service, " +
        "personalrecord-service, fitnessstats-service, periodichealth-service, download-service, calendar-service " +
        "(/calendar-service/year/{y}/month/{m-1} for the calendar view). {displayName} is available from garmin_auth_status. " +
        "Non-GET methods modify the account.",
      inputSchema: {
        path: z.string().describe("Endpoint path, e.g. /usersummary-service/usersummary/daily/{displayName}"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("Default GET"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters"),
        body: z.unknown().optional().describe("JSON body for POST/PUT"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ path, method, query, body }) =>
      run(async () => {
        const c = client();
        const resolved = path.includes("{displayName}") ? path.replaceAll("{displayName}", await c.displayName()) : path;
        return c.request(method ?? "GET", resolved, { query, body });
      }),
  );

  await server.connect(new StdioServerTransport());
}
