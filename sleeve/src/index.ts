#!/usr/bin/env node
import { loadSettings } from "./config.js";
import { computeDrift, formatDriftReport, parseHoldings } from "./engine.js";
import { YchartsClient, YchartsError } from "./ycharts.js";

const command = process.argv[2] ?? "help";
const arg = process.argv[3];

function fail(error: unknown): never {
  console.error(error instanceof YchartsError ? error.message : String(error));
  process.exit(1);
}

function resolvePortfolioId(): number {
  const settings = loadSettings();
  const id = arg ? Number(arg) : settings.portfolioId;
  if (!id || !Number.isFinite(id)) {
    throw new Error(
      "No portfolio id. Set portfolioId in sleeve/sleeve.config.json, or pass one: node dist/index.js drift <id>\n" +
        "Find yours with: node dist/index.js portfolios",
    );
  }
  return id;
}

async function listPortfolios(): Promise<void> {
  const client = YchartsClient.load();
  const result = await client.modelPortfolios({
    owner: "me:::true,,,shared_with_me:::false,,,public:::false",
    page_size: 100,
    name: arg,
  });
  const rows: any[] = result?.response?.results ?? [];
  console.log(`Your model portfolios (${rows.length} shown):\n`);
  for (const p of rows) {
    console.log(
      `${String(p.id).padEnd(10)} ${String(p.name).slice(0, 48).padEnd(50)} ${String(p.model_portfolio_type ?? "").padEnd(8)} bench=${p.benchmark_symbol ?? "—"}  perf through ${p.latest_performance_date ?? "—"}`,
    );
  }
  console.log("\nSet the sleeve's id as portfolioId in sleeve/sleeve.config.json.");
}

async function runDrift(): Promise<void> {
  const settings = loadSettings();
  const id = resolvePortfolioId();
  const client = YchartsClient.load();
  const [targetRes, currentRes, infoRes] = await Promise.all([
    client.holdings(id, "target"),
    client.holdings(id, "current"),
    client.info(String(id), ["security_name", "latest_performance_date"]).catch(() => undefined),
  ]);
  const target = parseHoldings(targetRes?.response?.[String(id)]?.results ?? targetRes?.response?.holdings ?? []);
  const current = parseHoldings(currentRes?.response?.[String(id)]?.results ?? currentRes?.response?.holdings ?? []);
  if (target.length === 0 || current.length === 0) {
    console.log("Raw target response keys:", JSON.stringify(Object.keys(targetRes?.response ?? {})));
    throw new Error(`Could not read holdings for portfolio ${id} — check the id with: node dist/index.js portfolios`);
  }
  const infoBlock = infoRes?.response?.[String(id)]?.results ?? infoRes?.response?.[String(id)];
  const asOf = infoBlock?.latest_performance_date?.data ?? infoBlock?.latest_performance_date;
  const rows = computeDrift(target, current, settings.driftBands);
  console.log(formatDriftReport(rows, typeof asOf === "string" ? asOf : undefined));
}

