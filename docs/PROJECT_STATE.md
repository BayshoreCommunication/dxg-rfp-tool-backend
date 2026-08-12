# RFPilot AI — Project State & Handoff

**Last updated:** 2026-08-12 · **Branch:** proposal-intelligence delivery branches · **Status:** audit roadmap M1–M6 complete, governed proposal creation and Platform Assistant shipped, and Proposal Intelligence Task 2 submission versioning implemented for review.

This is the single document to read before picking the project up. It records
what exists, why it is built the way it is, what is deliberately not done, and
what is owed to the client. Start with `docs/README.md`; the current system map
is `docs/ARCHITECTURE.md`, with component history under `docs/architecture/`.
This file remains the authority for current implementation status.

---

## 1. What the product is

RFPilot lets event planners create AV production RFPs, send them to vendors,
and review responses. The work in this repo is the **AI Intelligence Layer**
from the client SOW (`RFPilot-AI-Scope-of-Work.pdf`), whose four workstreams
are: a knowledge/pricing foundation, in-build recommendations, an investment
guidance engine, and vendor proposal analysis.

The intended experience — confirmed against a reference video from the client —
is a ChatGPT/Claude-style workspace: upload files or type details, get
requirements extracted, answer a few high-impact questions, receive a cited
draft plus readiness and investment guidance, then publish. Humans keep control
of publication.

### Three repositories

| Repo | Role | Stack |
|---|---|---|
| `dxg-rfp-tool-backend` | REST API, workers, all AI | Express, TypeScript, MongoDB + PostgreSQL(+pgvector) + Redis, S3 |
| `dxg-rfp-tool-dashboard` | Planner app | Next.js 16 App Router, NextAuth v5, Tailwind |
| `dxg-rfp-tool-admin` | Back office (knowledge, pricing, users) | Next.js 16 |

---

## 2. How to run it

```bash
# backend — three processes, all required for AI features
npm run dev            # API (nodemon)
npm run dev:worker     # durable job worker  (nodemon; prod uses worker:source-security)
npm run dev:dispatcher # outbox -> Redis     (nodemon; prod uses worker:dispatcher)

# dashboard / admin
npm run dev
```

Infrastructure: MongoDB, PostgreSQL 16 + pgvector, Redis, an S3-compatible
private bucket, and optionally ClamAV on `CLAMAV_HOST:3310`.

**Gotcha that cost real debugging time:** the API reloads on save, the workers
historically did not, so backend changes applied on some paths and not others.
Use the `dev:` variants. Production keeps the plain scripts because nodemon is
a devDependency (PM2 runs all three; see `docs/runbooks/PRODUCTION.md`).

### Feature flags

Everything AI is deny-by-default. `AI_ENVIRONMENT` (`test|staging|production`)
authorizes the runtime; unset falls back to the historical `NODE_ENV==="test"`
behaviour. On top of that: `CONVERSATIONS_ENABLED`, `PROPOSAL_CONTEXT_ENABLED`,
`PROPOSAL_DRAFT_ENABLED`, `CANDIDATE_APPLICATION_ENABLED`,
`PROPOSAL_WORKFLOW_ENABLED`, `KNOWLEDGE_*`, `GUIDANCE_ENABLED`,
`INVESTMENT_GUIDANCE_ENABLED`, `HISTORICAL_INSIGHTS_ENABLED`, `PRICING_CORPUS_ENABLED`,
`VENDOR_ANALYSIS_ENABLED`, `CONVERSATION_EXTRACTION_ENABLED`,
`ROOM_RECOMMENDATIONS_ENABLED`, `LIVE_AI_*` (+ kill switches). Dashboard
mirrors: `NEXT_PUBLIC_CONVERSATIONS_ENABLED`,
`NEXT_PUBLIC_PROPOSAL_WORKFLOW_ENABLED`, `NEXT_PUBLIC_VENDOR_ANALYSIS_ENABLED`,
`NEXT_PUBLIC_CONVERSATION_EXTRACTION_ENABLED`,
`NEXT_PUBLIC_ROOM_RECOMMENDATIONS_ENABLED`,
`NEXT_PUBLIC_AI_ASSISTANT_ENABLED`; admin: `NEXT_PUBLIC_PRICING_ENABLED`.

**`.env.local` overrides `.env`** (`config/env.ts` loads it second with
`override: true`). Reading only `.env` will tell you live AI is off when it is
on — that misread shaped a whole review cycle.

The Platform Assistant additionally requires `AI_ASSISTANT_ENABLED=true` and
an organization allowed by `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS`; production
fails closed when that cohort is absent or invalid. New messages additionally
require `AI_ASSISTANT_KILL_SWITCH=false`. Its runtime model remains the
approved baseline unless `AI_ASSISTANT_MODEL` is explicitly promoted.

