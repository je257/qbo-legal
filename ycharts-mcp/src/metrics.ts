/**
 * Curated reference data returned by the ycharts_reference tool. This is a
 * convenience cheat sheet, not the authoritative list: the full metric
 * catalog depends on the YCharts subscription and lives in the account's
 * Export Metric Reference Guide and the API docs (ycharts.com/v4/docs).
 *
 * Unknown codes are cheap to test — YCharts returns per-symbol/per-metric
 * statuses inside an HTTP 200 response, so a bad code fails inline without
 * failing the whole call.
 */
export const REFERENCE = {
  how_to_use: [
    "Metric codes below are commonly used YCharts calculation codes. The authoritative list for this account is the Export Metric Reference Guide (YCharts web app > Support > API docs) and ycharts.com/v4/docs.",
    "If a code is uncertain, just try it: each symbol and metric gets its own status in the response, so bad codes fail individually and cheaply.",
    "Use ycharts_list_securities to discover symbols (with filters) when the exact ticker or indicator code is unknown.",
    "Max 100 symbols and 100 metric codes per request.",
  ],
  symbol_conventions: {
    companies_and_etfs: 'Plain exchange ticker, e.g. "AAPL", "MSFT", "BRK.B". ETFs are companies in YCharts, e.g. "SPY", "QQQ".',
    mutual_funds: 'Prefixed with "M:", e.g. "M:VFINX", "M:FCNTX".',
    indicators: 'Economic indicators are prefixed with "I:", e.g. "I:USICSA" (US initial jobless claims), "I:USRSGR" style codes. Discover exact codes with ycharts_list_securities type=indicators.',
    indices: 'Prefixed with "^", e.g. "^SPX" (S&P 500), "^DJI" (Dow Jones Industrial Average). Discover with ycharts_list_securities type=indices.',
  },
  common_metric_codes: {
    price_and_trading: ["price", "total_return_price", "volume", "average_volume_30", "market_cap", "enterprise_value", "shares_outstanding"],
    valuation: ["pe_ratio", "ps_ratio", "pb_ratio", "peg_ratio", "earnings_yield", "ev_ebitda"],
    income_statement: ["revenues", "revenues_ttm", "net_income", "net_income_ttm", "eps", "eps_ttm", "gross_profit_margin", "profit_margin", "operating_margin_ttm"],
    cash_and_returns: ["free_cash_flow", "free_cash_flow_ttm", "return_on_equity", "return_on_assets", "return_on_invested_capital"],
    balance_sheet: ["cash_and_equivalents", "total_assets", "total_liabilities", "debt_equity_ratio", "current_ratio"],
    dividends: ["dividend_yield", "dividend", "payout_ratio"],
    mutual_funds_and_etfs: ["price (NAV for funds)", "total_return_price", "expense_ratio", "dividend_yield"],
    indices: ["level (index level; some indices also support total_return variants)"],
    indicators: ["Indicator series usually expose a single primary value; check ycharts.com/v4/docs for the calc code (commonly the indicator itself is the series and codes like 'period_value' or 'level' apply). Verify with a cheap ycharts_points call."],
    note: "Codes generally match the metric slug in YCharts web URLs, e.g. ycharts.com/companies/AAPL/pe_ratio -> pe_ratio.",
  },
  common_info_fields: {
    companies: ["name", "exchange", "sector", "industry", "description"],
    mutual_funds: ["name", "category", "fund_family", "inception_date", "broad_asset_class"],
    indicators: ["name", "region", "source", "frequency"],
    indices: ["name"],
  },
  securities_list_filters: {
    companies: ["benchmark_index", "exchange", "hq_region", "incorporation_region", "industry", "is_lp", "is_reit", "is_shell", "naics_industry", "naics_sector", "sector"],
    mutual_funds: ["attribute", "benchmark_index", "broad_asset_class", "broad_category", "category", "domicile", "fund_manager", "fund_family", "fund_style", "legal_structure", "prospectus_objective", "share_class"],
    indicators: ["category", "region", "report", "source"],
    indices: ["(filters not documented in older API versions — try the same style, or page through unfiltered)"],
  },
  series_parameters: {
    start_date_end_date: 'ISO date "YYYY-MM-DD", or a negative integer meaning N periods back relative to the metric\'s own frequency (e.g. -5 on a quarterly metric = 5 quarters ago).',
    resample_frequency: ["daily", "weekly", "monthly", "quarterly", "yearly"],
    resample_function: ["mean", "min", "max", "first", "last", "sum"],
    fill_method: ["ffill (carry last value forward)", "bfill"],
    aggregate_function: ["mean", "sum", "min", "max — aggregates across the requested securities"],
  },
  terms_note:
    "Per YCharts' API terms, data is for the API customer's internal use only; redistribution or commercial reuse requires YCharts' written consent.",
} as const;
