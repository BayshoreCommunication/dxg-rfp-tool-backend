# RFPilot AI Intelligence Layer

## Step-by-Step Implementation Backlog

**Status:** Ready for review and scheduling  
**Implementation state:** In progress — Slice 1B secure sessions, organization RBAC, and public-token redesign  
**Approval requirement:** Begin each milestone only after its entry gate is approved  
**Repositories:** `dxg-rfp-tool-dashboard` and `dxg-rfp-tool-backend`

**Execution procedure:** [Approval-Gated Milestone Execution Playbook](./RFPilot_AI_Milestone_Execution_Playbook.md)  
**Reusable control record:** [Milestone Status and Acceptance Template](./RFPilot_AI_Milestone_Status_and_Acceptance_Template.md)

---

## How to use this backlog

- Complete tasks in milestone order unless a task is explicitly marked as parallel work.
- Do not begin a milestone until its entry criteria are satisfied.
- Do not mark a milestone complete until its exit criteria and demonstrations pass.
- Update architecture, API, database, security, and operational documentation in the same change as implementation.
- Every implementation task requires tests, observability, and security review appropriate to its risk.
- AI output is never considered production-ready only because it appears correct in a demonstration; it must pass the approved evaluation suite.

### Status values

- `[ ]` Not started
- `[~]` In progress
- `[x]` Completed and verified
- `[!]` Blocked

---

# Milestone 0 — Approval and implementation readiness

## Objective

Confirm that requirements, data, architecture, acceptance assets, owners, schedule, and commercial constraints are sufficient to begin engineering.

## Entry criteria

- Client has received the requirements-confirmation and technical-design documents.
- Named DXG decision-makers and Bayshore technical owners are available.

## Tasks

### M0.1 Requirements approval

- [ ] Review all four workstreams with DXG.
- [ ] Confirm functional and non-functional requirements.
- [ ] Confirm project scope and out-of-scope boundaries.
- [ ] Resolve or formally accept every open assumption.
- [ ] Confirm success metrics and acceptance thresholds.
- [ ] Obtain signed or written requirements approval.

**Deliverable:** Approved requirements baseline.  
**Owner:** Product lead and DXG sponsor.  
**Complexity:** Medium.

### M0.2 Data inventory

- [ ] Inventory historical PDFs, contracts, quotes, spreadsheets, and exports.
- [ ] Record file counts, sizes, date ranges, markets, currencies, vendors, and formats.
- [ ] Classify confidentiality and legal-use restrictions.
- [ ] Identify duplicate, incomplete, scanned, and low-quality documents.
- [ ] Select a representative initial ingestion sample.

**Deliverable:** Data inventory and quality report.  
**Owner:** Data/AI lead and DXG knowledge owner.  
**Complexity:** High.

### M0.3 Acceptance assets

- [ ] Receive at least one real completed RFP.
- [ ] Receive all associated vendor responses.
- [ ] Receive actual/final event cost where available.
- [ ] Receive the founder's manual review and expected material findings.
- [ ] Redact or authorize personal and vendor-sensitive information.
- [ ] Version and checksum the initial gold test assets.

**Deliverable:** Approved gold test case v1.  
**Owner:** DXG founder and AI evaluation lead.  
**Complexity:** Medium.

### M0.4 Architecture decisions

- [ ] Approve modular monolith plus independent workers.
- [ ] Approve MongoDB transition strategy.
- [ ] Approve or reject PostgreSQL for AI knowledge, pricing, provenance, and audit.
- [ ] Approve or reject managed Redis/BullMQ.
- [ ] Confirm object-storage provider and privacy configuration.
- [ ] Confirm frontend, API, and worker hosting environments.
- [ ] Record decisions as Architecture Decision Records.

**Deliverable:** Approved ADR set.  
**Owner:** Principal architect and client technical approver.  
**Complexity:** High.

### M0.5 AI provider benchmark

**Protocol:** [RFPilot AI Provider Benchmark and Acceptance Protocol](./RFPilot_AI_Provider_Benchmark_and_Acceptance_Protocol.md) — drafted; awaiting approval and authorized benchmark assets.

