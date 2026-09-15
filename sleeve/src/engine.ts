import type { DriftBand } from "./config.js";

export interface Holding {
  security_id: string;
  name: string;
  weight: number; // percent, 0-100
}

export interface DriftRow {
  ticker: string;
  name: string;
  targetPct: number;
  currentPct: number;
  relativeDriftPct: number | null; // (current - target) / target * 100
  bandPct: number;
  utilization: number | null; // |relativeDrift| / band, 1.0 = at the edge
  breach: boolean;
  tradeToTargetPct: number; // target - current, in portfolio percentage points
}

export function parseHoldings(raw: { security_id: string; name: string; weight: string | number }[]): Holding[] {
  return raw.map((h) => ({ security_id: h.security_id, name: h.name, weight: Number(h.weight) }));
}

export function bandFor(targetPct: number, bands: DriftBand[]): number {
  // bands are sorted by minTargetWeightPct descending (loadSettings guarantees it)
  for (const band of bands) {
    if (targetPct >= band.minTargetWeightPct) return band.maxRelativeDriftPct;
  }
  return bands[bands.length - 1]?.maxRelativeDriftPct ?? 75;
}

export function computeDrift(target: Holding[], current: Holding[], bands: DriftBand[]): DriftRow[] {
  const currentById = new Map(current.map((h) => [h.security_id, h]));
  const seen = new Set<string>();
  const rows: DriftRow[] = [];

  for (const t of target) {
    seen.add(t.security_id);
    const c = currentById.get(t.security_id);
    const currentPct = c?.weight ?? 0;
    const relativeDriftPct = t.weight > 0 ? ((currentPct - t.weight) / t.weight) * 100 : null;
    const bandPct = bandFor(t.weight, bands);
    const utilization = relativeDriftPct === null ? null : Math.abs(relativeDriftPct) / bandPct;
    rows.push({
      ticker: t.security_id,
      name: t.name,
      targetPct: t.weight,
      currentPct,
      relativeDriftPct,
      bandPct,
      utilization,
      breach: utilization !== null && utilization > 1,
      tradeToTargetPct: t.weight - currentPct,
    });
  }

  // Positions present in current but absent from target (e.g. spin-offs, cash residue)
  for (const c of current) {
    if (seen.has(c.security_id)) continue;
    rows.push({
      ticker: c.security_id,
      name: c.name,
      targetPct: 0,
      currentPct: c.weight,
      relativeDriftPct: null,
      bandPct: bandFor(0, bands),
      utilization: null,
      breach: c.weight > 0.05, // an untargeted position over 5bps needs attention
      tradeToTargetPct: -c.weight,
    });
  }

  rows.sort((a, b) => (b.utilization ?? (b.breach ? Infinity : -1)) - (a.utilization ?? (a.breach ? Infinity : -1)));
  return rows;
}

const num = (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "—");

export function formatDriftReport(rows: DriftRow[], asOf: string | undefined): string {
  const breaches = rows.filter((r) => r.breach);
  const lines: string[] = [];
  lines.push(`Drift check${asOf ? ` (data as of ${asOf})` : ""}`);
  lines.push(`Positions: ${rows.length} | Breaches: ${breaches.length}`);
  lines.push("");
  const header = "TICKER      TARGET%  CURRENT%  RELDRIFT%   BAND%   USED%  ACTION";
  const fmt = (r: DriftRow) =>
    [
      r.ticker.padEnd(10),
      num(r.targetPct).padStart(8),
      num(r.currentPct).padStart(9),
      (r.relativeDriftPct === null ? "—" : num(r.relativeDriftPct, 1)).padStart(10),
      num(r.bandPct, 0).padStart(7),
      (r.utilization === null ? "—" : num(r.utilization * 100, 0)).padStart(7),
      `  ${r.tradeToTargetPct >= 0 ? "buy " : "sell"} ${num(Math.abs(r.tradeToTargetPct))}pp`,
    ].join("");
  if (breaches.length > 0) {
    lines.push("BREACHES — pull these back into their comfort zone:");
    lines.push(header);
    for (const r of breaches) lines.push(fmt(r));
    lines.push("");
  } else {
    lines.push("No drift-band breaches.");
    lines.push("");
  }
  lines.push("Closest to the edge (top 10 by band utilization):");
  lines.push(header);
  for (const r of rows.filter((r) => !r.breach).slice(0, 10)) lines.push(fmt(r));
  return lines.join("\n");
}
