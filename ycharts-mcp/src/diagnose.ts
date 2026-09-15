import { YchartsClient, YchartsError } from "./ycharts.js";

export interface ProbeResult {
  probe: string;
  ok: boolean;
  status?: number;
  blockedField?: string;
  note: string;
}

export interface DiagnosticsReport {
  probes: ProbeResult[];
  summary: string[];
}

interface ProbeDef {
  name: string;
  run: (client: YchartsClient) => Promise<unknown>;
  onOk: string;
  onFail: string;
}

const PROBES: ProbeDef[] = [
  {
    name: "v4_auth (securitylists)",
    run: (c) => c.securityLists("s&p 500", 1, 1),
    onOk: "API key is valid for the v4 API.",
    onFail: "v4 API rejected the key — check the key itself before anything else.",
  },
  {
    name: "v4_screeners_list",
    run: (c) => c.listScreeners({ screener_type: "company", page_size: 1 }),
    onOk: "Saved screeners can be listed via v4.",
    onFail: "Screener listing failed on v4.",
  },
  {
    name: "v4_fund_data (SPY)",
    run: (c) => c.fundData(["SPY"]),
    onOk: "Fund/ETF data (incl. weighted fundamentals aggregates) is available via v4.",
    onFail: "Fund data endpoint failed on v4.",
  },
  {
    name: "v4_company_price_chart (NVDA price)",
    run: (c) =>
      c.request("POST", "/v4/fundamental_charts", {
        params: { securities: "NVDA", metrics: "price", date_range: "1M" },
        body: {},
      }),
    onOk: "v4 chart endpoint works for entitled fields (control probe).",
    onFail: "v4 chart endpoint failed even for 'price' — probe plumbing or key problem, not a field entitlement.",
  },
  {
    name: "v4_company_fundamental_chart (NVDA pe_ratio)",
    run: (c) =>
      c.request("POST", "/v4/fundamental_charts", {
        params: { securities: "NVDA", metrics: "pe_ratio", date_range: "1M" },
        body: {},
      }),
    onOk: "Company FUNDAMENTAL fields are licensed on v4 for this key.",
    onFail: "Company fundamental fields are NOT licensed on v4 (the known entitlement gap).",
  },
  {
    name: "v3_company_price (AAPL)",
    run: (c) => c.v3Points("companies", ["AAPL"], ["price"]),
    onOk: "v3 company data endpoint is LIVE for this key — raw per-stock numbers are retrievable.",
    onFail: "v3 company points endpoint is not accessible with this key.",
  },
  {
    name: "v3_company_pe_ratio (AAPL)",
    run: (c) => c.v3Points("companies", ["AAPL"], ["pe_ratio"]),
    onOk: "v3 serves company FUNDAMENTALS (pe_ratio) — the full scoring pipeline can run on raw API data.",
    onFail: "v3 rejected pe_ratio — fundamentals not licensed on v3 either.",
  },
  {
    name: "v3_company_market_cap (AAPL)",
    run: (c) => c.v3Points("companies", ["AAPL"], ["market_cap"]),
    onOk: "v3 serves market_cap — index-weight approximation can run on raw API data.",
    onFail: "v3 rejected market_cap.",
  },
  {
    name: "v3_company_info (AAPL next_earnings_release)",
    run: (c) => c.v3Info("companies", ["AAPL"], ["next_earnings_release"]),
    onOk: "v3 serves company info fields (earnings dates, sector, etc.).",
    onFail: "v3 company info endpoint is not accessible with this key.",
  },
];

/**
 * v3 can return HTTP 200 with per-symbol/per-calc errors nested in the body,
 * so a 200 alone is not proof the data came back. Flag bodies that contain
 * error statuses without any data arrays.
 */
function looksLikeNestedError(result: unknown): string | undefined {
  const text = JSON.stringify(result);
  if (!text) return undefined;
  const hasError = /"status"\s*:\s*"error"/.test(text) || /error_message/.test(text);
  const hasData = /"data"\s*:/.test(text) || /"results"\s*:/.test(text);
  if (hasError && !hasData) return "HTTP 200 but the body contains error statuses and no data.";
  return undefined;
}

export async function runDiagnostics(client: YchartsClient): Promise<DiagnosticsReport> {
  const probes: ProbeResult[] = [];
  for (const def of PROBES) {
    try {
      const result = await def.run(client);
      const nested = looksLikeNestedError(result);
      probes.push({
        probe: def.name,
        ok: !nested,
        note: nested ? `${def.onFail} ${nested}` : def.onOk,
      });
    } catch (err) {
      const e = err instanceof YchartsError ? err : new YchartsError(String(err));
      probes.push({
        probe: def.name,
        ok: false,
        status: e.status,
        blockedField: e.blockedField,
        note: `${def.onFail} (${e.message})`,
      });
    }
  }

  const byName = (name: string) => probes.find((p) => p.probe.startsWith(name));
  const summary: string[] = [];
  if (!byName("v4_auth")?.ok && !byName("v3_company_price")?.ok) {
    summary.push("KEY PROBLEM: neither v3 nor v4 accepted this API key.");
  }
  if (byName("v3_company_pe_ratio")?.ok) {
    summary.push(
      "BEST CASE CONFIRMED: v3 serves per-stock fundamentals with this key — screener exports are optional; the app can pull raw data directly.",
    );
  } else if (byName("v3_company_price")?.ok) {
    summary.push(
      "PARTIAL: v3 works but fundamentals are field-blocked — same entitlement gap as v4. Ask YCharts to license fundamental fields for API access.",
    );
  }
  const chartProbe = byName("v4_company_fundamental_chart");
  if (chartProbe?.ok) {
    summary.push("v4 company fundamentals are licensed — saved screeners with fundamental fields should also read via v4.");
  } else if (chartProbe?.blockedField) {
    summary.push(
      `v4 company fundamentals NOT licensed (field '${chartProbe.blockedField}' rejected) — ask YCharts to license company fundamental fields on this API key.`,
    );
  }
  const v3Price = byName("v3_company_price");
  if (!v3Price?.ok && v3Price?.status === 403) {
    summary.push(
      "v3 API rejected the key outright (HTTP 403): v3 access is a separate/legacy entitlement this key does not have. " +
        "If an older integration pulled raw per-stock data, it used a different key — worth asking YCharts about v3 access or a key that has it.",
    );
  }
  const blocked = probes.filter((p) => p.blockedField).map((p) => p.blockedField);
  if (blocked.length > 0) {
    summary.push(`Field-entitlement blocks observed on: ${[...new Set(blocked)].join(", ")}.`);
  }
  if (summary.length === 0) {
    summary.push("See per-probe notes above.");
  }
  return { probes, summary };
}
