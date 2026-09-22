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
connector signs in the same way the Garmin Connect mobile app does — Garmin
SSO with your email and password (and MFA code if enabled), then an OAuth1 →
OAuth2 token exchange — and calls the same `connectapi.garmin.com` endpoints
the app uses. This is the approach used by the open-source
[`garth`](https://github.com/matin/garth),
[`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) and
[GarminDB](https://github.com/tcgoetz/GarminDB) projects, ported to Node with
no extra dependencies.

Consequences worth knowing:

- Your password is used once, to sign in, and is **not stored**. The resulting
  sign-in token lasts about a year; the hourly access token renews itself.
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
  land in `~/.garmin-mcp/tokens.json` (mode 600). The OAuth consumer key the
  Garmin app uses is fetched once from the same public location `garth`
  uses and cached in `~/.garmin-mcp/config.json`.
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

Read-only unless noted. Dates are `YYYY-MM-DD` and default to today.

| Tool | What it does |
| --- | --- |
| `garmin_auth_status` | Signed-in account, region, token expiry |
| `garmin_profile` | Social profile + user settings (birth date, height, weight, VO2 max, HR/power zones, goals, units) |
| `garmin_daily_summary` | One day's roll-up: steps, distance, floors, calories, intensity minutes, HR, stress, Body Battery, sleep seconds, SpO2, respiration |
| `garmin_wellness` | Per-day detail by `metric`: sleep, heartRate, stress, bodyBattery, hrv, spo2, respiration, intensityMinutes, floors, hydration, stepsChart, weighIns, menstrualCycle, pregnancy, dailyEvents |
| `garmin_trend` | Day-by-day series over a range by `metric`: steps, stress, intensityMinutes, hydration, sleepScore, hrv, bodyBattery, restingHeartRate, vo2max, racePredictions, enduranceScore, hillScore, weight, bloodPressure, menstrualCalendar (long ranges auto-chunked) |
| `garmin_training` | Training Readiness, Training Status/load, VO2 max, race predictions, endurance score, hill score, fitness age |
| `garmin_activities` | List/search activities by date, type, or name (compact by default) |
| `garmin_activity_types` | Garmin's activity type keys |
| `garmin_activity` | One activity by `section`: summary, details (time series + GPS), splits/laps, typedSplits, splitSummaries, weather, hrZones, powerZones, exerciseSets, gear |
| `garmin_download_activity` | Save the original FIT (unzipped), or TCX/GPX/KML/CSV, to disk |
| `garmin_activity_stats` | Totals (distance, duration, calories, elevation…) over a period, by activity type |
| `garmin_personal_records` | All PRs |
| `garmin_badges` | Earned/available badges and challenges |
| `garmin_goals` | Active/future/past goals |
| `garmin_gear` | Gear list, per-gear totals and activities, defaults per activity type |
| `garmin_devices` | Registered devices, last used, primary training device, full device settings, solar data |
| `garmin_workouts` | Saved structured workouts, full definition, FIT download |
| `garmin_log_weight` | *Write:* add a manual weight entry |
| `garmin_log_blood_pressure` | *Write:* add a blood pressure reading |
| `garmin_log_hydration` | *Write:* add water intake |
| `garmin_update_activity` | *Write:* rename, describe, or retype an activity |
| `garmin_api_request` | Any `connectapi.garmin.com` endpoint, any method — the escape hatch (`{displayName}` in the path is filled in) |

### Endpoint cheat-sheet for `garmin_api_request`

A few of the many services behind `https://connectapi.garmin.com`:

| Service | Examples |
| --- | --- |
| `usersummary-service` | `/usersummary/daily/{displayName}?calendarDate=…`, `/stats/steps/daily/{start}/{end}` |
| `wellness-service` | `/wellness/dailySleepData/{displayName}?date=…`, `/wellness/dailyStress/{date}`, `/wellness/dailyHeartRate/{displayName}?date=…`, `/wellness/bodyBattery/reports/daily?startDate=…&endDate=…` |
| `hrv-service` | `/hrv/{date}`, `/hrv/daily/{start}/{end}` |
| `metrics-service` | `/metrics/trainingreadiness/{date}`, `/metrics/trainingstatus/aggregated?date=…`, `/metrics/maxmet/daily/{start}/{end}`, `/metrics/racepredictions/latest/{displayName}` |
| `activitylist-service`, `activity-service` | `/activities/search/activities?start=0&limit=20`, `/activity/{id}`, `/activity/{id}/details`, `/activity/{id}/splits` |
| `download-service` | `/files/activity/{id}` (FIT zip), `/export/gpx/activity/{id}` |
| `weight-service`, `bloodpressure-service` | `/weight/dateRange?startDate=…&endDate=…`, `/bloodpressure/range/{start}/{end}?includeAll=true` |
| `device-service`, `gear-service`, `workout-service` | `/deviceregistration/devices`, `/gear/filterGear?userProfilePk=…`, `/workouts?start=0&limit=50` |
| `personalrecord-service`, `badge-service`, `goal-service` | `/personalrecord/prs/{displayName}`, `/badge/earned`, `/goal/goals?status=active` |
| `calendar-service` | `/year/2026/month/8` (month is zero-based) |

## Maintenance

- **Sign in again** (after ~1 year, a password change, or if tools start
  returning 401/403): `node dist/index.js auth`.
- **Revoke access:** change your Garmin password (invalidates the token)
  and/or delete `~/.garmin-mcp/`.
- **Rebuild after changing the source:** `cd garmin-mcp && npm run build`.

Independent, unofficial integration. Not affiliated with or endorsed by
Garmin Ltd.