- [x] Define proposed provider comparison rubric and release thresholds.
- [ ] Configure isolated Anthropic and OpenAI test accounts.
- [ ] Confirm data-use and retention terms.
- [ ] Run identical extraction and analysis test assets.
- [ ] Measure quality, schema validity, evidence adherence, latency, consistency, and cost.
- [ ] Document recommended provider and fallback policy.
- [ ] Obtain DXG provider approval.

**Deliverable:** Provider benchmark and decision.  
**Owner:** AI lead.  
**Complexity:** High.

### M0.6 Delivery planning

- [ ] Confirm staffing and named owners.
- [ ] Confirm milestone schedule and budget.
- [ ] Confirm environment and provider costs.
- [ ] Confirm risk and change-management process.
- [ ] Create project board, decision log, risk register, and weekly demonstration schedule.

## Exit criteria

- [ ] Requirements, architecture, provider direction, data inputs, acceptance assets, budget, and owners are approved.
- [ ] No unresolved blocker prevents foundation development.

---

# Milestone 1 — Platform, security, and delivery foundation

## Objective

Create the production-ready foundation required by every AI workflow without changing existing user behavior prematurely.

## Entry criteria

- Milestone 0 exit criteria are approved.
- Environments and infrastructure budgets are authorized.

## Workstream 1A — Repository and module foundation

### M1.0 Repository quality baseline

- [x] Record current repository structure, branch, scripts, and CI/deployment state.
- [x] Document frontend and backend target dependency boundaries.
- [x] Add frontend lint, type-check, test, and production-build CI gate.
- [x] Add backend type-check, test, and production-build CI gate.
- [x] Require the backend production deployment workflow to pass the quality gate first.
- [x] Verify gates locally and in clean GitHub runners; frontend run `29487520911` and backend run `29487519383` passed on the pushed `ai-agent` commits.

**Evidence:** [Milestone 1 Slice 1A Status](./RFPilot_AI_Milestone_1_Slice_1A_Status.md)

### M1.1 Backend structure

- [x] Introduce `src/` modular structure without breaking existing routes.
- [~] Separate HTTP controllers from domain services and persistence adapters; the proposal controller now delegates CRUD, lifecycle, views, notifications, uploads, and legacy public access through application ports/adapters and no longer imports proposal/settings models or provider utilities. Remaining legacy controllers are pending.
- [x] Separate compatibility extraction orchestration from parser/model providers and controller prompt text; PDF/Office/text parsing, OpenAI invocation, immutable prompt versioning, and compatibility output validation use application ports/adapters.
- [ ] Deliver canonical cited extraction patches, provider policy/routing, budgets, and queued execution in the approved AI workflow milestones.
- [x] Separate settings persistence and logo storage from the HTTP controller with owner-scoped application ports, protected-field filtering, and storage-key tests.
- [x] Separate notification queries, read-state mutations, and realtime unread-count emission through owner-scoped repository and websocket ports.
- [x] Separate dashboard proposal/email aggregates and latest-proposal reporting through an owner-scoped read-model port.
- [x] Separate vendor-response planner reads and public submission through repository, storage, notification, and confirmation-email ports; legacy public identifiers remain scheduled for tokenization in Workstream 1B.
- [x] Separate email workflows; campaign sending, list/stats/deletion, and atomic engagement tracking use owner-scoped application/repository and delivery boundaries.
- [x] Separate administration workflows; overview reporting, client list/block/delete, and admin-user list/create/update/delete use application/repository and password-security boundaries.
- [x] Separate account/profile workflows with self-or-admin authorization, protected-field filtering, email-conflict checks, and shared single-hash password persistence.
- [x] Separate authentication workflows; OTP, registration/reset, credential/admin login, admin signup, current-user retrieval, verified Google identity, password hashing/verification, and token issuance use application ports/adapters.
- [ ] Establish common error, validation, logging, authentication, queue, storage, and AI-gateway modules.
- [x] Enable strict TypeScript settings incrementally.
- [x] Remove tracked legacy compiled artifacts; deployment builds validated source and `dist/` is ignored.
- [x] Add module-boundary linting and dependency rules for new modular code.

### M1.2 Canonical proposal schema

