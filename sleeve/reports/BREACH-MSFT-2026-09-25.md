# HW Stock Sleeve — standing breach alert: MSFT

**Status as of 2026-11-11: UNDELIVERED BY EMAIL, UNRESOLVED.** This file is the
durable copy of the alert the daily monitor has been trying to email to
je@hwexec.com, john.ginn@nm.com and carson.abney@nm.com since 2026-09-28.
Every Gmail send attempt has stalled on an in-app permission approval that no
one has answered (the session runs unattended); phone push notifications were
sent 10/19, 10/22, 10/27, 11/2 and 11/9.

## Breach

MSFT exceeded its ±25% relative drift band at the **2026-09-25 close** and has
remained in breach at every verified close since. Figures below are from the
**2026-10-05 close**, the last verified data: the YCharts connector lost its
authorization on ~10/6 and needs to be re-authorized (claude.ai → Settings →
Connectors → YCharts), so closes after 10/5 are unverified.

| Field | Value |
|---|---|
| Ticker | MSFT (Microsoft Corp.) |
| Target weight | 5.70% |
| Current weight | 7.32% |
| Relative drift | +28.4% (band ±25%) |
| Band utilization | 114% |
| Trade to target | SELL 1.62% of portfolio value |

Band-utilization history: 9/25: 109% · 9/28: 104% · 9/29: 104% · 10/5: 114%

## Closest to their bands (no breach, 2026-10-05 close)

| Ticker | Target | Current | Rel. drift | Band | Used |
|---|---|---|---|---|---|
| DKS | 1.25% | 0.80% | −36.0% | 45% | 80% |
| NVDA | 6.50% | 7.80% | +20.0% | 25% | 80% |
| PANW | 2.50% | 3.08% | +23.4% | 30% | 78% |
| META | 3.63% | 4.39% | +20.8% | 30% | 69% |
| LRCX | 1.50% | 1.96% | +30.7% | 45% | 68% |

## Mode

REPORT-ONLY MODE: no changes have been made to the portfolio. Auto-rebalance
is pending final verification. To execute this reset, tell Claude in the
project session, or trade manually.

A rebalance resets all 52 positions to target (per `sleeve/drift-bands.json`);
the dated upload file for the dynamic portfolio (P:1746345) is generated with
`sleeve/scripts/make_dynamic_upload.py` and emailed with the rebalance report.

## To restore the monitor

1. Re-authorize the **YCharts** connector (claude.ai → Settings → Connectors) —
   daily checks resume automatically at the next weekday 13:33 UTC trigger.
2. Open the sleeve session and **approve the pending Gmail send** so the alert
   reaches all three recipients (or confirm it is no longer wanted).
