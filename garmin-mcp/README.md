# garmin-mcp

A private Garmin Connect connector for Claude: a local MCP (Model Context
Protocol) server that gives Claude Desktop or Claude Code read access to
everything in your Garmin Connect account — daily wellness, sleep, HRV,
stress, Body Battery, training metrics, activities with full time series and
FIT downloads, devices, gear, records, goals — plus a few manual-entry tools.

Credentials and tokens stay on your own machine (`~/.garmin-mcp/`, owner-only
file permissions). Nothing is hosted anywhere.

> **New here?** Follow the step-by-step [beginner setup guide](SETUP.md).
> The notes below are the condensed version for developers.

## How it gets "maximum access"

Garmin's official APIs are not an option for an individual: the Health API
is for approved businesses and only pushes summaries to a server. So this
connector signs in the same way the Garmin Connect mobile app does and calls
the same `connectapi.garmin.com` endpoints the app uses. The flow is a port
of the one in the actively maintained
[`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)
library (0.3.x), with [`garth`](https://github.com/matin/garth)'s older
token exchange kept as a fallback:

1. **Service ticket.** Your email and password (and MFA code, if your
   account uses one) go to Garmin SSO's mobile-app JSON login. If Garmin
   rate-limits or bot-challenges that, the connector falls back, in turn, to
   the Android client id, the embedded sign-in widget, and the web portal
   login, each of which sits in a different rate-limit bucket.
2. **Tokens.** The ticket is exchanged at `diauth.garmin.com` for a "DI"
   OAuth2 bearer token plus a refresh token, exactly as the current Garmin
   Connect app does. If that exchange is refused, the connector falls back
   to garth's OAuth1 exchange (which needs the mobile app's OAuth consumer
   key, fetched once from the location garth publishes it and cached).
3. **Check.** The token is only accepted once `connectapi` has answered a
   real request with it.

Consequences worth knowing:

- Your password is used once, to sign in, and is **not stored**. The DI
  token refreshes itself indefinitely; you only sign in again if Garmin
  revokes it (for example after a password change). With the OAuth1
  fallback the sign-in lasts about a year.
- Garmin can change these endpoints at any time. The `garmin_api_request`
  tool exists so new or renamed endpoints work without a code change.
- Garmin's terms don't formally sanction automated access to Connect. This is
  your own data on your own machine, but use it with that in mind and avoid
  hammering the API (Garmin rate-limits with HTTP 429).

## Setup

Requires Node.js 20+.

```sh
cd garmin-mcp
npm install     # also builds (prepare script)
node dist/index.js setup
```

`setup` runs two things in sequence:

- **`auth`** — asks for your region (Enter for global), Garmin Connect email
  and password (hidden), and an MFA code if your account uses one. Tokens
  land in `~/.garmin-mcp/tokens.json` (mode 600). Sign-in normally takes a
  few seconds; if Garmin blocks the fast methods it can take up to half a
  minute while the fallbacks pace themselves to look like a browser.
- **`install`** — registers the server in Claude Desktop's
  `claude_desktop_config.json` (existing config is backed up first), then
  prints the equivalent `claude mcp add` one-liner for Claude Code.

Each is also runnable on its own (`node dist/index.js auth` /
`node dist/index.js install`), and `node dist/index.js status` shows the
connection. After `install`, restart Claude Desktop.

Manual registration — **Claude Code:**

```sh
claude mcp add garmin -- node /absolute/path/to/qbo-legal/garmin-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/absolute/path/to/qbo-legal/garmin-mcp/dist/index.js"]
    }
  }
}
```

Environment variables: `GARMIN_EMAIL` / `GARMIN_PASSWORD` (non-interactive
`auth`), `GARMIN_DOMAIN` (`garmin.com` | `garmin.cn`),
`GARMIN_OAUTH_CONSUMER_KEY` / `GARMIN_OAUTH_CONSUMER_SECRET` (override the
fetched consumer credentials), `GARMIN_MCP_DIR` (config directory).

## Tools exposed to Claude

Read-only unless noted. Dates are `YYYY-MM-DD` and default to today. Every
endpoint path, parameter and payload was cross-checked against
`python-garminconnect` 0.3.17 and `garth` 0.8.0 (the connector's `npm test`
pins the request shapes), but none of it has been exercised against a live
account from this repository yet.

| Tool | What it does |
| --- | --- |
| `garmin_auth_status` | Signed-in account, region, token expiry |
| `garmin_profile` | Social profile, user settings (birth date, height, weight, VO2 max, goals, units), profile settings, heart-rate zones and power zones per sport |
| `garmin_daily_summary` | One day's roll-up: steps, distance, floors, calories, intensity minutes, HR, stress, Body Battery, sleep seconds, SpO2, respiration |
| `garmin_wellness` | Per-day detail by `metric`: sleep, heartRate, stress, bodyBattery, hrv, spo2, respiration, intensityMinutes, floors, hydration, stepsChart, activitiesForDate, dailyEvents, weighIns, nutrition (food log / meals / settings), lifestyleLog, menstrual (day, summary, last confirmed, reports), pregnancy |
| `garmin_trend` | Series over a range by `metric`: steps / stepsWeekly, stress / stressWeekly, intensityMinutes / intensityMinutesWeekly, hydration, calories, sleep (nightly summaries with sub-scores), hrv, bodyBattery, restingHeartRate, vo2max, racePredictions, enduranceScore, hillScore, runningTolerance, lactateThreshold, ftp, trainingLoad (per activity), weight, bloodPressure, menstrualCalendar. Garmin's per-request caps are chunked for you |
| `garmin_training` | Training Readiness, aggregated and daily Training Status, four-week load balance, VO2 max, race predictions, endurance/hill score, fitness age, latest lactate threshold and FTP, HR and power zones, training plans |
| `garmin_activities` | List/search activities by date, type/sub-type, or name, oldest- or newest-first, or just the total count (compact by default) |
| `garmin_activity_types` | Garmin's activity type keys |
| `garmin_activity` | One activity by `section`: summary, details (time series + GPS), splits/laps, typedSplits, splitSummaries, weather, hrZones, powerZones, exerciseSets, gear |
| `garmin_download_activity` | Save the original FIT (unzipped), or TCX/GPX/KML/CSV, to disk |
| `garmin_download_health_snapshot` | Save a day's Health Snapshot FIT files to disk |
| `garmin_activity_stats` | Totals (distance, duration, calories, elevation…) over a period, by activity type |
| `garmin_personal_records` | All PRs |
| `garmin_badges` | Earned/available badges (incl. exclusive) and paged challenges |
| `garmin_goals` | Active/future/past goals |
| `garmin_gear` | Gear list, per-gear totals and activities, defaults per activity type |
| `garmin_devices` | Registered devices, last used, primary training device, full device settings, solar data |
| `garmin_workouts` | Saved structured workouts, full definition, FIT download, the monthly training calendar, scheduled workouts |
| `garmin_golf` | Scorecards, scorecard detail, shot data, club and player stats |
| `garmin_log_weight` | *Write:* add a manual weight entry (kg or lbs) |
| `garmin_log_blood_pressure` | *Write:* add a blood pressure reading |
| `garmin_log_hydration` | *Write:* add water intake |
| `garmin_update_activity` | *Write:* rename, describe, or retype an activity |
| `garmin_api_request` | Any `connectapi.garmin.com` endpoint, any method, extra headers — the escape hatch (`{displayName}` in the path is filled in; array query values repeat the parameter) |

### Endpoint cheat-sheet for `garmin_api_request`

A few of the many services behind `https://connectapi.garmin.com`:

| Service | Examples |
| --- | --- |
| `usersummary-service` | `/usersummary/daily/{displayName}?calendarDate=…`, `/stats/steps/daily/{start}/{end}` |
| `wellness-service` | `/wellness/dailySleepData/{displayName}?date=…`, `/wellness/dailyStress/{date}`, `/wellness/dailyHeartRate/{displayName}?date=…`, `/wellness/bodyBattery/reports/daily?startDate=…&endDate=…` |
| `hrv-service` | `/hrv/{date}`, `/hrv/daily/{start}/{end}` |
| `metrics-service` | `/metrics/trainingreadiness/{date}`, `/metrics/trainingstatus/aggregated/{date}`, `/metrics/trainingloadbalance/latest/{date}`, `/metrics/maxmet/daily/{start}/{end}`, `/metrics/racepredictions/latest/{displayName}` |
| `sleep-service`, `biometric-service` | `/stats/sleep/daily/{start}/{end}` (28-day max), `/biometric/latestLactateThreshold`, `/heartRateZones`, `/powerZones/sports/all`, `/stats/functionalThresholdPower/range/{start}/{end}?sport=CYCLING&aggregation=daily&aggregationStrategy=LATEST` |
| `activitylist-service`, `activity-service` | `/activities/search/activities?start=0&limit=20`, `/activity/{id}`, `/activity/{id}/details`, `/activity/{id}/splits` |
| `download-service` | `/files/activity/{id}` (FIT zip), `/export/gpx/activity/{id}` |
| `weight-service`, `bloodpressure-service` | `/weight/dateRange?startDate=…&endDate=…`, `/bloodpressure/range/{start}/{end}?includeAll=true` |
| `device-service`, `gear-service`, `workout-service` | `/deviceregistration/devices`, `/gear/filterGear?userProfilePk={profileId}`, `/workouts?start=0&limit=50`, `/workout/schedule/{id}` |
| `nutrition-service`, `gcs-golfcommunity`, `trainingplan-service` | `/food/logs/{date}`, `/api/v2/scorecard/summary?per-page=20&start=0`, `/trainingplan/plans` |
| `personalrecord-service`, `badge-service`, `goal-service` | `/personalrecord/prs/{displayName}`, `/badge/earned`, `/goal/goals?status=active` |
| `calendar-service` | `/year/2026/month/8` (month is zero-based; `garmin_workouts` takes a normal month number) |

## Maintenance

- **Sign in again** (after a password change, or if tools start reporting
  that Garmin refused to refresh the token): `node dist/index.js auth`.
- **"Garmin rate-limited every sign-in method"**: wait an hour or so (or use
  another network) and run `auth` again. Repeated attempts make it worse.
- **Revoke access:** change your Garmin password (invalidates the token)
  and/or delete `~/.garmin-mcp/`.
- **Rebuild after changing the source:** `cd garmin-mcp && npm run build`.
- **Run the tests:** `npm test` (offline; the sign-in cascade, token refresh,
  range chunking, downloads and the MCP server run against mocked Garmin
  responses).

Independent, unofficial integration. Not affiliated with or endorsed by
Garmin Ltd.
