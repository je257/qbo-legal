import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildZip, freshHome, importDist } from "./helpers.mjs";

const home = freshHome();
writeFileSync(
  join(home, "tokens.json"),
  JSON.stringify({
    domain: "garmin.com",
    createdAt: 1,
    profile: { displayName: "abcd-1234", userProfileId: 42 },
    auth: { method: "di", di: { accessToken: "a", refreshToken: "r", clientId: "X", expiresAt: 9999999999 } },
  }),
);
const { GarminClient } = await importDist("garmin.js");

test("date ranges are fetched in 28-day chunks and merged", async () => {
  const c = GarminClient.load();
  const calls = [];
  c.get = async (path) => {
    calls.push(path);
    return path.includes("hrv") ? { hrvSummaries: [{ path }] } : [{ path }];
  };
  const r = await c.stepsRange("2026-06-01", "2026-08-29");
  assert.deepEqual(calls, [
    "/usersummary-service/stats/steps/daily/2026-06-01/2026-06-28",
    "/usersummary-service/stats/steps/daily/2026-06-29/2026-07-26",
    "/usersummary-service/stats/steps/daily/2026-07-27/2026-08-23",
    "/usersummary-service/stats/steps/daily/2026-08-24/2026-08-29",
  ]);
  assert.equal(r.length, 4);
  calls.length = 0;
  await c.stepsRange("2026-06-01", "2026-06-28");
  assert.equal(calls.length, 1);
  calls.length = 0;
  const hrv = await c.hrvRange("2026-01-01", "2026-03-01");
  assert.equal(calls.length, 3);
  assert.equal(hrv.hrvSummaries.length, 3);
  calls.length = 0;
  await c.dailySummary("2026-09-22");
  assert.equal(calls[0], "/usersummary-service/usersummary/daily/abcd-1234");
});

test("activity downloads unpack the FIT zip and honour output paths", async () => {
  const c = GarminClient.load();
  const zip = buildZip([{ name: "777_ACTIVITY.fit", data: "FIT".repeat(100), method: 8 }]);
  const paths = [];
  c.download = async (path) => {
    paths.push(path);
    return { bytes: path.includes("/files/") ? zip : Buffer.from("<gpx/>"), contentType: "x" };
  };
  let r = await c.downloadActivity("777", "fit");
  assert.equal(paths.at(-1), "/download-service/files/activity/777");
  assert.ok(r[0].savedTo.endsWith("/downloads/777.fit"));
  assert.equal(r[0].bytes, 300);
  const out = join(home, "out");
  mkdirSync(out);
  r = await c.downloadActivity("777", "gpx", out + "/");
  assert.equal(paths.at(-1), "/download-service/export/gpx/activity/777");
  assert.equal(readFileSync(r[0].savedTo, "utf8"), "<gpx/>");
  r = await c.downloadActivity("777", "tcx", join(out, "my-run.tcx"));
  assert.ok(existsSync(join(out, "my-run.tcx")));
});

test("manual-entry payloads match python-garminconnect's", async () => {
  const c = GarminClient.load();
  const bodies = [];
  c.request = async (m, p, o) => {
    bodies.push([m, p, o.body]);
    return {};
  };
  await c.logWeight({ weight: 80.5, date: "2026-09-22", time: "07:30:00" });
  assert.equal(bodies[0][1], "/weight-service/user-weight");
  assert.deepEqual(Object.keys(bodies[0][2]).sort(), ["dateTimestamp", "gmtTimestamp", "sourceType", "unitKey", "value"]);
  assert.equal(bodies[0][2].dateTimestamp, "2026-09-22T07:30:00.000");
  assert.match(bodies[0][2].gmtTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000$/);
  assert.equal(bodies[0][2].unitKey, "kg");
  await c.logWeight({ weight: 177, unit: "lbs" });
  assert.equal(bodies[1][2].unitKey, "lbs");
  // back-dated hydration without a time is logged at local midnight of that date
  await c.logHydration({ valueInMl: 250, date: "2020-01-02" });
  assert.deepEqual(bodies[2][2], { calendarDate: "2020-01-02", valueInML: 250, timestampLocal: "2020-01-02T00:00:00.000" });
  await c.logHydration({ valueInMl: 100, date: "2020-01-02", time: "13:05:00" });
  assert.equal(bodies[3][2].timestampLocal, "2020-01-02T13:05:00.000");
  await c.logBloodPressure({ systolic: 120, diastolic: 80, date: "2026-09-22", time: "08:00:00" });
  assert.deepEqual(bodies[4][2], {
    measurementTimestampLocal: "2026-09-22T08:00:00.000",
    measurementTimestampGMT: bodies[4][2].measurementTimestampGMT,
    systolic: 120,
    diastolic: 80,
    sourceType: "MANUAL",
    notes: "",
  });
  await c.logBloodPressure({ systolic: 120, diastolic: 80, pulse: 60 });
  assert.equal(bodies[5][2].pulse, 60);
  c.get = async () => [{ typeKey: "trail_running", typeId: 6, parentTypeId: 1 }];
  await c.updateActivity("5", { activityTypeDTO: { typeKey: "trail_running" } });
  assert.deepEqual(bodies[6][2], { activityId: 5, activityTypeDTO: { typeId: 6, typeKey: "trail_running", parentTypeId: 1 } });
  await assert.rejects(c.updateActivity("5", { activityTypeDTO: { typeKey: "nope" } }), /Unknown activity type key/);
});