- [x] Reconcile frontend, backend, extraction prompt, Mongo model, and export fields.
- [x] Define canonical proposal schema version 1.
- [x] Represent dates, numbers, monetary values, dimensions, counts, and units with typed fields.
- [x] Generate frontend/backend types from the shared contract.
- [x] Add backward-compatible mapping for existing proposals with explicit review issues for values that cannot be safely normalized.
- [x] Add non-destructive snapshot migration and contract tests; production execution remains separately gated.

**Acceptance:** The frontend, API validation, AI structured output, and test fixtures use the same canonical contract.

**Design evidence:** [Canonical Proposal Contract v1 Analysis](./RFPilot_AI_Canonical_Proposal_Contract_v1_Analysis.md), [ADR-001](./RFPilot_AI_ADR_001_Canonical_Proposal_Contract.md), [ADR-002](./RFPilot_AI_ADR_002_Non_Destructive_Proposal_Migration.md), and the [migration runbook](./RFPilot_AI_Canonical_Proposal_Migration_Runbook.md).

## Workstream 1B — API foundation

### M1.3 Versioned API

- [ ] Establish `/api/v1` routing.
- [ ] Adopt OpenAPI 3.1 as API source of truth.
- [ ] Implement schema-based request and response validation.
- [ ] Implement RFC 9457-compatible error responses.
- [ ] Add correlation IDs and idempotency-key support.
- [ ] Add cursor-pagination conventions.
- [ ] Add optimistic concurrency through proposal versions/ETags.
- [ ] Publish generated internal API documentation.

### M1.4 Compatibility layer

- [ ] Inventory existing frontend server actions and backend routes.
- [ ] Create compatibility adapters for existing `/api` behavior.
- [ ] Add deprecation headers and migration tracking.
- [ ] Prevent compatibility routes from bypassing new authorization controls.

## Workstream 1C — Authentication and authorization

### M1.5 Secure sessions

- [ ] Design short-lived access token and rotating refresh session model.
- [ ] Store refresh tokens and OTPs as hashes.
- [ ] Add token issuer, audience, ID, and session claims.
- [ ] Implement logout and server-side revocation.
- [ ] Implement rotation-replay detection.
- [ ] Migrate users without forcing unexpected account loss.

### M1.6 Organization RBAC

- [~] Add organization and membership records; the Organization record and user `organizationId` membership are implemented and migrated, while a future multi-membership model remains pending.
- [ ] Define planner, organization admin, DXG producer, knowledge editor, knowledge approver, DXG admin, and super-admin roles.
- [~] Implement deny-by-default resource authorization; protected requests require active stored membership, with granular resource policy/role matrix still pending.
- [~] Enforce organization filters in repositories; proposal, dashboard, settings, campaign, notification, vendor-response, administration, and user repositories are tenant-scoped, with the remaining public-token redesign pending.
- [ ] Add authorization matrix integration tests.
- [ ] Add audited break-glass access.

## Workstream 1D — Security hardening

### M1.7 API and web security

- [ ] Restrict CORS to approved origins.
- [ ] Add secure HTTP headers and Content Security Policy.
- [ ] Add Redis-backed rate limiting.
- [ ] Sanitize Mongo update keys and allowlist patch paths.
- [ ] Remove internal errors and stack data from production responses.
- [ ] Add CSRF controls if cookie-authenticated mutations are used.
- [ ] Validate redirects against allowlists.

### M1.8 Public-access redesign

- [ ] Replace public proposal ObjectId access with scoped, expiring, revocable tokens.
- [ ] Limit public proposal responses to published safe projections.
- [ ] Require valid state such as published, active, and open.
- [ ] Rate-limit and deduplicate view tracking.
- [ ] Replace vendor query-string identity with scoped submission tokens.
- [ ] Test token expiry and revocation.

## Workstream 1E — Data and asynchronous platform

### M1.9 PostgreSQL foundation

- [ ] Provision development, staging, and production PostgreSQL.
- [ ] Configure migrations and connection pooling.
- [ ] Create organizations, memberships, sessions, proposal references, jobs, AI runs, provenance, audit, and outbox tables.
- [ ] Add tenant and state constraints.
- [ ] Configure encryption, backups, PITR, and alerts.

### M1.10 Redis and durable jobs