Model is pinned to the dated snapshot `gpt-5.4-mini-2026-03-17`.

---

## 3. What was built (milestones M1–M6)

Delivered against an independent audit of the original codebase. Each milestone
is committed on `ai-agent`.

- **M1 — Unblock & de-risk.** The whole governed AI surface was hard-gated to
  `NODE_ENV==="test"` and returned 503 in production, while the *ungoverned*
  legacy `gpt-4o` endpoint was the only live AI. Replaced with `AI_ENVIRONMENT`;
  governed the legacy endpoint; declared `openai` directly (it was resolving
  transitively through unused langchain packages); pinned the model snapshot;
  added the `ai_provider_attempts` billing ledger (pre-call row + idempotency
  fingerprint) to close a duplicate-charge window. Security: admin app no longer
  leaks its bearer token to the browser, CORS allowlist, Helmet, Redis-backed
  rate limits, fail-closed public grants, private+scanned vendor uploads,
  redacted public proposal payload, password/bcrypt hardening.
- **M2 — Conversational slice.** Migration 017: conversations, messages,
  attachments, clarification questions. Idempotent message endpoint, durable
  `conversation_chat` jobs with persisted placeholders, bounded dashboard
  polling (the backend SSE route remains for compatibility), pasted-notes
  intake through the same scan boundary, and the first workspace UI.
- **M3 — Full-schema application.** The candidate whitelist went from **4 paths
  to 112**, generated against the canonical contract with typed normalizers;
  `extractionPathEnum` feeds the model's structured output so it can only
  propose fields a reviewer can apply. Migration 018 added draft section
  decisions and scoped regeneration.
- **M4 — Knowledge & guidance.** Real OpenAI embeddings behind a release
  registry (migration 019), open governed retrieval, knowledge fragments cited
  in drafts as `/knowledge/...`, and a deterministic guidance engine
  (completeness + ~12 rules) that unlocked workflow step 4.
- **M5 — Pricing & vendor analysis.** Migration 020: pricing records and expert
  rules with an approval workflow; a deterministic investment engine with
  provenance and explicit refusals; a vendor-response analysis durable job
  producing cited findings with human-escalation flags.
- **M6 — Hardening.** A real docker-compose integration suite (25 tests against
  live Postgres/Redis/Mongo), the gold evaluation harness as a release gate,
  cross-store purge propagation, `/api/v1/ai/usage-report`, PM2 config for all
  three processes, the production runbook, and an admin AI Operations page for
  runtime readiness, provider-attempt outcomes, token usage, and gateway runs.

### Proposal Intelligence foundation (Task 2, 2026-08-12)

Vendor responses now have a stable `VendorSubmission` identity and immutable
`VendorSubmissionVersion` records. Every initial, revised, clarification, BAFO,
or administrative version receives a parent pointer, monotonic version number,
idempotency key, source manifest, SHA-256 checksum, and receipt metadata. The
legacy `VendorResponse` remains a latest-version compatibility projection so
the current inbox and vendor-analysis behavior continue during migration.

New files retain private storage and fail-closed malware scanning, and are
registered idempotently as `vendor_submission` sources in PostgreSQL when the
data foundation is available. Migration 044 adds version/source linkage without
attributing a public upload to a planner. The dry-run-first
`backfillVendorSubmissionVersions.ts` projects legacy responses to version 1,
reconciles eligible sources, and journals checksummed outcomes. Comparison,
requirement mapping, extraction, evaluator scoring, and decision UX remain later
explicitly approved tasks.

### The DXG pricing engine (client workbook)

The founder supplied `RFPilot_AV_Pricing_Engine` (baseline v3): 433 line items
across 10 categories, 22 regional factors, 13 modifiers, 13 confidence rules.

- **Imported** via `npx ts-node scripts/importPricingWorkbook.ts <workbook.xlsx>`
  (idempotent on category+subcategory+item label). Migration 022 added
  subcategory/spec/unit_label/quantity_dimension/calibration_tier plus the
  factor tables. **The workbook is deliberately NOT in git** — DXG proprietary
  data per SOW §10; the operator supplies the path.
- **The investment engine was rebuilt on his model**: package templates select
  the median-priced approved record per component (it previously summed an
  entire category, which was harmless with 18 demo rows and nonsense with 149
  audio SKUs), then applies `base × regional × multi-day(equipment) ×
  union(labor) × in-house(equipment) + service charge(subtotal)`.
