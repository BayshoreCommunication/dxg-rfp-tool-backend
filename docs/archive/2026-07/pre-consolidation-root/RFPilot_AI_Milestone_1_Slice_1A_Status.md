# RFPilot AI Intelligence Layer

## Milestone 1 — Slice 1A Status and Evidence Record

**Slice:** Repository baselines, architecture boundaries, and CI quality gates  
**Status:** Implementation and evidence complete; client acceptance requested  
**Authorization:** User confirmed “there are no blocker now” on July 15, 2026  
**Repositories:** `dxg-rfp-tool-dashboard`, `dxg-rfp-tool-backend`  
**Started:** July 15, 2026

---

# 1. Authorized objective

Establish repeatable repository quality gates and documented module boundaries before structural, security, data, job, or AI-platform implementation begins.

This Slice 1A record does not claim completion of the backend modular migration or any production data cutover.

# 2. Baseline findings

## Frontend

- Next.js 16, React 19, TypeScript strict mode, ESLint, and Jest are configured.
- No CI workflow existed at baseline.
- The repository was clean on branch `ai-agent` before changes.
- Initial `npm run lint` passed.
- Initial sandboxed `npm ci` attempts could not resolve package hosts and ended with npm's secondary `Exit handler never called` error. With approved package-network access, the locked installation completed successfully.

## Backend

- Express/TypeScript/MongoDB source uses transitional top-level `routes/`, `controller/`, `middleware/`, `modal/`, and `utils/` directories.
- TypeScript strict mode was already enabled.
- A production deployment workflow existed, but no pull-request CI workflow or automated test command existed.
- The repository was clean on branch `ai-agent` before changes.
- Baseline TypeScript type-check and build passed.

# 3. Changes implemented

## Frontend repository

- Added `type-check` and composite `ci` scripts.
- Added `.github/workflows/ci.yml` for locked installation, linting, strict type-checking, Jest, and production build.
- Added `docs/architecture/README.md` with presentation, application-access, configuration, contract, authorization, AI-output, and async-job boundaries.

## Backend repository

- Added Node test and composite `ci` scripts without adding a test-framework dependency.
- Added `.github/workflows/ci.yml` for locked installation, strict type-checking, tests, and production compilation.
- Updated production deployment workflow so validation must succeed before the deploy job begins.
- Added a repository-baseline test suite.
- Added `docs/architecture/README.md` defining target modular-monolith and worker boundaries plus transitional legacy rules.

## Canonical contract discovery

- Reconciled the active wizard, older frontend type, public renderer, Mongo model, proposal controller, and extraction prompt.
- Recorded confirmed shape, nesting, type, and lifecycle drift.
- Accepted ADR-001: JSON Schema 2020-12, generated types, explicit compatibility adapters, allowlisted public projection, and cited AI candidate patches.

## Canonical contract implementation

- Added canonical `proposal.v1`, `proposal-public.v1`, and `proposal-extraction-patch.v1` JSON Schemas to both repositories.
- Added deterministic generated TypeScript contracts and schema-hash manifests.
- Added Ajv 2020 runtime validation with date, date-time, email, and URI format validation.
- Added cross-repository byte-for-byte contract drift verification.
- Added a deterministic legacy adapter that fails on missing required values and reports invalid normalization instead of guessing.
- Added an explicit public projection that removes organization/owner metadata and source references.
- Added a backend `src/` modular skeleton and lint-enforced inward dependency boundaries for new code.
- Changed backend deployment to use locked dependencies and compile validated source on the target instead of relying on ambiguous tracked `dist` output.
- Removed the backend `package-lock.json` ignore rule, generated the lock, and verified a clean `npm ci`; clean CI/deployment runners can now reproduce the approved dependency graph.
- Added a non-destructive canonical snapshot collection, dry-run-first batch migration, stable content hashing, insert-if-absent idempotency, checkpoint pagination, review classification, and exact-run rollback.
- Expanded representative mapping coverage across event, schedule, rooms, audio/video/lighting/production, hybrid, creative, recording, venue, co-vendors, NDA, budget, and contacts.
- Added ADR-002 and an operator runbook; no production migration or canonical read cutover has been executed.