- [ ] Provision managed Redis.
- [ ] Implement queues, worker bootstrap, concurrency, retry, backoff, cancellation, and dead-letter handling.
- [ ] Persist job state outside Redis.
- [ ] Add idempotency and immutable input versions.
- [ ] Add job status and cancellation APIs.
- [ ] Add queue dashboards and alerts.

### M1.11 Transactional outbox

- [ ] Define domain-event contracts.
- [ ] Store state change and outbox event transactionally.
- [ ] Implement reliable dispatcher and deduplication.
- [ ] Add reconciliation jobs between MongoDB and PostgreSQL references.

## Workstream 1F — Private file platform

### M1.12 Secure uploads

- [ ] Configure private S3-compatible buckets or prefixes.
- [ ] Implement short-lived signed upload sessions.
- [ ] Verify checksum and object existence on completion.
- [ ] Detect MIME type from bytes.
- [ ] Add malware scanning and quarantine.
- [ ] Add file/page/size/decompression limits.
- [ ] Add lifecycle, retention, deletion, and legal-hold metadata.
- [ ] Replace local disk dependencies in production.

## Workstream 1G — Observability and delivery

### M1.13 Observability

- [ ] Add structured JSON logging and redaction.
- [ ] Add OpenTelemetry traces across HTTP, queues, workers, storage, databases, and AI providers.
- [ ] Add API, queue, database, provider, cost, and security metrics.
- [ ] Add dashboards, alerts, and runbook links.
- [ ] Create append-only security and approval audit events.

### M1.14 CI/CD

- [ ] Add format, lint, type, test, migration, and contract gates.
- [ ] Add SAST, dependency, license, secret, and container scanning.
- [ ] Generate SBOM and signed build artifacts.
- [ ] Create staging and canary deployment flow.
- [ ] Add feature flags by organization.
- [ ] Test rollback and migration recovery.

## Milestone 1 exit criteria

- [ ] Shared canonical contracts are active.
- [ ] New API, tenancy, secure sessions, private storage, jobs, audit, and observability work in staging.
- [ ] Existing proposal flows pass regression tests.
- [ ] Security and recovery reviews pass.
- [ ] DXG approves the platform-foundation demonstration.

---

# Milestone 2 — Knowledge and pricing foundation

## Objective

Allow DXG to securely upload, review, approve, publish, version, and roll back historical data and production rules.

## Workstream 2A — Source ingestion

### M2.1 Admin import batch

- [ ] Create Data Imports admin navigation and permission checks.
- [ ] Create new-batch form with name, market, currency, dates, source type, confidentiality, and notes.
- [ ] Support multiple files per batch.
- [ ] Display upload, scan, parsing, extraction, review, and approval status.

### M2.2 Parsing and segmentation

- [ ] Implement native parsing for PDF, DOCX, CSV, XLS/XLSX, and text.
- [ ] Add OCR for scanned documents.
- [ ] Extract tables while preserving page/sheet/row/cell coordinates.
- [ ] Create immutable source fragments.
- [ ] Detect duplicate documents and repeated fragments.
- [ ] Record parser version and processing diagnostics.

### M2.3 Structured extraction

- [ ] Define versioned pricing-extraction schema.
- [ ] Extract equipment, labor, market, date, duration, currency, units, ancillary fees, taxes, and discounts.
- [ ] Store source citation for every extracted observation.
- [ ] Calculate confidence and detect conflicts.
- [ ] Reject schema-invalid or citation-free output.
- [ ] Persist AI-run metadata, validation, cost, and latency.

## Workstream 2B — Pricing normalization and review

### M2.4 Pricing domain

- [ ] Define equipment, labor, service, ancillary, market, unit, and currency taxonomies.
- [ ] Store money in minor units and currency.
- [ ] Support standard/list price versus negotiated/actual price.
- [ ] Record market, observation date, effective date, and data quality.
- [ ] Define currency and inflation normalization policies.

### M2.5 Review workspace

- [ ] Show extracted records beside the source page or spreadsheet row.
- [ ] Filter low-confidence, missing, conflicting, duplicate, and outlier records.
- [ ] Support approve, correct, split, merge, reject, and comment.
- [ ] Preserve original extraction and all corrections.
- [ ] Add bulk review with safeguards.
- [ ] Add reviewer assignment and progress reporting.

