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

### Deterministic budget analysis

Migration `037_deterministic_budget_analysis` advances the existing engine to
`dxg-av-pricing-engine.v3`; it does not introduce a second pricing engine.
Every new report records:

- `deterministic-budget.v1`;
- a stable approved-pricing release fingerprint;
- a stable approved-rule release fingerprint; and
- a structured budget analysis retained with that historical report.

Money stays in integer minor units. Multiplier stacks use scaled integer and
`BigInt` arithmetic, with bounded conversion only after rounding. The analysis
separates included, missing, confirmation-required, optional, and
possible-savings items. Unavailable rates keep the estimate incomplete and
never receive a fabricated value.

Breakdowns cover approved categories, equipment, labor, identified rooms, and
shared services. Aggregate package ranges may be allocated evenly to matching
room groups for review, and the allocation basis is always displayed. It is
not represented as a vendor quote or a room-specific approved rate.

Budget warnings cover currency mismatch, ranges above or overlapping a stated
ceiling, required zero-value categories, equipment without labor, and missing
setup/rehearsal/strike windows. A numerical impact appears only when it can be
derived from the same-currency approved range. Travel/accommodation, delivery,
venue, rigging, power, insurance, tax/service charge, and contingency remain
explicit estimated, venue-dependent, or unavailable components.

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
- Pricing comparison against submitted bids inside the analysis prompt;
  exportable client-presentable report; per-person units where authoritative
  attendee allocation is unavailable.
