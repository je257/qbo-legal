/**
 * Reference data returned by the ycharts_reference tool, derived from the
 * YCharts API v4 OpenAPI spec (https://api.ycharts.com/v4/openapi.json).
 * No API call is made — this is a local cheat sheet.
 */
export const REFERENCE = {
  api: {
    v4_base: "https://api.ycharts.com/v4",
    auth: "x-ychartsauthorization: <API key> header on every request. Keys: https://ycharts.com/api_v4 (API V4 Add-On required).",
    envelope:
      'Every JSON response is {"response": <body>, "meta": {"status": "ok"|"error", "url", ...}}; errors carry meta.error_code / meta.error_message. ' +
      "Bulk endpoints (indicators, model portfolio data) also return per-code/per-symbol error_code/error_message inside the body, so partial failures still return data.",
    pagination:
      "List endpoints take page (default 1) and page_size (default 100, max 1000; item-level endpoints like watchlist items, screener securities, timeseries table rows, quickflows max 500). " +
      "The response's pagination object has page, page_size, total_items, total_pages, next_page (null on the last page).",
    owner_type_filters:
      "Several list filters (owner, portfolio_type, edit_state, registration_type, registration_status, watchlist_type) use a packed boolean format: " +
      "'key:::value,,,key:::value' — triple colons between key and value, triple commas between pairs. Example owner filter: 'me:::true,,,public:::false,,,shared_with_me:::true'.",
  },
  security_id_conventions: {
    stocks_and_etfs: 'Plain ticker, e.g. "AAPL", "SPY".',
    mutual_funds: '"M:" prefix or bare fund ticker, e.g. "M:VFIAX" or "VFIAX".',
    indices: '"^" prefix, e.g. "^SPX", "^SPXTR".',
    indicators: '"I:" prefix, e.g. "I:USGDP", "I:USCPI". Discover codes with ycharts_indicators_search.',
    model_portfolios: '"P:" prefix + portfolio id, e.g. "P:12345".',
    cash: '"cash" or "$:CASH". Warning: bare uppercase "CASH" is the ticker of Pathward Financial, not a cash position.',
    custom_securities: '"Y:" prefix, e.g. "Y:12345".',
    other: 'With the relevant account features: separate accounts "S:" prefix, alternatives "A:" prefix, bonds as bare CUSIP.',
  },
  v4_endpoints: {
    funds: ["GET funds/{symbols} (1-25 fund/ETF symbols; rejects plain equities)", "GET funds/{symbol}/holdings (top 25 holdings)"],
    indicators: [
      "GET indicators (search; filters: region e.g. USA,CAN; source e.g. department_of_labor; category e.g. gdp,interest_rates; report e.g. house_price_index)",
      "GET indicators/{codes}/info/{fields} (fields e.g. security_name,description)",
      "GET indicators/{codes}/points?date=",
      "GET indicators/{codes}/series?start_date=&end_date=  (both REQUIRED; resample/fill/aggregate options)",
    ],
    fundamental_charts: [
      "POST fundamental_charts (renders PNG; query: securities 1-10, metrics, date_range|start_date+end_date, data_format, panel_layout; JSON body {overlays:[...]} required — [] for none; max 12 rendered items)",
      "POST fundamental_charts/downloads (multipart image upload -> temporary download_url)",
    ],
    model_portfolios: [
      "GET model_portfolios (filters: name, benchmark, watchlist_id, owner/portfolio_type/edit_state packed filters, sort_column name|label|owner_name|user_modify_date)",
      "POST model_portfolios/fixed (create: ModelPortfolio | ClientPortfolio | HouseholdPortfolio | BenchmarkPortfolio, discriminated by 'label')",
      "GET|PATCH model_portfolios/fixed/{portfolio_id} (PATCH body: portfolio_items and/or base_currency)",
      "GET model_portfolios/{portfolio_id}/status (available|calculating|needs_review|calc_scheduled|calc_failed + calc_progress)",
      "GET model_portfolios/{ids}/info/{fields}",
      "GET model_portfolios/{ids}/points/{calc_names}?date=   (calc names e.g. level, one_year_total_return)",
      "GET model_portfolios/{ids}/series/{calc_names}?start_date=&end_date=",
      "GET model_portfolios/{ids}/holdings?weight_type=target|current (weight_type REQUIRED)",
    ],
    screeners: [
      "GET screeners?screener_type=company|fund (REQUIRED)",
      "POST screeners (body: {name, screener_type, state})",
      "GET|PATCH screeners/{screener_type}/{screener_id} (GET pages the matching securities)",
      "POST screeners/{screener_type}/{screener_id}/watchlist (body {name}: saves matches as a watchlist)",
    ],
    security_lists: ["GET securitylists?query= (search all universe-filter lists: catalog, YCharts Proprietary, user's own saved lists)"],
    timeseries_tables: ["GET timeseries_tables", "POST timeseries_tables (body {name, state})", "GET|PATCH timeseries_tables/{id} (GET pages computed rows)"],
    watchlists: [
      "GET watchlists (filters incl. watchlist_type packed multi/indicator, security_ids)",
      "POST watchlists (body {name, watchlist_type: multi|indicator, security_ids})",
      "GET|PATCH watchlists/{id} (GET pages items; PATCH body {name?, security_ids?})",
    ],
    custom_pdf_reports: [
      "GET custom_pdf_reports",
      "GET custom_pdf_reports/{report_id}/generation_parameters (which params the report needs + supplemental IDs)",
      "POST custom_pdf_reports/{report_id}/generate (Accept application/json -> {report_url}, valid 1h; Accept application/pdf -> file)",
    ],
    registrations: [
      "GET registrations (filters: name, owner, registration_type household/client/joint/trust, registration_status active/lead/inactive, include_metrics)",
      "POST registrations | GET|PUT registrations/{id} (body: RegistrationParams)",
      "GET registrations/search/{households|registrations}?search_terms= (connected integration partner)",
      "POST registrations/import/{household|registration} (body: SerializedBookOfBusinessObject from search) -> background job",
    ],
    risk_profiles: ["GET risk_profiles", "GET risk_profiles/{id} (targets, ranges, financial metrics)"],
    quick_extract: [
      "POST quick_extract (multipart: file + weight_type Current|Dollars|Shares + multiple_accounts, or upload_session_id) -> extraction id",
      "GET quick_extract/{extraction_id} (status pending|running|completed|failed|canceled + extracted accounts/holdings)",
      "POST quick_extract/upload_sessions / GET quick_extract/upload_sessions/{session_id} (staging files from chat clients)",
    ],
    quickflows: ["GET quickflows_list", "PATCH quickflows_list (body {security_ids} — replaces the whole list)"],
    background_jobs: ["GET background_jobs/{job_id} (job status/progress, e.g. registration imports)"],
  },
  series_parameters_v4: {
    dates: 'YYYY-MM-DD, or "-N" for N periods back. Indicator series REQUIRE start_date and end_date.',
    resample_frequency: ["daily", "weekly", "monthly", "quarterly", "yearly"],
    resample_function: ["min", "max", "mean", "sum", "first", "last"],
    fill_method: ["backward", "forward", "no_fill"],
    aggregate_function: ["min", "max", "mean", "median", "sum", "std"],
    force_date_range: "boolean — peg/reindex the response to the supplied date range",
  },
  fundamental_chart_parameters: {
    securities: "1-10 comma-separated tickers or security names, resolved via YCharts security search",
    metrics: 'YCharts metric calc-names, e.g. "price,volume". Max 12 rendered items: single layout = securities x metrics + overlays; per_security layout = # metrics; per_metric = # securities.',
    date_range: ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "Max"],
    data_format: ["original", "normalized_pct_change", "growth_custom", "pct_off_high"],
    panel_layout: ["single", "per_metric", "per_security"],
    overlays: 'Up to 10, each {type: ratio|spread|correlation, security_a, security_b, metric_a, metric_b, lag_a?, lag_b? (correlation), weight_a?, weight_b? (spread)}. Requires the Advanced Charting feature.',
    omitted_series: "If a security doesn't report a metric (e.g. ETF pe_ratio), that pair is dropped and reported in the x-ycharts-omitted-series response header; the rest still renders.",
  },
  screener_state_format: {
    summary:
      "Screener state fields: metric_filters, securitylist_filters, exposure_filters (fund only), rating_filters (company only: 1-attractive|2-neutral|3-avoid|4-unrated), " +
      "only_primary_shares (boolean, NOT a security list), ordered_columns [{name, type: metric|infoField|customPeriod|score}], sort_column, sort_direction, page, pinned_security_ids.",
    metric_filter:
      '{left: [tokens], middle: between|equal|greater_than|greater_than_equal|less_than|less_than_equal|percentile_sequential|percentile_universe|rank_sequential|rank_universe, right: [tokens]}. ' +
      'Tokens are {val, type: symbol|keyword|metric|number|operator} (type inferable except symbol). Operators + - * / ( ) ^ build formulas, e.g. volume / average_volume_30 > 2.5.',
    securitylist_filter:
      '{group: multi|company|fund|indicator|index, method: add|intersect|exclude, name: <internal_name from ycharts_security_lists>, unidentified: true for new unverified names}. "multi" = watchlists.',
  },
  timeseries_table_state_format: {
    summary:
      "State fields: ordered_metrics (calc codes), ordered_info_fields, securitylist_security_ids (tickers like AAPL, M:VFIAX, ^SPX), securitylist_filters (same format as screeners), " +
      "pinned_rows [{securitylist_security_id, calc?}], data_format {frequency, aggregation first|last|max|mean|median|min|sum, fill_method backward|forward|no_fill}, " +
      "start_date/end_date as M/D/YYYY, items_per_page (date axis), page, sort_column, sort_column_type metric|infoField, sort_direction, summary_stats [avg|max|med|min|sum].",
  },
  model_portfolio_create_format: {
    summary:
      "Body is one of four shapes discriminated by 'label': model_portfolio, client_portfolio, household_portfolio, blended_benchmark. " +
      "Common required: name, level_type (custom|auto), start_of_series (oldest|newest|custom), items (min 1). " +
      "model_portfolio: + weight_type (Target|Current|Dollars|Shares), benchmark_id. client_portfolio: + tax_status (qualified|non_qualified), weight_type (Current|Dollars|Shares), benchmark_id. " +
      "household_portfolio: items are P:-prefixed portfolios only, Dollars weights, + benchmark_id. blended_benchmark: weight_type Target|Current. " +
      "Items: {security_id, target_weighting|current_weighting (0-1) | dollars_weighting | shares_weighting matching weight_type}.",
  },
  v3_legacy_api: {
    summary:
      "The raw security data endpoints (companies/stocks points, series, info, dividends, splits, spinoffs) are NOT part of v4 — they live in the v3 API " +
      "(https://api.ycharts.com/v3), exposed here as the ycharts_v3_* tools. v3 access is a separate entitlement; ycharts_status reports whether this key works there.",
    security_types: ["companies (stocks AND ETFs)", "mutual_funds (M: symbols)", "indicators (I: symbols)", "indices (^ symbols)"],
    common_company_metrics: ["price", "total_return_price", "volume", "market_cap", "enterprise_value", "pe_ratio", "ps_ratio", "pb_ratio", "dividend_yield", "eps_ttm", "revenues_ttm", "net_income_ttm", "shares_outstanding"],
    note: "v3 metric codes generally match YCharts web URL slugs (ycharts.com/companies/AAPL/pe_ratio -> pe_ratio). Unknown codes fail per-item, so testing one is cheap.",
  },
  terms_note: "Per YCharts' API terms, data is for the API customer's internal use only; redistribution requires YCharts' written consent.",
} as const;