## Backend modular read-path increment

- Extracted proposal presentation rules (settings snapshot and derived expiry state) from the legacy controller into a testable application module.
- Added application ports for proposal reads and proposal settings, with MongoDB adapters isolated under infrastructure.
- Added a composed `getOwnedProposal` use case and connected the authenticated proposal-detail endpoint without changing its successful response shape.
- Enforced the owner identifier inside the persistence query so a proposal cannot be retrieved by identifier alone on the authenticated path.
- Added focused tests for ownership scoping, safe not-found behavior, non-mutating expiry derivation, and response settings snapshots.
- Extracted authenticated proposal listing into an application use case and MongoDB adapter while preserving filters, search, paging, sort allowlisting, expiry behavior, dashboard counts, and the response contract.
- Added list-path tests for tenant scoping, normalization, bounded pagination, safe sort fallback, settings presentation, and count propagation.
- Extracted status, metadata, archive, restore, and permanent-delete operations into application rules and an ownership-scoped write adapter.
- Preserved copy restrictions and publish lifecycle transitions while preventing identifier-only mutations or deletion.
- Added tests for invalid status rejection, publish transitions, copy metadata restrictions, validated metadata updates, cross-owner not-found behavior, and archive/restore/delete ownership context.
- Extracted create, full-update, and copy authoring operations with protected system-field removal, legacy draft normalization, lifecycle transitions, validation-enabled updates, and ownership-scoped copy-source lookup.
- Copy creation now resets lifecycle state, only accepts supported template identifiers and typed event overrides, and cannot inherit client-controlled ownership or timestamps.
- Added authoring tests for protected-field handling, draft normalization, publish transitions, cross-owner updates, copy lifecycle reset, and invalid override rejection.
- Extracted authenticated/public view counting, settings presentation, and view notifications behind application, persistence, and notification ports.
- Isolated raw-ObjectId public lookup in an explicitly named legacy compatibility adapter; it remains security debt until scoped, expiring share tokens are delivered in Workstream 1B.
- Extracted upload orchestration behind a storage port, with authenticated owner-scoped object keys, sanitized names, deterministic per-batch collision protection, and no storage-provider dependency in the controller.
- Added tests for public compatibility lookup, owner notification, ownerless legacy handling, authenticated view ownership, empty uploads, and safe owner-scoped object keys.
- The proposal controller no longer imports Mongoose proposal models, settings models, notification services, or object-storage utilities. Broader backend controllers and the legacy public-link authorization model remain pending.

## Extraction boundary increment

- Added document-text and proposal-extraction-model ports with a composed extraction application use case.
- Moved PDF/DOC/DOCX/TXT/CSV parsing and OpenAI SDK invocation out of the HTTP controller into infrastructure adapters.
- Preserved the existing synchronous endpoint, model, prompt, text limit, empty-document messages, JSON cleanup, and response shape.
- Added tests proving empty documents bypass the model, extracted text is trimmed and bounded to 40,000 characters, and parser/model implementations are replaceable.
- This initial increment still supplied the legacy prompt from the controller; the later versioned-prompt increment below removes that transitional coupling.

## Settings boundary increment

- Added owner-scoped settings-management and settings-asset-storage ports with MongoDB and Spaces adapters.
- Moved find-or-create, validated upsert, deletion, protected-field removal, browser preview-URL rejection, logo key construction, and logo upload out of the HTTP controller.
- Preserved JSON/multipart compatibility, default settings creation, validation behavior, response shapes, and optional storage-folder prefix behavior.
- Added tests for owner context, protected fields, blob/data URL rejection, normalized file extensions, and owner-scoped logo object keys.

## Notifications boundary increment

