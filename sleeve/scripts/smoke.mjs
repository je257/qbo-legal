// Offline smoke test for the drift engine (no API key or network needed).
// Run after `npm run build`: node scripts/smoke.mjs
import { bandFor, computeDrift, formatDriftReport, parseHoldings } from "../dist/engine.js";

let failures = 0;
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}

const bands = [
  { minTargetWeightPct: 5, maxRelativeDriftPct: 20 },
  { minTargetWeightPct: 2, maxRelativeDriftPct: 35 },
  { minTargetWeightPct: 1, maxRelativeDriftPct: 50 },
  { minTargetWeightPct: 0, maxRelativeDriftPct: 75 },
];

check("band: 7% target -> 20% band", bandFor(7, bands) === 20);
check("band: 3% target -> 35% band", bandFor(3, bands) === 35);
check("band: exactly 5% -> 20% band", bandFor(5, bands) === 20);
check("band: 0.4% target -> 75% band", bandFor(0.4, bands) === 75);

const target = parseHoldings([
  { security_id: "NVDA", name: "NVIDIA", weight: "7.000000" },
  { security_id: "MSFT", name: "Microsoft", weight: "6.000000" },
  { security_id: "DKS", name: "Dick's", weight: "1.000000" },
  { security_id: "TINY", name: "Tiny Co", weight: "0.500000" },
]);
const current = parseHoldings([
  { security_id: "NVDA", name: "NVIDIA", weight: "8.500000" }, // +21.4% rel -> breach at 20%
  { security_id: "MSFT", name: "Microsoft", weight: "6.90" }, // +15% rel -> inside 20%
  { security_id: "DKS", name: "Dick's", weight: "0.40" }, // -60% rel -> breach at 50%
  { security_id: "TINY", name: "Tiny Co", weight: "0.80" }, // +60% rel -> inside 75%
  { security_id: "SPUN", name: "Spinoff", weight: "0.30" }, // untargeted -> flagged
]);

const rows = computeDrift(target, current, bands);
const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));

check("NVDA relative drift ~ +21.4%", Math.abs(byTicker.NVDA.relativeDriftPct - 21.428) < 0.01);
check("NVDA breaches its 20% band", byTicker.NVDA.breach === true);
check("MSFT +15% inside 20% band", byTicker.MSFT.breach === false);
check("DKS -60% breaches 50% band", byTicker.DKS.breach === true && Math.abs(byTicker.DKS.relativeDriftPct + 60) < 0.01);
check("TINY +60% inside 75% band", byTicker.TINY.breach === false);
check("untargeted SPUN flagged", byTicker.SPUN.breach === true && byTicker.SPUN.tradeToTargetPct === -0.3);
check("NVDA trade-to-target -1.5pp", Math.abs(byTicker.NVDA.tradeToTargetPct + 1.5) < 1e-9);
check("breaches sort first", rows[0].breach === true);

const report = formatDriftReport(rows, "2026-09-15");
check("report names the as-of date", report.includes("2026-09-15"));
check("report counts 3 breaches", report.includes("Breaches: 3"), report.split("\n")[1]);

console.log(failures === 0 ? "\nSmoke test: all checks passed." : `\nSmoke test: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
