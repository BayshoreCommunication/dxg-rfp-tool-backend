# M5 — Pricing Corpus, Investment Guidance and Vendor Analysis

**Flags:** `PRICING_CORPUS_ENABLED`, `INVESTMENT_GUIDANCE_ENABLED`, `VENDOR_ANALYSIS_ENABLED` (all also require `AI_ENVIRONMENT` authorization)
**Schema:** migration `020_pricing_and_vendor_analysis` (all tables RLS-forced)

## Pricing corpus (SOW Workstream 1)

- `pricing_records`: category/unit/low-mid-high minor amounts with currency,
  market, day type, labor role; optional provenance link to a knowledge
  fragment; draft → approved (independent `knowledge:approve`) → retired with
  optimistic revisions and audit events. Only **approved** records feed the
  engine.
- `expert_rules`: human-editable declarative heuristics —
  `conditions: [{path, op, value}]` over canonical proposal paths and
  `effect: {kind: recommendation | cost_factor | ancillary_flag, ...}` —
  draft → active → retired, versioned, audited. No code deploy needed to add
  or correct a rule.

## Investment guidance (SOW Workstream 3)

Deterministic range engine (`src/modules/investment/domain.ts`), no model
calls: line items are aggregated from approved records scaled by quantity
drivers (event days, room count), cost-factor rules adjust matching lines,
and every number carries provenance (`pricingRecordIds`, `ruleIds`,
`drivers`). Core categories without corpus support become explicit
**refusals** ("cannot support a defensible range") with a concrete ask —
fabricated numbers are structurally impossible. Ancillary factors (trucking,
travel, venue fees, rigging, power, insurance, service charges, union labor)
are surfaced with honest statuses: estimated / venue_dependent / no_data.
Reports persist to `investment_guidance_reports`.
Endpoints: `POST/GET /api/v1/proposals/:id/investment-guidance-reports(/latest)`.

## Vendor analysis (SOW Workstream 4, MVP)

Durable job `vendor_response_analyze`: requirements are derived
deterministically from the proposal's filled canonical fields (+ room specs),
vendor evidence = response message + parsed private documents, and
`liveVendorResponseAnalysis` produces cited findings under a strict schema:
compliance verdicts per requirement, pricing/production flags, vendor
questions — each with confidence and a `needsHumanReview` escalation flag
(the SOW's "producer reviews flags, not proposals" objective). Citations are
whitelist-validated against vendor evidence ids; requirement paths validated
against the derived list. Results persist to `vendor_analysis_runs` +
`vendor_analysis_findings`.
Endpoints: `POST /api/v1/vendor-responses/:id/analysis-jobs`,
`GET .../analysis-runs/latest|:runId` (owner-scoped via the proposal).

## Deferred

- Attempt-ledger coverage for the vendor-analysis operation (needs widening
  the migration-016 `run_type` CHECK).
- Pricing comparison against other submitted bids and guidance ranges inside
  the analysis prompt; exportable client-presentable report; per-person and
  per-hour units in the range engine (need attendee counts / labor schedules).