function recording(client) {
  const calls = [];
  client.get = async (path, query, headers) => {
    calls.push({ path, query, headers });
    return client.__respond ? client.__respond(path, query) : {};
  };
  return calls;
}

test("endpoint shapes match python-garminconnect 0.3.17", async () => {
  const c = GarminClient.load();
  const calls = recording(c);
  await c.trainingStatus("2026-01-02");
  assert.deepEqual(calls.at(-1), { path: "/metrics-service/metrics/trainingstatus/aggregated/2026-01-02", query: undefined, headers: undefined });
  await c.dailyTrainingStatus("2026-01-02");
  assert.equal(calls.at(-1).path, "/metrics-service/metrics/trainingstatus/daily/2026-01-02");
  await c.trainingLoadBalance("2026-01-02");
  assert.equal(calls.at(-1).path, "/metrics-service/metrics/trainingloadbalance/latest/2026-01-02");
  await c.goals("active", 1, 30);
  assert.deepEqual(calls.at(-1), { path: "/goal-service/goal/goals", query: { status: "active", start: 1, limit: 30, sortOrder: "asc" }, headers: { "Sec-Fetch-Site": "same-origin" } });
  await c.badges("available");
  assert.deepEqual(calls.at(-1).query, { showExclusiveBadge: true });
  await c.badges("completedChallenges");
  assert.deepEqual(calls.at(-1), { path: "/badgechallenge-service/badgeChallenge/completed", query: { start: 1, limit: 100 }, headers: undefined });
  await c.badges("adHocChallenges");
  assert.deepEqual(calls.at(-1).query, { start: 0, limit: 100 });
  await c.badges("earned");
  assert.equal(calls.at(-1).query, undefined);
  await c.gearList();
  assert.deepEqual(calls.at(-1), { path: "/gear-service/gear/filterGear", query: { userProfilePk: 42 }, headers: undefined });
  await c.gearDefaults();
  assert.equal(calls.at(-1).path, "/gear-service/gear/user/42/activityTypes");
  await c.activities({ activityType: "cycling", activitySubType: "road_biking", sortOrder: "asc", startDate: "2026-01-01" });
  assert.deepEqual(calls.at(-1).query, { start: 0, limit: 20, activityType: "cycling", activitySubType: "road_biking", startDate: "2026-01-01", endDate: undefined, search: undefined, sortOrder: "asc" });
  await c.activityCount();
  assert.equal(calls.at(-1).path, "/activitylist-service/activities/count");
  await c.activitiesForDate("2026-01-02");
  assert.equal(calls.at(-1).path, "/mobile-gateway/heartRate/forDate/2026-01-02");
  await c.heartRateZones();
  assert.equal(calls.at(-1).path, "/biometric-service/heartRateZones");
  await c.powerZones();
  assert.equal(calls.at(-1).path, "/biometric-service/powerZones/sports/all");
  await c.powerZones("cycling");
  assert.equal(calls.at(-1).path, "/biometric-service/powerZones/sport/CYCLING");
  await assert.rejects(c.powerZones("bad key!"), /letters and underscores/);
  await c.ftpLatest();
  assert.equal(calls.at(-1).path, "/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING");
  await c.ftpRange("2026-01-01", "2026-03-01");
  assert.deepEqual(calls.at(-1), { path: "/biometric-service/stats/functionalThresholdPower/range/2026-01-01/2026-03-01", query: { sport: "CYCLING", aggregation: "daily", aggregationStrategy: "LATEST" }, headers: undefined });
  await c.lactateThresholdRange("2026-01-01", "2026-03-01", "weekly");
  assert.deepEqual(calls.slice(-2).map((x) => x.path), ["/biometric-service/stats/lactateThresholdSpeed/range/2026-01-01/2026-03-01", "/biometric-service/stats/lactateThresholdHeartRate/range/2026-01-01/2026-03-01"]);
  assert.deepEqual(calls.at(-1).query, { sport: "RUNNING", aggregation: "weekly", aggregationStrategy: "LATEST" });
  await c.runningTolerance("2026-01-01", "2026-03-01");
  assert.deepEqual(calls.at(-1), { path: "/metrics-service/metrics/runningtolerance/stats", query: { startDate: "2026-01-01", endDate: "2026-03-01", aggregation: "weekly" }, headers: undefined });
  await c.trainingLoadActivities("2026-01-01", "2026-03-01", "running");
  assert.deepEqual(calls.at(-1).query, { startDate: "2026-01-01", endDate: "2026-03-01", metric: ["activityTrainingLoad", "trainingEffectLabel", "trainingEffectLabelSrvrCalc"], activityType: "running" });
  await c.stepsWeekly("2026-03-01", 12);
  assert.equal(calls.at(-1).path, "/usersummary-service/stats/steps/weekly/2026-03-01/12");
  await c.intensityMinutesWeekly("2026-01-01", "2026-03-01");
  assert.equal(calls.at(-1).path, "/usersummary-service/stats/im/weekly/2026-01-01/2026-03-01");
  await c.scheduledWorkouts(2026, 1);
  assert.equal(calls.at(-1).path, "/calendar-service/year/2026/month/0");
  await c.scheduledWorkout("77");
  assert.equal(calls.at(-1).path, "/workout-service/schedule/77");
  await c.trainingPlan("9");
  assert.equal(calls.at(-1).path, "/trainingplan-service/trainingplan/phased/9");
  await c.nutrition("foodLog", "2026-01-02");
  assert.equal(calls.at(-1).path, "/nutrition-service/food/logs/2026-01-02");
  await c.menstrualReports("2026-01-02");
  assert.deepEqual(calls.at(-1), { path: "/periodichealth-service/reports/menstrualcycle/6/2026-01-02", query: { reportType: "CYCLE", numberOfCycles: 6 }, headers: undefined });
  await c.golfScorecard("123");
  assert.deepEqual(calls.at(-1).query, { "scorecard-ids": "123", "include-longest-shot-distance": true });
  await c.golfShots("123", "1,2,3");
  assert.deepEqual(calls.at(-1), { path: "/gcs-golfcommunity/api/v2/shot/scorecard/123/hole", query: { "hole-numbers": "1-2-3" }, headers: undefined });
  await c.golfShots("123", "10,11");
  assert.deepEqual(calls.at(-1).query, {});
  await c.golfClubStats(5);
  assert.deepEqual(calls.at(-1).query, { "per-page": 5, "include-stats": true });
});