async function runCharacteristics(): Promise<void> {
  const settings = loadSettings();
  const id = resolvePortfolioId();
  const client = YchartsClient.load();

  const [pointsRes, fundRes] = await Promise.all([
    client.points(String(id), settings.characteristicsCalcs),
    client.fundData([settings.benchmark.fundProxy]),
  ]);
  const calcBlock = pointsRes?.response?.[String(id)]?.results ?? {};
  const fund = fundRes?.response?.[settings.benchmark.fundProxy] ?? fundRes?.response ?? {};

  const pick = (obj: any, key: string): string => {
    const entry = obj?.[key];
    const value = entry?.data ?? entry?.value ?? entry;
    const n = Number(Array.isArray(value) ? value[1] : value);
    return Number.isFinite(n) ? n.toFixed(2) : "—";
  };

  console.log(`Sleeve (portfolio ${id}) vs ${settings.benchmark.fundProxy}:\n`);
  console.log(`METRIC                          SLEEVE     ${settings.benchmark.fundProxy}`);
  const pairs: [string, string, string][] = [
    ["Weighted avg P/E", "weighted_average_pe_ratio", "weighted_average_pe_ratio_generic"],
    ["Weighted avg P/B", "weighted_average_price_to_book_ratio_generic", "weighted_average_price_to_book_ratio_generic"],
    ["Avg market cap ($M)", "average_market_cap_generic", "average_market_cap_generic"],
    ["Payout ratio", "dividend_payout_ratio_generic", "—"],
    ["YTD total return %", "ytd_total_return", "—"],
    ["% in top 10 holdings", "percent_of_assets_in_top_10_holdings", "percent_of_assets_in_top_10_holdings"],
    ["Holdings count", "number_of_holdings_generic", "—"],
    ["Drift (aggregate)", "drift", "—"],
  ];
  for (const [label, sleeveKey, fundKey] of pairs) {
    console.log(
      `${label.padEnd(30)} ${pick(calcBlock, sleeveKey).padStart(8)}   ${fundKey === "—" ? "     —" : pick(fund, fundKey).padStart(8)}`,
    );
  }

  try {
    const sectorRes = await client.points(String(id), settings.sectorCalcs);
    const sectorBlock = sectorRes?.response?.[String(id)]?.results ?? {};
    console.log(`\nSector exposures (Morningstar taxonomy), %:`);
    for (const code of settings.sectorCalcs) {
      console.log(`  ${code.padEnd(26)} ${pick(sectorBlock, code).padStart(8)}`);
    }
    console.log(
      `\nBenchmark sector weights need a market-cap source (screener export or field entitlement) — pending.`,
    );
  } catch (err) {
    console.log(`\nSector exposure calcs unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}).`);
    console.log(`Adjust sectorCalcs in sleeve.config.json if YCharts uses different calc codes.`);
  }
}

async function runUniverse(): Promise<void> {
  const settings = loadSettings();
  const client = YchartsClient.load();
  const tickers: string[] = [];
  let page = 1;
  for (;;) {
    const result = await client.screener(settings.universeScreenerId, page, 500);
    for (const s of result?.response?.securities ?? []) tickers.push(s.display_security_id);
    const next = result?.response?.pagination?.next_page;
    if (!next) break;
    page = next;
  }
  console.log(tickers.join("\n"));
  console.error(`\n${tickers.length} constituents from screener ${settings.universeScreenerId}.`);
}

async function runSpyTop(): Promise<void> {
  const settings = loadSettings();
  const client = YchartsClient.load();
  const result = await client.fundHoldings(settings.benchmark.fundProxy);
  const holdings: any[] = result?.response?.holdings ?? [];
  let sum = 0;
  console.log(`${settings.benchmark.fundProxy} top holdings (exact index weights for the mega caps):\n`);
  for (const h of holdings) {
    const w = Number(h.weight);
    sum += w;
    console.log(`${String(h.security_id).padEnd(8)} ${String(h.name).slice(0, 40).padEnd(42)} ${w.toFixed(4)}%`);
  }
  console.log(`\nTop ${holdings.length} cover ${sum.toFixed(2)}% of the fund.`);
}

switch (command) {
  case "portfolios":
    listPortfolios().catch(fail);
    break;
  case "drift":
    runDrift().catch(fail);
    break;
  case "characteristics":
    runCharacteristics().catch(fail);
    break;
  case "universe":
    runUniverse().catch(fail);
    break;
  case "spy-top":
    runSpyTop().catch(fail);
    break;
  default:
    console.log(
      `HW sleeve manager. Usage: node dist/index.js <command>\n\n` +
        `  portfolios [name]     List your YCharts model portfolios (find the sleeve's id)\n` +
        `  drift [id]            Daily drift check: target vs current weights vs your bands\n` +
        `  characteristics [id]  Sleeve vs benchmark: valuation, returns, concentration, sectors\n` +
        `  universe              Print current S&P 500 constituents (503, incl. share classes)\n` +
        `  spy-top               Exact top-25 index weights via SPY holdings\n\n` +
        `Configure sleeve/sleeve.config.json (portfolio id, drift bands, benchmark).\n` +
        `API key: shared with ycharts-mcp (~/.ycharts-mcp/config.json or YCHARTS_API_KEY).`,
    );
}
