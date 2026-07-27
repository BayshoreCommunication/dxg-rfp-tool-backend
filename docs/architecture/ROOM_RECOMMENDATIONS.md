# Room Specification Recommendations

> Purpose: architecture record for the review-first room recommendation capability. Added: 2026-07-27. Owner: AI engineering. Current status lives in `../PROJECT_STATE.md`.

## What it is

A separate, deterministic recommendation capability for the Room Specifications
step. It reads confirmed proposal facts and approved production knowledge,
classifies every generated value, and holds everything for field-level human
review. It does not extend extraction: `canonicalMapping.ts` still excludes
`rooms[]` from scalar candidate application, and this capability never treats
inference as evidence.

Pipeline: confirmed proposal facts → deterministic rules → approved knowledge
retrieval → validated `room-recommendation.v1` payload → field-level human
review → explicit selected application → proposal-version + room-identity
validation. There is **no model call** in this slice; the payload contract is
validated as strictly as if one existed so a future AI enrichment stage cannot
widen the shape.

## Trust boundary

> **Policy change (2026-07-27, product decision):** recommendations now apply
> **automatically into empty room fields** — the planner adjusts values in the
> form instead of approving each one first. This supersedes the original
> review-first gate for `recommended_assumption` values and extends the
> platform's existing empty-field auto-apply boundary (candidate application)
> to room recommendations, including assumptions below the 0.8 automatic
> confidence bar. Like the earlier auto-apply boundary move, **this should be
> flagged to DXG explicitly.** The invariants that remain non-negotiable:
> filled fields are never overwritten (skipped and reported), only allowlisted
> fields can be written, crew changes are `$addToSet` appends (never removals),
> version CAS and per-room identity checks still gate every write, and every
> automatic application is audit-recorded with its skipped paths. The manual
> review/apply endpoints remain available and unchanged.

- Generation is read-only against the proposal. A run is an immutable snapshot
  (`room_recommendation_runs.payload`); review and application always operate
  on what was generated, never a recomputation. Engine `room-rules.v2`
  (v2 = crew appends became apply-eligible and automatic application became
  the default flow; the engine version participates in the idempotency
  fingerprint so stale v1 payloads are not replayed).
- Every value carries exactly one classification:
  - `confirmed_fact` — reserved; the engine never emits it as a suggestion.
  - `deterministic_derivation` — entailed by selections (e.g. LED wall →
    LED-wall crew, passed-mic Q&A → handheld wireless mics). Mirrors the
    wizard's own crew auto-suggest logic.
  - `recommended_assumption` — bounded value from an approved knowledge entry
    (e.g. handheld mic count by attendance band). Always requires explicit
    human acceptance and must state its assumptions; the contract validator
    rejects an assumption without them.
  - `unknown` — never a value; missing room purpose/attendance and similar
    gaps surface as clarification questions instead of inventions.
- Application writes only fields on the explicit allowlist in
  `src/modules/roomRecommendation/applyAllowlist.ts` — the three
  wireless-microphone fields (`wirelessMics`, `wirelessMicsQty`,
  `wirelessMicsType`) as scalar sets, plus `showCrewNeeded` as an append-only
  crew-role operation validated against the wizard's closed role list.
  Reviewer edits (manual mode) pass the same normalizers as generated values;
  validation is never bypassed.
- Automatic mode (`POST .../applications` body `{"automatic": true}`) applies
  every allowlisted recommendation whose target is still empty; non-empty
  targets and rooms whose `roomFunction` changed since generation are skipped
  per item and reported in `skippedPaths`. If nothing is applicable the
  outcome is still recorded (selected_count 0) and the proposal version does
  not move.
- No pricing, venue availability, union, rigging or power values are ever
  generated (guarded by tests).
- Prompt-injection posture: room field text and knowledge notes are data.
  Rules compare against closed option lists and parse numbers/dates only;
  tests assert hostile text in room names, Q&A methods and knowledge notes
  cannot change values, classifications or the schema.

## Rule registry

`src/modules/roomRecommendation/rules.ts` — data objects with stable ids,
titles, descriptions and small evaluate functions, individually testable.

| Rule id | Effect |
|---|---|
| ROOM_CREW_AUDIO_A1_001 | Audio system → A1 (review-only crew suggestion) |
| ROOM_CREW_VIDEO_LED_001 | LED wall → V1, V2, Graphics Operator, TD |
| ROOM_CREW_CAMERA_OPS_001 | Cameras → Camera Operator |
| ROOM_CREW_TELEPROMPTER_001 | Teleprompter → Teleprompter Operator |
| ROOM_CREW_LIGHTING_L1_001 | Programmable lighting → L1 |
| ROOM_AUDIO_QA_001 | Passed-mic Q&A → handheld wireless mics; qty from knowledge, bounded by attendance |
| ROOM_RECORDING_CLARIFY_001 | Recording → questions: camera count, composition, media ownership |
| ROOM_SCHEDULE_END_001 | Show end ≤ show start → blocking warning |
| ROOM_SCHEDULE_LOADIN_001 | Load-in after show start → blocking warning |
| ROOM_ATTENDANCE_EXCEEDS_001 | Room attendance > event attendance → warning |
| ROOM_PURPOSE_MISSING_001 / ROOM_ATTENDANCE_MISSING_001 | Missing core facts → clarification questions; value-producing rules are suppressed for that room |
| ROOM_COUNT_MISMATCH_001 | Declared room count ≠ room modules → warning (proposal scope) |
| ROOM_HYBRID_CLARIFY_001 | Hybrid/virtual → questions: streaming platform, remote speakers, virtual production ownership (proposal scope) |