- **Acceptance:** reproduces his own worked example (13 Chicago breakouts) at
  **$54,060 against his $54,366 — 0.56%**. That is the strongest acceptance
  evidence the project has; lead with it.

### Room specification recommendations (added 2026-07-27; auto-apply same day)

Conversation messages may carry a bounded `actions` array. Migration 032 adds
the persisted allowlist for downloading the room schedule template and opening
Room Specifications; room-schedule intent has a deterministic fallback so the
guidance remains available when the live model is disabled. Proactive guidance
appears once after the initial guided questions are answered or skipped, not in
the opening assistant turn. An explicit room-schedule request still receives
the actions immediately, and the persisted action guard prevents duplication.

When live chat is unavailable, the deterministic first turn welcomes the
planner and points to the guided intake; later turns acknowledge conversation
context. These fallbacks do not claim that chat text was saved or applied to
proposal fields.

The guided intake includes Event Type among its first eight questions and uses
the same closed choice list as the advanced proposal editor.

Location intake asks city before state. A validated US city answer can fill an
empty state and the editor-compatible time-zone label in the same guarded
Mongo update. Explicit `City, ST` or `City, State` answers are supported;
ambiguous or unknown bare city names are not guessed and leave the state
follow-up open. Existing state or time-zone values are not overwritten.

**Policy note for DXG:** originally built review-first; changed the same day
by product decision to **apply automatically into empty room fields** (the
planner adjusts values in the form; filled fields are never overwritten and
are reported as skipped), including `recommended_assumption` values below the
0.8 automatic-confidence bar. As of 2026-07-29 this is the platform's **only**
unattended application path: extracted field candidates now require explicit
review, so this no longer extends a shared boundary — it is the single
exception to one, which is what DXG needs told. Engine is `room-rules.v3`; v3 evaluates every function in a
physical room, sizes shared AV guidance from peak function attendance, and
validates each function schedule independently. Migration 031 added
automatic/skipped columns. The paragraph below otherwise stands, with crew
roles now applied as append-only `$addToSet` writes and manual review/apply
endpoints retained.