test("response post-processing: solar unwrap, calories, sleep de-dup, 404-tolerant gear", async () => {
  const c = GarminClient.load();
  const calls = recording(c);
  c.__respond = (path, query) => {
    if (path.startsWith("/web-gateway/solar/")) return { deviceSolarInput: [{ x: 1 }] };
    if (path.startsWith("/userstats-service/")) {
      return { allMetrics: { metricsMap: { WELLNESS_ACTIVE_CALORIES: [{ calendarDate: "2026-01-01", value: 500 }, { calendarDate: "2026-01-02", value: 600 }], WELLNESS_BMR_CALORIES: [{ calendarDate: "2026-01-02", value: 1500 }] } } };
    }
    if (path.startsWith("/sleep-service/stats/sleep/daily/")) {
      const [, s] = /daily\/(\S+)\/(\S+)$/.exec(path);
      return { individualStats: [{ calendarDate: s, score: 80 }, { calendarDate: "2026-01-28", score: 70 }] };
    }
    return {};
  };
  assert.deepEqual(await c.deviceSolar("1", "2026-01-01", "2026-01-01"), [{ x: 1 }]);
  assert.deepEqual(calls.at(-1).query, { singleDayView: true });
  await c.deviceSolar("1", "2026-01-01", "2026-01-05");
  assert.deepEqual(calls.at(-1).query, { singleDayView: false });

  assert.deepEqual(await c.caloriesRange("2026-01-01", "2026-01-02"), [
    { calendarDate: "2026-01-01", active: 500, resting: null, total: 500 },
    { calendarDate: "2026-01-02", active: 600, resting: 1500, total: 2100 },
  ]);
  assert.deepEqual(calls.at(-1).query, { fromDate: "2026-01-01", untilDate: "2026-01-02", metricId: [22, 23] });

  const sleep = await c.sleepRange("2026-01-01", "2026-02-10");
  assert.deepEqual(calls.slice(-2).map((x) => x.path), ["/sleep-service/stats/sleep/daily/2026-01-01/2026-01-28", "/sleep-service/stats/sleep/daily/2026-01-29/2026-02-10"]);
  assert.deepEqual(sleep.map((r) => r.calendarDate), ["2026-01-01", "2026-01-28", "2026-01-29"]);

  const { GarminError } = await importDist("garmin.js");
  c.get = async () => { throw new GarminError("not found", 404); };
  assert.deepEqual(await c.gearStats("u"), {});
  assert.deepEqual(await c.gearActivities("u", 0, 20), []);
  c.get = async () => { throw new GarminError("forbidden", 403); };
  await assert.rejects(c.gearStats("u"), /forbidden/);
});