- Added owner-scoped notification repository and realtime-notification ports with MongoDB and legacy websocket adapters.
- Moved notification listing, pagination, unread counting, mark-one-read, mark-all-read, and websocket unread-count emission out of the HTTP controller.
- Preserved current response shapes, websocket discovery metadata, paging limits, ordering, and read timestamps.
- Added tests for pagination normalization, tenant context, cross-owner not-found behavior, mutation-before-emission ordering, and owner-scoped unread counts.
- The notification controller no longer imports the notification model or notification websocket service directly.

## Dashboard boundary increment

- Added an owner-scoped dashboard read-model port and MongoDB reporting adapter.
- Moved proposal counts, email sent/clicked aggregation, proposal-view aggregation, and latest-proposal queries out of the HTTP controller.
- Preserved current totals, five-item ordering/selection, identifier validation, response shape, and zero-value fallbacks.
- Added a test proving the authenticated owner context reaches the dashboard repository unchanged.

## Vendor-response planner-read increment

- Added an owner-scoped vendor-response read repository and application services for planner listing, filtering, detail retrieval, and read-state changes.
- Moved campaign tracking-ID resolution, proposal filtering, paging, unread counting, selection, ordering, and mark-read persistence out of the HTTP controller.
- Preserved invalid-filter fallback behavior, campaign-empty results, response shapes, and automatic mark-read behavior on detail retrieval.
- Added tests for owner context, bounded pagination, filter propagation, safe defaults, and cross-owner not-found behavior.
- Public vendor submission, document storage, confirmation email, and planner notification side effects were completed in the following increment.

## Public vendor-submission increment

- Added public vendor-submission repository, document-storage, planner-notification, and confirmation-email ports with MongoDB, Spaces/filesystem, notification, and email adapters.
- Moved tracking-ID/existing-response checks, normalization, deduplication, update/create decisions, proposal-owner resolution, document upload/cleanup, planner notification, and vendor confirmation out of the HTTP controller.
- Preserved existing create/update status codes, response messages, confirmation HTML/text, append-document behavior, campaign reassignment, and best-effort confirmation delivery.
- Improved attachment keys with proposal scoping, full filename sanitization, and per-batch collision protection; failed uploads receive best-effort local cleanup and do not abort the text submission.
- Added tests for tracking precedence, fail-fast validation, normalized new submissions, owner notification, existing-response updates, and upload-failure cleanup.
- Raw proposal identifiers and tracking IDs remain the legacy public authorization mechanism; scoped/revocable submission tokens remain required in Workstream 1B.

## Email-engagement tracking increment

- Added an email-tracking repository port and application services for open pixels, proposal clicks, and vendor-response clicks.
- Moved recipient tracking lookup, first-open/first-click timestamps, counter increments, campaign-derived redirects, vendor email context, and fallback redirect policy out of the HTTP controller.
- Replaced read-modify-save counters with conditional atomic MongoDB updates so duplicate or concurrent requests do not increment engagement metrics more than once.
- Preserved transparent GIF behavior, campaign-derived proposal/vendor URLs, encoded vendor context, HTTP(S) fallback redirects, and safe frontend fallback behavior.
- Added tests for tracking/timestamp propagation, campaign redirect precedence, unsafe-scheme rejection, and encoded vendor-response context.
- Campaign list/stats/deletion and campaign sending were completed in the following increments.

## Email-campaign management increment

- Added an owner-scoped email-campaign repository and application services for list/pagination, vendor-response count enrichment, aggregate statistics, and deletion by proposal or campaign.
- Moved campaign/vendor-response joins, MongoDB aggregations, zero-value defaults, by-proposal ranking, and delete persistence out of the HTTP controller.
- Moved open/click rate calculation and total-view compatibility alias into the application layer.
- Preserved list ordering, page limits, campaign-specific vendor-response counts, 20-proposal statistics limit, response shapes, and not-found behavior.
- Added tests for owner/filter propagation, safe pagination, rate calculations, zero division, deletion counts, and cross-owner not-found behavior.
- Campaign sending was completed in the following increment; the email controller no longer owns persistence or delivery orchestration.

## Email-campaign sending increment