### M2.6 Batch approval

- [ ] Implement Draft → Processing → Review → Submitted → Approved/Rejected lifecycle.
- [ ] Enforce editor/approver separation where configured.
- [ ] Publish immutable pricing snapshot.
- [ ] Implement deactivation and rollback without destroying history.
- [ ] Add complete audit trail.

## Workstream 2C — Expert rules

### M2.7 Rule schema and editor

- [ ] Define stable rule key, category, conditions, actions, rationale, severity, visibility, market, effective dates, examples, and exceptions.
- [ ] Create rule builder for common event/venue/room/technical conditions.
- [ ] Support structured patches and advisory-only actions.
- [ ] Validate rules against canonical proposal fields.
- [ ] Provide test-input preview before submission.

### M2.8 Rule lifecycle

- [ ] Implement draft, review, approve, publish, deprecate, and rollback.
- [ ] Version every change.
- [ ] Record author, reviewer, approver, reason, and effective dates.
- [ ] Prevent unpublished rules from production use.
- [ ] Create immutable knowledge releases used by AI jobs.

### M2.9 Knowledge-capture sessions

- [ ] Define workshop template and cadence.
- [ ] Capture rule, rationale, examples, counterexamples, exceptions, and confidence.
- [ ] Convert workshop outputs into draft rules.
- [ ] Test rules against real RFPs.
- [ ] Obtain founder approval for initial release.

## Workstream 2D — Retrieval

### M2.10 Approved corpus retrieval

- [ ] Add PostgreSQL full-text and `pgvector` retrieval.
- [ ] Implement tenant, visibility, approval, market, date, and category filters.
- [ ] Implement hybrid semantic and metadata ranking.
- [ ] Store retrieval traces and selected evidence IDs.
- [ ] Test cross-tenant isolation and relevance.
- [ ] Add corpus-release invalidation and cache keys.

## Milestone 2 exit criteria

- [ ] DXG can import sample contracts and spreadsheets.
- [ ] Extracted rows have valid citations and review status.
- [ ] Only approved pricing snapshots and rules are retrievable in production mode.
- [ ] DXG can publish, deprecate, and roll back without developer assistance.
- [ ] Founder approves the initial knowledge release.

---

# Milestone 3 — AI-assisted Proposal Creation

## Objective

Allow planners to create proposals through AI-assisted extraction and exception review while preserving full manual control.

## Workstream 3A — Multi-source intake

### M3.1 Start proposal experience

- [ ] Support upload, pasted notes, guided entry, previous proposal, and manual paths according to approved scope.
- [ ] Allow multiple sources per proposal.
- [ ] Show processing progress and recoverable failures.
- [ ] Store sources privately and associate immutable versions.

### M3.2 Proposal extraction

- [ ] Define versioned proposal-fact extraction schema.
- [ ] Extract fields with citations and confidence.
- [ ] Normalize dates, times, locations, counts, dimensions, units, and controlled values.
- [ ] Detect cross-source conflicts.
- [ ] Avoid silently applying low-confidence facts.
- [ ] Preserve all source and run metadata.

## Workstream 3B — Review workspace

### M3.3 Draft overview

- [ ] Build proposal summary, readiness, review-item count, section status, estimate availability, and publish status.
- [ ] Make Review Items the primary action.
- [ ] Preserve Edit All Details for advanced users.

### M3.4 Unified review queue

- [ ] Combine uncertain facts, conflicts, missing questions, recommendations, warnings, and stale results.
- [ ] Filter by priority, section, type, and status.
- [ ] Support batch review where safe.
- [ ] Link every item to source and affected proposal fields.

### M3.5 Clarifying questions

- [ ] Rank missing information by production and cost impact.
- [ ] Generate plain-language questions from structured gaps.
- [ ] Validate questions against approved proposal fields.
- [ ] Apply answers through version-checked patches.
- [ ] Recalculate dependent readiness and recommendations.

## Workstream 3C — Recommendations

### M3.6 Rule evaluation