## Knowledge governance

`knowledgeProvider.ts` defines the provider interface (id, title,
applicability, guidance, exclusions, effective/expiry window, approval status,
provenance, organization scope). Only approved, in-window, tenant-visible
entries reach the engine. The current provider serves deterministic synthetic
fixtures (`provenance: synthetic:room-recommendation-fixture.v1`, including a
deliberately unapproved entry that tests prove is filtered out). A production
adapter backed by the existing knowledge-release or expert-rule stores can
replace it without touching the engine — this module deliberately does not
create a competing approval authority.

## API contract

All under `/api/v1`, session-authenticated, `proposal:read`/`proposal:write`,
rate-limited (60/15 min), RFC7807 errors. Flag: `ROOM_RECOMMENDATIONS_ENABLED`
(+ `AI_ENVIRONMENT`), dashboard mirror `NEXT_PUBLIC_ROOM_RECOMMENDATIONS_ENABLED`.

| Endpoint | Behavior |
|---|---|
| `POST /proposals/:id/room-recommendations` | Deterministic generation. Idempotent on an input fingerprint (proposal version + room/event/venue/hybrid facts + knowledge ids + engine version); an unchanged proposal returns the stored run (`created: false`). 201/200. |
| `GET  /proposals/:id/room-recommendations/latest` | Newest run with full payload. |
| `GET/PUT /proposals/:id/room-recommendations/:runId/review` | Field-level decisions (`accepted`/`edited`/`rejected`/`pending`), optimistic `revision` concurrency, enumerated reason codes, optional note. Edited values validate against the apply allowlist. |
| `POST /proposals/:id/room-recommendations/:runId/applications` | Explicit application of selected keys. Requires `Idempotency-Key`, `expectedProposalVersion` CAS against Mongo, per-room identity guard (`roomFunction` must still match the label captured at generation — ordinary wizard saves do not bump the proposal version, so the label guard is what catches renames/reorders), one selection per field, allowlisted paths only. Conflicts are persisted as `status='conflict'` application rows and returned as 409 `PROPOSAL_VERSION_CONFLICT` / `ROOM_IDENTITY_CONFLICT`. |

## Persistence (migration 030)

`room_recommendation_runs` (immutable payload + counts, unique
`(proposal_reference_id, input_checksum)`), `room_recommendation_reviews`
(revision CAS), `room_recommendation_decisions` (feedback record: suggested
value, decided value, classification, confidence, rule/knowledge ids,
`reason_code` — the schema's first enumerated reviewer-reason vocabulary —
note, engine version), `room_recommendation_applications` (audit of applied
and refused applications). All tenant-RLS'd; audit_events rows are written for
generate/review/apply. Feedback is stored as governed evaluation data only —
no automated training consumes it.

## Review and application flow (dashboard)

`components/proposals/RoomRecommendationsPanel.tsx`, mounted at the top of the
Room Specifications step for saved drafts. One card per room; classification
badges; confidence shown as a percentage with copy that avoids implying
certainty; "why" explanation, evidence chips, assumptions list; blocking and
warning states; clarification questions instead of recommendations when core
facts are missing; per-item Accept/Edit/Reject with reason codes; selective
apply of allowlisted items only; no accept-all control; duplicate-click
guards; version/identity-conflict recovery via a "Regenerate from the latest
proposal" action. After a successful apply the wizard re-seeds its local rooms
from the saved proposal (`refreshProposalAfterQuestion`).

## Evaluation methodology

`tests/room-recommendation.test.js` holds the synthetic scenario suite: small
executive meeting, single-room general session, general session + breakout,
hybrid conference, recorded keynote, union venue with unknown details,
short/invalid load-in windows, missing room purpose, conflicting attendance,
prompt-injection content, duplicate requests (deterministic repeatability and
fingerprint stability), and version-conflict input handling. Failure criteria
include: any unsupported equipment claim, any invented union/rigging/power
value, an assumption without stated assumptions, a payload that fails the
strict contract, or non-deterministic output for identical input.

## Current limitations / deferred

- Apply allowlist covers the three wireless-mic fields and append-only crew
  roles; every other room field remains read-only for recommendations.
- The knowledge provider is a synthetic fixture; production retrieval adapter
  (knowledge releases / expert rules) is unbuilt.
- No workflow-step projection; recommendations do not yet feed
  `proposalWorkflow` readiness facts.
- No AI enrichment stage. If added, it must run through the live-AI gateway
  with the attempt ledger (widen the `ai_provider_attempts.run_type` CHECK),
  emit into this same contract, and may only add explanations/prioritization —
  never new unvalidated values.
- **Fine-tuning is explicitly out of scope** and should only be considered
  after enough producer-reviewed decision rows exist to evaluate against.
  Pricing, venue availability, inventory and confidential client content stay
  in controlled retrieval or deterministic services, never model weights.
- Integration-suite (real Postgres) and tenant-isolation seeds for the new
  tables are not yet added to `tests-integration/`.