- Added an owner-scoped campaign-sending repository and a replaceable email-delivery port, implemented by MongoDB and the existing custom-email provider adapter.
- Moved recipient validation, normalization and deduplication, proposal ownership checks, tracking-ID creation, encoded tracking URLs, safe HTML rendering, per-recipient delivery outcomes, and campaign finalization out of the HTTP controller.
- Preserved partial-delivery behavior while explicitly classifying validation, not-found, all-failed, and processed outcomes for stable HTTP mapping.
- Escaped administrator-supplied message content before HTML delivery and persisted each recipient outcome for operational review.
- Added five tests covering fail-fast validation, ownership, normalization, URL encoding, HTML escaping, partial delivery, and total provider failure.
- The email controller now performs HTTP decoding and response mapping only; it has no direct campaign/proposal model or email-provider dependency.

## Admin reporting and client-management increment

- Added admin overview and client-management application boundaries with MongoDB reporting and mutation adapters.
- Moved cross-collection client/proposal/campaign aggregation, client search and paging, block-state persistence, and client deletion out of HTTP controllers.
- Kept admin and super-admin route authorization at the HTTP boundary while enforcing the target-account rule in the application layer so administrator accounts cannot be blocked or deleted through client operations.
- Normalized paging and search before repository access and preserved the existing response, pagination, role-compatibility, and status behavior.
- Added five tests covering reporting delegation, safe paging/search normalization, protected administrator targets, persisted block state, and missing/admin/customer deletion outcomes.
- The admin overview and client-list controllers no longer import MongoDB models.

## Admin-user management increment

- Added admin-user repository and password-hasher ports with MongoDB and bcrypt infrastructure adapters.
- Moved administrator list/create/update/delete persistence, input normalization, role validation, email-conflict checks, target-role protection, and self-deletion protection out of the HTTP controller.
- Corrected password updates to hash exactly once through the security port and persist the resulting hash directly, avoiding the previous manual-hash plus model-hook double hashing path.
- Preserved super-admin route authorization, legacy role aliases, safe user projections, response messages, and status codes.
- Added five tests covering validation and normalization, normalized email conflicts, non-admin target rejection, single password hashing, and fail-fast self-deletion protection.
- The admin-user controller no longer imports the user model or bcrypt.

## Account and profile-management increment

- Added user-account repository and shared password-hasher boundaries for user directory, self/privileged profile reads, primary-admin profile behavior, profile updates, and deletion.
- Moved self-or-admin authorization, primary-admin targeting, email-conflict checks, protected-field filtering, password validation/hashing, and self-deletion protection into application services.
- Closed an existing directory exposure by requiring a privileged role before returning the full user list.
- Corrected profile password updates that previously used `findByIdAndUpdate` without triggering the model password hook; valid passwords now receive exactly one application hash before direct persistence and short passwords fail before hashing.
- Preserved configured-primary-admin fallback behavior, safe password-free projections, legacy role aliases, and endpoint response shapes.
- Added eight tests covering directory authorization, read authorization, primary-admin access, normalized email conflicts, single hashing, short-password rejection, primary-admin update ownership, and deletion authorization.
- The user controller no longer imports the user model and the password security adapter is shared across admin and user modules.

## Authentication OTP request/verification increment

- Added OTP repository, user-lookup, delivery, generator, and clock ports with MongoDB, legacy email-delivery, and cryptographic generator adapters.
- Moved signup/reset code replacement, account-state checks, password-reset account concealment, delivery orchestration, failed-delivery cleanup, pending-challenge lookup, expiry deletion, code comparison, and verified-state persistence out of the controller.
- Replaced the legacy `Math.random` code generator with Node cryptographic `randomInt` while preserving the six-digit user experience.
- Preserved signup conflict responses, password-reset anti-enumeration responses, OTP expiry and invalid-code messages, challenge replacement, and delivery-failure rollback.
- Added six tests covering existing/missing account behavior, side-effect ordering, delivery rollback, expiry cleanup, invalid codes, and successful verification.
- Registration OTP consumption, password reset, local/admin login, Google identity, and token creation remain in the next authentication increments; this increment does not claim the full authentication controller is separated.

