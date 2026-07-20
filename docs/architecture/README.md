# RFPilot Backend Architecture Boundaries

This document is the Slice 1A baseline for evolving the existing Express/MongoDB service into the RFPilot AI Intelligence Layer. Migration is incremental: existing routes remain compatible while new `/api/v1` modules and workers adopt the target boundaries.

Current increment runbook: [Private document ingestion](./PRIVATE_DOCUMENT_INGESTION.md).

Durable execution runbook: [Durable jobs](./DURABLE_JOBS.md).

Provider-neutral mock AI runbook: [AI gateway](./AI_GATEWAY.md).

Governed knowledge retrieval design: [Slice 2C knowledge retrieval](./KNOWLEDGE_RETRIEVAL.md).

Client approval pack: [Slice 2C retrieval approval](../approval-packs/SLICE_2C_KNOWLEDGE_RETRIEVAL_APPROVAL.md).

Test operation and recovery: [Slice 2C retrieval runbook](../runbooks/KNOWLEDGE_RETRIEVAL.md).

Test-environment verification: [Slice 2C evidence](../evidence/SLICE_2C_TEST_EVIDENCE.md).

Proposal context and requirement extraction: [Slice 2D design](./PROPOSAL_CONTEXT_EXTRACTION.md).

Test operation and recovery: [Slice 2D runbook](../runbooks/PROPOSAL_CONTEXT_TEST.md).

Test-environment verification: [Slice 2D evidence](../evidence/SLICE_2D_TEST_EVIDENCE.md).

Client approval pack: [Slice 2D proposal context approval](../approval-packs/SLICE_2D_PROPOSAL_CONTEXT_APPROVAL.md).

Human review and controlled application: [Slice 2E design](./CANDIDATE_REVIEW_APPLICATION.md).

Client approval pack: [Slice 2E candidate application approval](../approval-packs/SLICE_2E_CANDIDATE_APPLICATION_APPROVAL.md).

Cited AI proposal drafting: [Slice 2F design](./AI_PROPOSAL_DRAFT_GENERATION.md).

Client approval pack: [Slice 2F draft generation approval](../approval-packs/SLICE_2F_AI_DRAFT_GENERATION_APPROVAL.md).

Five-step proposal workflow and multi-source intake: [Slice 3A design](./FIVE_STEP_PROPOSAL_WORKFLOW.md).

Client approval pack: [Slice 3A five-step workflow approval](../approval-packs/SLICE_3A_FIVE_STEP_WORKFLOW_APPROVAL.md).

Content-free operational telemetry: [Observability](./OBSERVABILITY.md).

## Target modular-monolith boundaries

| Boundary | Responsibility |
|---|---|
| HTTP/API | Routing, authentication context, request/response validation, status mapping |
| Application | Use cases, transaction boundaries, authorization decisions, orchestration |
| Domain | Proposal, knowledge, pricing, recommendation, document, analysis, and approval rules |
| Infrastructure | MongoDB/PostgreSQL/Redis/storage/provider adapters and external messaging |
| Workers | Durable asynchronous parsing, extraction, indexing, generation, and analysis jobs |
| Operations | Configuration, logging, metrics, traces, health, audit, and lifecycle controls |

## Dependency rules

1. HTTP handlers call application use cases; they do not contain provider prompts or persistence rules.
2. Domain/application code depends on interfaces, not concrete database, object-storage, email, or AI SDK clients.
3. Infrastructure adapters may depend inward on contracts; inward layers do not import adapters.
4. Every organization-owned record and query carries tenant context and is authorization-filtered.
5. AI output is untrusted input: validate schema, evidence, permissions, and domain invariants before storage or display.
6. Authoritative pricing is deterministic and versioned; an AI provider may explain it but cannot create unsupported values.
7. Document content cannot grant permissions or trigger arbitrary tools, network access, SQL, email, or state changes.
8. Background jobs are idempotent, retry-bounded, observable, and recoverable from dead-letter state.
9. Public access uses scoped, expiring, revocable tokens; raw object identifiers are not authorization.
10. Architectural changes require an ADR and synchronized API/data/security/operations documentation.

## Transitional legacy locations

Existing `routes/`, `controller/`, `middleware/`, `modal/`, and `utils/` remain operational during staged migration. New AI modules must not deepen controller-bound provider or persistence coupling. Compatibility adapters should route legacy behavior into the new application boundary as slices are delivered.

## Current proposal-module increment

Proposal CRUD, lifecycle, listing/detail, view-count, notifications, uploads, and legacy public access enter through the legacy-compatible Express controller but delegate immediately to composed application use cases. Application code depends on read, write, settings, notification, public-access, and storage ports under `domain/ports`; MongoDB, DigitalOcean Spaces, and notification-service details live under `infrastructure`. Authenticated operations require owner context and persistence filters carry it. The controller no longer imports proposal/settings models or provider utilities.

Raw-ObjectId public proposal access is isolated in `PublicProposalAccessRepository` and its MongoDB adapter solely for compatibility. This is not the target authorization model. Workstream 1B must replace it with scoped, expiring, revocable share tokens before public-access security can be accepted.