- [ ] Evaluate rules deterministically when relevant fields change.
- [ ] Track rule dependencies to avoid full reevaluation.
- [ ] Deduplicate recommendations through stable fingerprints.
- [ ] Mark recommendations stale when inputs or rule versions change.

### M3.7 Recommendation experience

- [ ] Show recommendation, rationale, evidence, confidence, severity, impact, and proposed diff.
- [ ] Implement accept, modify, dismiss, defer, undo.
- [ ] Apply validated structured patches only.
- [ ] Record feedback and dismissal reasons.
- [ ] Prevent AI prose from directly mutating proposal data.

## Workstream 3D — Detailed editing and readiness

### M3.8 Workspace editor

- [ ] Convert mandatory linear wizard into collapsible workspace sections.
- [ ] Preserve conditional sections and existing detailed fields.
- [ ] Add multi-room inheritance, copy, and bulk editing.
- [ ] Add continuous autosave and conflict recovery.
- [ ] Add keyboard, focus, screen-reader, zoom, and mobile support.

### M3.9 Final validation

- [ ] Validate completeness and field consistency.
- [ ] Validate dates, quantities, room totals, and schedule feasibility.
- [ ] Evaluate critical production rules.
- [ ] Detect unsupported generated claims.
- [ ] Enforce approved publish-warning policy.
- [ ] Create immutable published proposal version and requirements snapshot.

## Workstream 3E — Drafting and rewriting

### M3.10 Evidence-bound proposal drafting

- [ ] Generate section language only from approved proposal facts.
- [ ] Mark unresolved information as questions/placeholders.
- [ ] Prevent rewrites from changing protected facts, pricing, dates, or quantities.
- [ ] Compare generated text back to structured facts.
- [ ] Store prompt, model, evidence, validation, and final user decision.

## Milestone 3 exit criteria

- [ ] Test RFPs can be completed primarily through exception review.
- [ ] Extraction citations and conflict detection meet approved thresholds.
- [ ] Recommendations reflect approved DXG rules and pass founder review.
- [ ] No generated proposal changes protected facts silently.
- [ ] UX, accessibility, security, and regression tests pass.

---

# Milestone 4 — Investment Guidance Engine

## Objective

Generate defensible, traceable equipment, labor, and ancillary investment ranges.

## Workstream 4A — Eligibility and mapping

### M4.1 Completeness gate

- [ ] Define required and conditionally required estimate inputs.
- [ ] Calculate readiness by event type and production profile.
- [ ] Explain missing information blocking or reducing confidence.
- [ ] Allow approved producer override with audit.

### M4.2 Cost mapping

- [ ] Map proposal scope into normalized equipment, labor, service, and ancillary categories.
- [ ] Apply quantities, durations, labor days, overtime assumptions, and room concurrency.
- [ ] Version mapping rules and store every input.

## Workstream 4B — Comparable selection and calculation

### M4.3 Relevance scoring

- [ ] Define approved matching factors: market, venue, audience, event type, rooms, features, complexity, date recency.
- [ ] Implement metadata filters before semantic ranking.
- [ ] Exclude unapproved, expired, low-quality, or incompatible observations.
- [ ] Show comparable coverage and limitations.

### M4.4 Deterministic range engine

- [ ] Define low/mid/high statistical or rule-based methods by category.
- [ ] Handle currency, inflation, market adjustment, negotiated discounts, and outliers according to approved policies.
- [ ] Calculate equipment and labor independently.
- [ ] Calculate ancillary factors or mark venue-dependent/unsupported.
- [ ] Prevent the AI model from creating authoritative numbers.
- [ ] Unit-test formulas and edge cases.

## Workstream 4C — Guidance presentation

### M4.5 Guidance output

- [ ] Show category and line-item low/mid/high ranges.
- [ ] Show assumptions, exclusions, coverage, confidence, and knowledge release.
- [ ] Show evidence-safe provenance.
- [ ] Generate venue questions for unsupported factors.
- [ ] Mark guidance stale when cost-affecting inputs or knowledge versions change.
- [ ] Support scenario comparison if approved.

### M4.6 Export

- [ ] Generate client-ready guidance report from verified structured data.
- [ ] Include line items, assumptions, unsupported factors, and version metadata.
- [ ] Store export privately with checksum and audit record.

