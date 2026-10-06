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
  await c.logWeight({ weightKg: 80.5, date: "2026-09-22", time: "07:30:00" });
  assert.equal(bodies[0][1], "/weight-service/user-weight");
  assert.equal(bodies[0][2].dateTimestampLocal, "2026-09-22T07:30:00.00");
  assert.match(bodies[0][2].gmtTimestampLocal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.00$/);
  assert.equal(bodies[0][2].unitKey, "kg");
  await c.logHydration({ valueInMl: 250, date: "2026-09-22" });
  assert.deepEqual(Object.keys(bodies[1][2]).sort(), ["calendarDate", "timestampLocal", "valueInML"]);
  await c.logBloodPressure({ systolic: 120, diastolic: 80, pulse: 60, date: "2026-09-22", time: "08:00:00" });
  assert.equal(bodies[2][2].measurementTimestampLocal, "2026-09-22T08:00:00.00");
  assert.equal(bodies[2][2].sourceType, "MANUAL");
  c.get = async () => [{ typeKey: "trail_running", typeId: 6, parentTypeId: 1 }];
  await c.updateActivity("5", { activityTypeDTO: { typeKey: "trail_running" } });
  assert.deepEqual(bodies[3][2], { activityId: 5, activityTypeDTO: { typeId: 6, typeKey: "trail_running", parentTypeId: 1 } });
  await assert.rejects(c.updateActivity("5", { activityTypeDTO: { typeKey: "nope" } }), /Unknown activity type key/);
});