## Registration and password-reset consumption increment

- Added authentication account-repository and access-token issuer ports with MongoDB and JWT adapters, reusing the shared password-hasher boundary.
- Moved registration input normalization, minimum-password validation, verified-signup authorization, duplicate-account checks, customer creation, OTP consumption, and token issuance out of the controller.
- Moved reset validation, verified-reset authorization, account lookup, single-hash password replacement, and post-persistence OTP consumption out of the controller.
- Password hashes are persisted directly through update operations so neither flow depends on Mongoose save hooks or risks double hashing.
- Preserved registration/reset response messages, status codes, safe user response, normalized email behavior, and existing JWT response fields.
- Added six tests covering verification-before-lookup, conflict-before-hash, registration ordering, reset authorization, single-hash reset ordering, and short-password fail-fast behavior.
- Local/admin login, Google identity handling, admin signup, current-auth-user retrieval, and the remaining token issuance paths remain transitional.

## Credential/admin authentication increment

- Added password-verifier behavior to the shared security boundary and extended the authentication account repository for credential, current-user, and administrator account operations.
- Moved normalized credential lookup, password verification, administrator role enforcement, blocked-account checks, endpoint-specific token roles, admin-secret validation, conflict checks, single-hash admin creation, and current-user retrieval out of the controller.
- Preserved distinct customer/admin error codes, block messages, legacy administrator role aliases, token response fields, and safe user projections.
- Administrator creation uses explicit password hashing and direct hash persistence rather than model save-hook behavior.
- Added seven tests covering normalized lookup, fail-fast missing/wrong-password behavior, admin role/block checks, customer/admin token roles, admin-secret/conflict ordering, single-hash administrator creation, and authenticated-user lookup.
- Google identity handling is now the only direct model/token workflow remaining in the authentication controller.

## Verified Google identity increment

- Replaced trust in browser-supplied Google email/name/identifier fields with a signed Google ID-token contract between NextAuth and the backend.
- Added Google identity-verifier, Google account-repository, and random-secret ports with the official Google authentication library, MongoDB, and cryptographic adapters.
- The verifier enforces the configured Google client audience and requires a signed token containing a provider subject and verified email before any account lookup or mutation.
- Existing identities are linked and refreshed without generating fallback credentials; blocked accounts stop before token issuance. New identities receive one cryptographically random, single-hash fallback credential before account creation.
- Updated the frontend NextAuth callback to send only `account.id_token` to the backend identity endpoint.
- Added five tests covering missing/invalid tokens, fail-fast blocked accounts, existing-account behavior without fallback work, and ordered new-account creation/token issuance.
- The authentication controller now has no direct model, password-provider, random-generator, or JWT dependency. Backend `GOOGLE_CLIENT_ID` must match the frontend Google provider client ID in each environment.

## Versioned extraction prompt and compatibility-schema increment

- Moved the complete existing extraction prompt unchanged from the HTTP controller into immutable prompt version `legacy-proposal-extraction.v1` with an explicit compatibility output-schema identifier.
- Added prompt-registry and output-validator ports with versioned prompt and AJV infrastructure adapters.
- The application layer now selects the prompt, carries its version into model invocation, validates model output, and returns typed prompt/schema evidence with successful results.
- Unknown top-level sections and invalid section types are rejected before reaching the frontend; the controller maps invalid AI output to a stable `502 INVALID_EXTRACTION_OUTPUT` response.
- Preserved the legacy partial-form response needed by the current proposal UI. Canonical cited extraction patches remain a separately gated AI workflow because silently changing this endpoint would break the existing frontend contract.
- Added five tests covering immutable prompt/schema binding, accepted partial output, unknown-section/type rejection, model prompt-version propagation, and typed invalid-output behavior.
- The extraction controller no longer contains or supplies prompt text.

## Admin self-profile audit correction