Originally: a review-first, deterministic room recommendation capability behind
`ROOM_RECOMMENDATIONS_ENABLED` / `NEXT_PUBLIC_ROOM_RECOMMENDATIONS_ENABLED`
(both default off). Confirmed room/event facts plus approved synthetic
knowledge fixtures produce a strictly validated `room-recommendation.v1`
payload (migration 030) in which every value is classified
(`deterministic_derivation` / `recommended_assumption` / questions for
`unknown`), everything is review-gated, and explicit application is limited to
a three-field wireless-microphone allowlist with proposal-version CAS **and a
per-room identity guard** (ordinary wizard saves do not bump the proposal
version, so apply re-checks each room's `roomFunction` label). Reviewer
decisions persist with the schema's first enumerated reason-code vocabulary as
governed evaluation data. Crew suggestions mirror the wizard's auto-suggest
and are review-only. Extraction is unchanged — `rooms[]` remains excluded from
the scalar candidate whitelist. Details:
`docs/architecture/ROOM_RECOMMENDATIONS.md`. Deferred: crew/array application,
production knowledge adapter, workflow-facts integration, integration-suite
coverage for the new tables, and any AI enrichment stage (fine-tuning
explicitly out of scope until enough producer-reviewed outcomes exist).

### The conversational workspace

Lives at **`/proposals/{id}/assistant`** (one surface, one implementation).
`add-new-proposal` is the "start something new" entry and redirects there once
a proposal exists. The editor keeps its stepper and review panels and links to
the assistant.

Flow: type or attach → sources scan → extraction auto-runs → cited candidates
remain read-only and link to explicit per-field review → guided key questions
with typed controls (date picker, time, choice pills, number) → progress card with
real completeness → generate cited draft → readiness and investment guidance.

Proposal-source extraction now packages PDF, DOCX, XLSX, CSV, and TXT evidence
with source-fair selection, table-header context, exact fragment checksums, and
opaque citations. The governed model remains the primary semantic extractor and
receives value guidance for every scalar path. A single optional batched recovery
call targets only high-value paths whose concepts appear in evidence but remain
absent. Dates, attendance, and event format receive conservative field-aware
normalization; recording or remote presenters alone never imply Hybrid.
Candidates are canonical-normalized and deduplicated before persistence, while
genuine disagreements remain separate and create blocking conflicts. Extracted
values remain suggestions until the planner explicitly confirms them.

### The Platform AI Assistant

The dashboard sidebar now exposes a compact helper popup for onboarding,
navigation, proposal workflow, and event-planning guidance. It is a separate
bounded module from proposal conversations and is read-only.

PostgreSQL owns personal threads/messages with organization RLS plus explicit
owner predicates. Approved `operating_guidance` is accessed behind an
Assistant-owned knowledge port, with versioned platform facts as a safe
fallback. OpenAI streaming stays behind a provider port and emits only
versioned product SSE through a same-origin dashboard BFF. Attempts are
recorded before provider calls; user and organization rate/concurrency limits
are enforced through Redis with a bounded fallback.

The baseline/candidate evaluation and live staging comparison are complete.
The runtime baseline remains `gpt-5.4-mini-2026-03-17`; promoting the evaluated
candidate still requires an explicit Product Owner decision. Production
internal/cohort rollout also remains blocked until an organization-scoped
entitlement or deployment allowlist exists.

---

## 4. Design decisions worth knowing

- **MongoDB stays authoritative for proposal content**; PostgreSQL owns the AI
  domain (runs, evidence, reviews, knowledge, pricing, audit, outbox); Redis
  carries references only, never content.
- **Human control boundary is explicit.** Every extracted field requires
  individual review followed by a current-versus-proposed confirmation.
  Empty fields are not treated as implicit consent. Submission and publication
  remain manual.
- **Never fabricate a number.** Investment guidance refuses categories the
  corpus cannot support, with a concrete ask. All 433 imported records are
  `calibration_tier = 'baseline'`, so every estimate says it rests on national
  baseline figures, not DXG actuals.
- **Prompt injection:** source content is data, never instructions; strict JSON
  schemas; citations validated against a whitelist of supplied evidence ids.
- **Idempotency everywhere** — messages, jobs, applications, provider attempts.

---

## 5. Known issues & deferred work

**Owed to the client**
1. **Written provider comparison** (SOW §4). DXG's stated preference is
   Anthropic; OpenAI was chosen. The gold harness's first live run scored
   **recall 87.5% against the 90% gate** (precision 93.3%, citations and schema
   100%, zero fabrications) — that result is the key input.
2. **Three questions for Ace:** does the service charge compound on the
   in-house subtotal (the engine assumes yes, matching his 1.40 × 1.22
   scenario)? Can the questionnaire gain **projector lumens** and an
   **in-house-vs-outside-AV** flag (worth ~20 confidence points on every
   estimate)? And confirmation that room recommendations may keep filling empty
   room fields unattended, now that extracted candidates no longer do.

**Product gaps**
- ~~**Typed conversation is not extracted.**~~ **Closed 2026-07-29.** The
  segmentation pipeline existed but its gate was never switched on;
  `CONVERSATION_EXTRACTION_ENABLED=true` now routes typed chat through the same
  cited-extraction and review path as an upload. Since 2026-08-04, a detailed
  single-turn brief closes immediately and the API exposes its runtime gate to
  the dashboard, so the “Use what I've told you” control cannot disagree with
  backend availability. Missing capability data fails closed in the dashboard.
- Stepper and assistant can disagree — the stepper counts gaps from extraction
  runs, questions now also come from empty fields.
- Completeness scores against all ~120 canonical fields, so it reads harshly
  (~9% for a real proposal). Weighting toward RFP-relevant fields would help.
- Rooms/arrays are not extracted (only scalar fields are mapped). The room
  recommendation capability (2026-07-27) covers part of this gap with
  deterministic, review-gated suggestions, but extraction itself still skips
  `roomByRoom`.
- Invalid extracted candidates are reported by the API (`invalidOperations`)
  but not rendered anywhere.
- Report envelope: confidence/assumptions/scenarios ride inside the
  `line_items` JSONB as `payloadVersion: 2`; promoting them to real columns is
  a small migration.
- Vendor analysis has no attempt-ledger coverage; bid-vs-bid pricing comparison
  and exportable client-ready reports are unbuilt.
- Existing vendor analysis still reads the latest `VendorResponse` compatibility
  projection. Binding analysis to an explicitly selected immutable version is
  part of the later comparison orchestration task.

**Testing**
- Unit suites are strong (backend 440, dashboard 332) and there is a real
  integration suite, but there are still no browser E2E tests, no load tests,
  and no production smoke tests. This remains the highest-value testing gap:
  every one of the three worst defects in §8 was invisible to unit tests and
  surfaced only by driving the real UI.

---

## 6. Class of bug to watch for

Repeatedly, the failure mode was **stale assumptions from the 4-field era**
surviving into the 112-field world, each hidden behind a generic error:

- `selected_count` capped at 25 and item `ordinal` at 0–24 → applying 46 fields
  failed (migrations 023/024).
- The review endpoint normalized all candidates eagerly, so two unmappable
  values broke the whole request — and with it version lookup and auto-apply.
- Enum fields only accepted exact tokens while extraction returns prose
  ("Confirmed", "Human captioner preferred").
- Clarification questions could only exist against an extraction run, so a
  conversation-only proposal was asked nothing (migration 025).
- Completion state lived in session-local React state and vanished on refresh.

From the 2026-07-29 UI review, the same class again — plus a second class:
**a value the code reads that the UI never writes**, and **a failure that is
caught and softened until it becomes invisible**.

- `contactRequired` read `this.isDraft`, but `findOneAndUpdate` binds validators
  to the query, not the document, so every assisted draft save failed with an
  opaque "Validation failed".
- `ROOM_AUDIO_QA_001` required `audienceQa.audienceQa === "Yes"`, a field the
  Room Specifications form never writes — the mic recommendations were
  unreachable in the app while every fixture set the flag by hand. Worse, save
  normalisation *cleared* `audienceQaMethod` whenever that flag was not "Yes",
  so the planner's Q&A selection was discarded on every save.
- `uniqueItems` in the conversation reply schema 400'd every live call; the
  provider error was caught and replaced with the canned acknowledgement, so
  the assistant appeared to work and simply never used the model.
- Sidebar completion was `activeStep > step.id`, so opening the last page marked
  every earlier step done regardless of content.
- Expiry queried `isActive: true`, which defaults to true, so unsubmitted drafts
  were swept into the published-proposal lifecycle.

When something "doesn't work", check for a limit or gate written when the
feature was smaller, and prefer per-item resilience over all-or-nothing. When
something "works" but produces nothing, check whether a fallback is hiding a
hard failure, and whether the field a rule reads is one the UI actually writes.
Fixtures shaped by hand will not catch that — shape them the way the form saves.

---

## 7. Suggested next steps

1. Draft the provider comparison and close the recall gap (prompt tuning,
   `gpt-5.4` full tier, or benchmark Claude through the existing port).
2. Add browser E2E coverage for the assistant → wizard → draft journey. Every
   defect in §8 was invisible to the unit suites.
3. Real-asset acceptance run with the SOW test RFP and vendor responses,
   reviewed by the founder — the contractual acceptance test.
4. Add the two questionnaire fields; promote the report envelope to columns.
5. Merge `ai-agent` to the default branch and stand up staging per the runbook.

---

## 8. End-to-end UI review (2026-07-29)

A full pass over the AI proposal-creation journey in a browser, against a real
draft. Everything below is fixed and verified in the running app; the durable
rules are registered in `DECISIONS.md`.

**Three defects that made features look built but inert**

| What | Why it mattered |
|---|---|
| `uniqueItems` in the conversation reply schema | Strict structured output rejects the keyword, so every live reply 400'd and fell back to canned text. The assistant had never once used the model — this alone explained most of what read as "the AI ignores what you type". |
| Contact validator bound to the query, not the document | Every assisted draft save failed with "Validation failed"; combined with no autosave, a planner could lose a fully specified proposal. |
| Q&A method cleared on save | The planner's Q&A selection was wiped on every save, which also made the wireless-mic recommendations unreachable. |

**Correctness**
- Schedule times anchored to the venue zone, end to end (storage, pickers,
  draft evidence). A 9:15 AM Chicago keynote uploaded from UTC+6 previously
  reached vendors as "3:00 AM UTC".
- Evaluation weightings withheld until confirmed (see `DECISIONS.md`).
- Expiry no longer closes unsubmitted drafts as `rejected`.

**Intake and recovery**
- Attendance is now in the opening question set; it had ranked below venue
  state (auto-filled from the city answer) and fell outside the eight-question
  cap, so it was never asked.
- Draft edits autosave, with an unsaved-changes warning on unload.
- A blocked room step names the room and missing fields, then opens and scrolls
  to it, instead of returning silently.
- Skipping a question leaves a note with a link to the page that owns the field.
- Readiness and investment reports are restored on load rather than re-run.
- Sidebar checkmarks reflect real per-step completion.
- `asksForRoomScheduleHelp` matches "room schedule" on its own.

**Deliberately not changed**
- **Auto-titling a proposal from the first message.** The backend treats
  "Untitled proposal" as empty, which is what keeps "What is this event called?"
  in the question set; filling it from free text would suppress that question
  and lock in a guess.
- **Batching the assistant's server-action requests.** A dev-mode pattern not
  confirmed to affect production builds.
- **Backfilling `evaluationMatrixConfirmed` on existing proposals.** Product
  decision (2026-07-29): old data is being deleted, so only new proposals matter.
  Every pre-existing proposal therefore reads as unconfirmed.