Document extraction delegates through `DocumentTextExtractor`, `ProposalExtractionModel`, `ExtractionPromptRegistry`, and `ExtractionOutputValidator` ports. PDF/Office/text parsing, the OpenAI SDK, immutable legacy prompt version, and AJV compatibility schema are infrastructure adapters; the application use case owns empty-document handling, the compatibility text limit, prompt selection/version propagation, and output validation. The HTTP controller contains no prompt text and maps invalid AI output to a typed upstream error. Canonical cited extraction patches, provider routing, budgets, and durable jobs remain separately gated AI work rather than being conflated with the legacy partial-form endpoint.

Settings retrieval, validated upsert, deletion, preview-URL filtering, and logo upload delegate through owner-scoped settings repository and asset-storage ports. MongoDB and Spaces details remain in infrastructure adapters; the controller is limited to authentication, multipart/JSON decoding, and HTTP response mapping.

Notification listing, unread counts, and read-state mutations delegate through an owner-scoped repository port. Websocket unread-count publication is a separate realtime port and runs only after successful mutations. MongoDB and the legacy websocket broadcaster remain infrastructure adapters; the controller handles authentication, identifier syntax, and HTTP response mapping.

Dashboard proposal/email totals, proposal-view aggregation, and latest-proposal queries delegate through an owner-scoped reporting port. MongoDB aggregation and projection details remain in the reporting adapter; the controller handles authentication, identifier syntax, and HTTP response mapping.

Planner vendor-response listing, campaign/proposal filtering, unread counts, detail retrieval, and read-state updates delegate through an owner-scoped repository port. Public submission delegates through repository, document-storage, planner-notification, and confirmation-email ports; MongoDB, Spaces/filesystem, notifications, and email rendering are adapters. Attachments use proposal-scoped sanitized keys and failed uploads receive best-effort cleanup. Raw proposal/tracking identifiers remain compatibility authorization and must be replaced by scoped, expiring, revocable submission tokens in Workstream 1B.

Email open, proposal-click, and vendor-response-click tracking delegate through an engagement repository and redirect application services. MongoDB uses conditional first-event updates to keep counters idempotent under duplicate/concurrent requests. Campaign-derived redirects take precedence; unmatched fallback redirects accept only HTTP(S), otherwise returning the configured frontend origin. Campaign listing, vendor-response enrichment, aggregate statistics/rates, and deletions use an owner-scoped campaign repository. Campaign sending uses a separate owner-scoped repository and delivery port; the application layer owns recipient normalization, tracking, safe rendering, per-recipient outcomes, and partial/all-failed classification. The controller is limited to HTTP decoding and status/response mapping.

Admin overview reporting, client management, admin-user management, and signed-in admin profile/password/avatar management delegate through separate admin read/mutation, password-security, and avatar-storage ports. MongoDB cross-collection aggregation, search, paging, block updates, account persistence, and deletion live in infrastructure adapters; Spaces upload is an avatar adapter. HTTP controllers retain route-role checks and response mapping. Application rules prevent administrator accounts from client block/delete operations, prevent super-admin self-deletion, require verified old passwords for profile password changes, filter protected account fields, and build owner-scoped avatar keys.

User directory, profile, primary-admin profile, update, and deletion workflows delegate through a user-account repository. Application services enforce privileged directory access, self-or-admin resource access, protected update fields, normalized email uniqueness, primary-admin ownership, and self-deletion prevention. Admin and account password changes share a bcrypt-backed password-hasher port and persist exactly one hash without depending on Mongoose update hooks.

Signup and password-reset OTP request/verification use OTP repository, user-lookup, delivery, generator, and clock ports. Six-digit codes are generated with Node cryptographic randomness; reset requests conceal account existence, failed delivery removes the challenge, and expired challenges are deleted before a result is returned. Customer registration/reset, credential/admin login, admin signup, authenticated-user retrieval, and Google identity use authentication-account, shared password-hasher/verifier, verified-OTP, identity-verifier, random-secret, and access-token ports. Google ID tokens are verified with the official library against backend `GOOGLE_CLIENT_ID`; a verified provider subject/email is required before account access, and the frontend forwards only NextAuth's provider-issued ID token. Account/password persistence completes before verified challenge consumption, direct hash persistence avoids model-hook ambiguity, and role/block checks complete before token issuance. The legacy Mongo schema still stores compatibility OTP codes in plaintext; hashing, attempt counters, request throttling, and transactional one-time consumption are required security follow-ups.

## Quality gate

Every pull request must pass locked dependency installation, generated-contract drift checks, zero-warning linting for new modular code, strict TypeScript checking, Node tests, and production compilation through `.github/workflows/ci.yml`. Integration environments, security scans, and coverage thresholds remain later authorized Slice 1 work.

## Canonical proposal contract

`contracts/proposal/v1/` contains the JSON Schema 2020-12 canonical resource, public projection, extraction-candidate patch, runtime validators, and legacy adapter. `contracts/generated/` is deterministic generated output and its manifest. New proposal modules import the contract through `src/modules/proposals/contracts`; they must not introduce handwritten competing proposal types.