## Workstream 4D — Evaluation

### M4.7 Founder acceptance

- [ ] Compare guidance with actual test event cost.
- [ ] Score directional accuracy and ancillary-factor recall.
- [ ] Record unsupported-number defects as critical.
- [ ] Calibrate thresholds and policies.
- [ ] Add accepted case to regression suite.

## Milestone 4 exit criteria

- [ ] Every displayed number is supported and traceable.
- [ ] Unsupported items are clearly identified.
- [ ] Founder approves direction and applicable ancillary coverage.
- [ ] Estimate consistency, load, cost, and security tests pass.

---

# Milestone 5 — Vendor Proposal Analysis Engine

## Objective

Produce verified requirement, pricing, and production analysis so DXG producers review flags instead of full proposals.

## Workstream 5A — Secure vendor submission

### M5.1 Vendor token and upload

- [ ] Issue scoped, expiring, revocable vendor-submission token.
- [ ] Limit token to one proposal/campaign/vendor purpose.
- [ ] Implement secure upload sessions, malware scan, file limits, and allowed types.
- [ ] Support idempotent submission/update and immutable response versions.
- [ ] Remove email identity from trusted query parameters.

## Workstream 5B — Response extraction

### M5.2 Structured vendor response

- [ ] Extract vendor claims, inclusions, exclusions, assumptions, equipment, labor, and price lines.
- [ ] Preserve source citations.
- [ ] Normalize currencies, units, quantities, taxes, fees, and totals.
- [ ] Detect internal inconsistencies and unpriced text.
- [ ] Route low-confidence extraction to review.

## Workstream 5C — Analysis

### M5.3 Compliance mapping

- [ ] Snapshot RFP requirements at publication.
- [ ] Map each requirement to addressed, partial, missing, unclear, or not applicable.
- [ ] Require citations for coverage decisions.
- [ ] Calculate completeness without hiding critical missing requirements.

### M5.4 Pricing analysis

- [ ] Compare vendor lines with Investment Guidance.
- [ ] Compare normalized vendor responses with peers.
- [ ] Identify anomalous, missing, deferred, and likely hidden costs.
- [ ] Handle incomparable scope explicitly.
- [ ] Avoid simplistic total-price ranking.

### M5.5 Production judgment

- [ ] Apply approved rules for equipment sizing, crew, redundancy, schedule, load-in, power, rigging, and union conditions.
- [ ] Classify finding severity and confidence.
- [ ] Require evidence and escalation policy.
- [ ] Generate specific vendor clarification questions.

### M5.6 Side-by-side comparison

- [ ] Present coverage, normalized price, exclusions, assumptions, risks, and trade-offs.
- [ ] Generate narrative only from verified structured findings.
- [ ] Clearly distinguish fact, inference, and human opinion.
- [ ] Never recommend an automatic award.

## Workstream 5D — Producer review

### M5.7 Review queue

- [ ] Route high-severity, low-confidence, conflict, and policy-defined findings.
- [ ] Support assignment, priority, SLA, comments, and evidence view.
- [ ] Support confirm, edit, dismiss, and escalate.
- [ ] Record review time and resulting correction.
- [ ] Feed reviewed outcomes into evaluation and rule improvement—not provider training.

### M5.8 Client export

- [ ] Generate requirement matrix, price comparison, risks, trade-offs, and vendor questions.
- [ ] Include only confirmed or safely labeled findings.
- [ ] Remove DXG-confidential evidence where planner visibility forbids it.
- [ ] Version and audit the export.

## Milestone 5 exit criteria

- [ ] Analysis catches approved material founder findings.
- [ ] Fabricated findings equal zero on the acceptance set.
- [ ] Evidence and escalation accuracy meet approved thresholds.
- [ ] Producer review time is lower than the Phase 0 baseline.
- [ ] DXG approves the client-presentable output.

---

# Milestone 6 — Evaluation, hardening, rollout, and handoff

## Objective

Make the complete AI Intelligence Layer reliable, secure, measurable, operable, and maintainable in production.

## Workstream 6A — Evaluation release gate

### M6.1 Gold suite