- A final controller-tree audit identified the active `/api/admin-user` profile controller as a remaining direct user-model and Spaces dependency; the earlier broad administration-complete statement did not yet cover this route.
- Added admin self-profile repository, avatar-storage, timestamp, password-hasher, and password-verifier boundaries with MongoDB and Spaces adapters.
- Moved profile reads, credential lookup, old-password verification, minimum-password validation, single hashing, protected-field filtering, avatar key construction/upload, and persistence out of the controller.
- Avatar objects use normalized folder and authenticated-user scoping; arbitrary role, email, and block-state fields are ignored by the profile update service.
- Added six tests covering owner lookup, missing-user fail-fast behavior, old/short password handling, single hashing/protected fields, and owner-scoped avatar uploads.
- The final dependency audit finds no controller importing application models or provider utilities; remaining `mongoose` imports perform only HTTP identifier syntax validation.

# 4. Evidence

| Requirement | Evidence | Result |
|---|---|---|
| Backend type safety | `npm run type-check` | Passed |
| Backend compilation | `npm run build` baseline | Passed |
| Backend migration/application/unit tests | `npm test` | Passed: 129 tests, including enforced controller dependency boundaries, tenant migration scoping, admin self-profile security/storage, versioned extraction, verified authentication, and migration safety |
| Backend composite gate | `npm run ci` | Passed locally and remotely: contract check, zero-warning new-code/CLI lint, type-check, migration CLI compile/help check, 129 tests, production build |
| Frontend lint | `npm run lint` | Passed |
| Frontend composite gate | `npm run ci` | Passed locally and remotely: contract check, lint (0 errors), type-check, 186 tests, production build |
| Frontend dependency audit | `npm ci` audit summary | 8 findings: 1 low, 4 moderate, 3 high; remediation review required |
| Backend locked installation | `npm ci` | Passed; lock file is now a tracked deliverable candidate |
| Backend dependency audit | `npm ci` audit summary | 10 findings: 3 moderate, 7 high; remediation review required |
| Frontend CI definition | `.github/workflows/ci.yml` | Passed on pushed commit `89f8190` ([run 29487520911](https://github.com/BayshoreCommunication/dxg-rfp-tool-dashboard/actions/runs/29487520911)) |
| Backend CI definition | `.github/workflows/ci.yml` | Passed on pushed commit `7f97c51` ([run 29487519383](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/actions/runs/29487519383)) |
| Production validation gate | `.github/workflows/deploy.yml` | Implemented; remote run pending |
| Architecture boundaries | Both repository architecture READMEs | Implemented |
| Contract synchronization | `node scripts/verify-contract-sync.mjs` | Passed: 9 synchronized artifacts |

# 5. Remaining Slice 1A acceptance work

1. Obtain explicit client acceptance of the completed Slice 1A evidence pack.
2. Review and remediate the frontend dependency vulnerabilities without applying unsafe forced upgrades.
3. Expand fixtures for additional persisted variants when an approved sanitized sample is available; this is continuing coverage, not a blocker to the current baseline.
4. Canonical proposal snapshot migration dry-run remains separate from the completed DXG tenant migration and requires its own reconciliation review.
5. Continue enforcing the proven application/port/adapter pattern as later AI, queue, observability, and security workstreams begin. The currently inventoried proposal, extraction, settings, notification, dashboard, vendor-response, email, administration, account/profile, and authentication controller workflows are separated.
6. Track replacement of raw-ObjectId public access with scoped, expiring, revocable share tokens as a Workstream 1B entry requirement; it is not implemented or authorized by Slice 1A.
7. Verify the revised production deployment only during a separately authorized non-production/production release exercise; branch CI is verified and no production deployment was triggered.

# 6. Current slice decision

**Implementation and evidence are complete; explicit client acceptance is requested.** Both composite repository gates pass locally and in GitHub clean runners, all inventoried HTTP controllers are separated from direct persistence/provider dependencies, generated contracts are synchronized, and the test database tenant migration is reconciled. Tokenized public access remains a separately gated Slice 1B requirement.