test("long ranges: menstrual calendar in 90-day windows, race predictions yearly", async () => {
  const c = GarminClient.load();
  const calls = recording(c);
  c.__respond = (path) => (path.includes("menstrualcycle/calendar") ? [{ cycleId: "a" }, { cycleId: path.slice(-10) }] : [{ path }]);
  const cycles = await c.menstrualCalendar("2026-01-01", "2026-07-01");
  assert.deepEqual(calls.map((x) => x.path), [
    "/periodichealth-service/menstrualcycle/calendar/2026-01-01/2026-03-31",
    "/periodichealth-service/menstrualcycle/calendar/2026-04-01/2026-06-29",
    "/periodichealth-service/menstrualcycle/calendar/2026-06-30/2026-07-01",
  ]);
  assert.equal(cycles.filter((x) => x.cycleId === "a").length, 1, "duplicate cycles across windows are dropped");
  calls.length = 0;
  await c.racePredictionsRange("2024-01-01", "2025-06-30");
  assert.deepEqual(calls.map((x) => x.query), [
    { fromCalendarDate: "2024-01-01", toCalendarDate: "2024-12-31" },
    { fromCalendarDate: "2025-01-01", toCalendarDate: "2025-06-30" },
  ]);
  assert.equal(calls[0].path, "/metrics-service/metrics/racepredictions/daily/abcd-1234");
});

test("query arrays become repeated parameters and displayName is URL-encoded", async () => {
  writeFileSync(
    join(home, "tokens.json"),
    JSON.stringify({ domain: "garmin.com", email: "me@example.com", createdAt: 1, auth: { method: "di", di: { accessToken: "a", clientId: "X", expiresAt: 9999999999 } } }),
  );
  const c = GarminClient.load();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url.toString());
    if (url.pathname === "/userprofile-service/socialProfile") return new Response("{}", { status: 200 });
    return new Response("[]", { status: 200 });
  };
  const name = await c.displayName();
  assert.equal(name, "me%40example.com", "falls back to the login email when Garmin returns no displayName");
  assert.equal(urls.length, 3, "retries the profile fetch three times");
  await c.get("/x", { metricId: [22, 23], a: "b" });
  assert.ok(urls.at(-1).endsWith("/x?metricId=22&metricId=23&a=b"), urls.at(-1));
});