- [ ] Expand test cases across markets, venue types, budgets, and production complexity.
- [ ] Version assets, expected findings, rubrics, and reviewer decisions.
- [ ] Automate extraction, recommendation, guidance, analysis, evidence, consistency, latency, and cost metrics.
- [ ] Define blocking and warning thresholds.
- [ ] Run suite for every model, prompt, retrieval, rule, pricing, or schema release.

## Workstream 6B — Reliability and performance

### M6.2 Load and failure tests

- [ ] Test peak API, uploads, polling, and concurrent jobs.
- [ ] Test maximum documents, OCR, and multi-vendor comparisons.
- [ ] Test worker termination, provider throttling, database failover, Redis restart, and queue reconstruction.
- [ ] Verify retry, idempotency, cancellation, dead-letter, and reconciliation.
- [ ] Tune indexes, pools, concurrency, caching, and budgets.

### M6.3 Disaster recovery

- [ ] Verify MongoDB and PostgreSQL point-in-time restore.
- [ ] Verify object-storage restoration/versioning.
- [ ] Verify infrastructure and secret recovery.
- [ ] Run documented recovery exercise.
- [ ] Confirm RPO and RTO with DXG.

## Workstream 6C — Security

### M6.4 Final security review

- [ ] Complete threat-model updates.
- [ ] Run SAST, DAST, dependency, secret, container, and IaC scans.
- [ ] Run cross-tenant and authorization test suite.
- [ ] Test malicious files, XSS, injection, SSRF, prompt injection, and retrieval leakage.
- [ ] Complete external penetration test.
- [ ] Resolve critical/high findings before rollout.

## Workstream 6D — Operations and documentation

### M6.5 Runbooks and training

- [ ] Finalize architecture, OpenAPI, database, deployment, troubleshooting, security, and maintenance documentation.
- [ ] Create knowledge-editor and approver guide.
- [ ] Create AI operations and evaluation guide.
- [ ] Create incident, provider outage, bad-pricing, bad-rule, and rollback runbooks.
- [ ] Train DXG editors, approvers, producers, and administrators.
- [ ] Validate DXG can operate rules, batches, evaluations, and review queues.

## Workstream 6E — Production rollout

### M6.6 Controlled launch

- [ ] Deploy production infrastructure and migrations.
- [ ] Enable internal DXG pilot organization.
- [ ] Monitor quality, cost, latency, security, and support issues.
- [ ] Expand through organization feature flags.
- [ ] Maintain rollback paths for application and AI policy releases.
- [ ] Obtain production sign-off.

## Milestone 6 exit criteria

- [ ] Functional, acceptance, evaluation, load, security, and recovery gates pass.
- [ ] Operations dashboards and alerts are active.
- [ ] Runbooks and training are accepted.
- [ ] DXG can operate the system without routine developer assistance.
- [ ] Production rollout is approved and stable.

---

# Cross-cutting definition of done

Every task or story is complete only when:

- [ ] Requirements and acceptance criteria are satisfied.
- [ ] Domain and API contracts are updated.
- [ ] Authorization and tenant isolation are tested.
- [ ] Input and AI-output validation are implemented.
- [ ] Unit and appropriate integration/E2E tests pass.
- [ ] Logs, metrics, traces, and audit events are added.
- [ ] Failure, retry, and rollback behavior is documented.
- [ ] No secrets or sensitive content appear in logs or fixtures.
- [ ] Accessibility is verified for user-facing changes.
- [ ] Architecture and operational documentation remain synchronized.
- [ ] The milestone-specific evaluation gate passes.

---

# Immediate next actions

1. [ ] Assign DXG and Bayshore owners to Milestone 0 tasks.
2. [ ] Schedule and conduct the [Phase 0 Approval Workshop](./RFPilot_AI_Phase_0_Approval_Workshop_Pack.md).
3. [ ] Receive the initial data inventory and gold acceptance assets.
4. [ ] Record the PostgreSQL, Redis, hosting, and provider decisions.
5. [ ] Approve the Milestone 1 backlog and implementation estimate.
6. [ ] Sign the [Milestone 1 Implementation Authorization Record](./RFPilot_AI_Milestone_1_Authorization_Record.md).
7. [ ] Begin Milestone 1 only after written approval.
