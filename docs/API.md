# API Guide

> Purpose: API discovery and contract ownership. Last updated: 2026-09-14. Owner: backend engineering.

## Contract rules

- Versioned governed endpoints use `/api/v1`.
- Authentication is necessary but resource ownership/tenant authorization is checked separately.
- Mutation and durable-job creation endpoints use idempotency keys where duplicate side effects or provider charges are possible.
- Long-running operations return durable job/run references; clients recover through reads and SSE/status updates.
- Proposal writes validate canonical paths/values and use version checks against MongoDB authority.
- Public proposal payloads use an allowlisted projection.

## Version-aware vendor submissions

- `GET /api/vendor-responses/workspace?proposalId=...` requires a scoped `vendor:submit` public grant. It validates the grant against the proposal, lazily publishes the deterministic questionnaire when needed, and returns only the allowlisted vendor workspace contract: access state, questionnaire, draft, and current submission. Raw grant tokens, owner/organization IDs, private upload URLs, and unrelated proposal fields are never returned. Initial workspace reads may use a recipientless proposal grant; recipient-bound actions remain subject to their stricter checks.
- `POST /api/vendor-responses/questionnaires/publish` requires authentication, `vendor-response:write`, and proposal ownership. The body is `{ "proposalId": "..." }`. Publishing unchanged source data is idempotent; a changed proposal projection creates questionnaire version `n + 1` and supersedes the previous published version.
- `POST /api/vendor-responses/drafts` creates or resumes the one active draft for the validated invitation. The JSON body is `{ "proposalId": "..." }`. A new draft returns `201`; a resume returns `200`. The response includes the contract-shaped partial response and an allowlisted `documentManifest`, never grant material, private URLs, or object keys.
- `GET /api/vendor-responses/drafts/:draftId?proposalId=...` resumes an active, unexpired draft within the same tenant, proposal, grant ID, and grant-subject hash.
- `PATCH /api/vendor-responses/drafts/:draftId` saves a partial contract-shaped response. The body is `{ "proposalId": "...", "draftRevision": 3, "response": { ... } }`. Documents are server-managed and cannot be added through this JSON endpoint. A stale revision returns `409` with code `draft_conflict` and `latestDraftRevision`; it never overwrites the newer draft.
- `POST /api/vendor-responses/drafts/:draftId/documents?proposalId=...` accepts multipart field `documents` plus `draftRevision`, `purposeId`, `scopeType`, and optional `scopeId`. Supply the grant in the `x-rfpilot-access-grant` header or query because authorization runs before multipart bytes are accepted. Files must satisfy the pinned questionnaire category, scope, extension, detected MIME type, size, per-category count, global count, and malware-scan rules before association.
- `DELETE /api/vendor-responses/drafts/:draftId/documents/:documentId?proposalId=...&draftRevision=...` retires one active draft document and removes its structured references. Its private object is deleted only when no immutable submitted version references the document.
- `DELETE /api/vendor-responses/drafts/:draftId?proposalId=...&draftRevision=...` abandons a draft. A daily cleanup retires expired/abandoned draft objects, retaining any object referenced by an immutable submitted version and retrying provider failures.
- `POST /api/vendor-responses/drafts/:draftId/finalize` accepts `{ "proposalId": "...", "draftRevision": 3, "submissionIdempotencyKey": "..." }`; the key may instead be sent as `Idempotency-Key`. The server checks the current proposal lifecycle, validates the complete response against its pinned questionnaire, verifies the exact active document manifest, stamps accepted acknowledgements, calculates the authoritative totals, and creates one immutable structured version. A replay returns `200` with the original safe receipt; a new version returns `201`. The receipt includes the questionnaire reference, calculation snapshot, document disposition, and checksum but excludes private URLs, object keys, and the full response payload.
- `POST /api/vendor-responses/:submissionId/revision-drafts` accepts `{ "proposalId": "..." }` and creates or resumes a draft from that submission's current structured version. The submission must belong to the same tenant, proposal, and public grant. Documents from the current version are marked inherited; retiring one records its source version without deleting submitted evidence, while new uploads are marked added.
- `GET /api/vendor-responses/check` returns the stable submission ID, current version number, latest version ID, revision eligibility, and the latest compatibility response.
- `POST /api/vendor-responses` accepts `submissionIdempotencyKey` (or `Idempotency-Key`) and optional `submissionReason`. It creates version 1 or a new immutable revision; an idempotent replay returns the original version and receipt.
- `GET /api/vendor-responses/receipt/:versionId?proposalId=...&email=...` requires the same scoped `vendor:submit` public grant and a normalized vendor-email match. It returns version, checksum, timestamps, and safe file metadata without private object URLs.
- `POST /api/vendor-responses/manual` records a response the vendor delivered outside the portal. It requires authentication, `vendor-response:write`, and ownership of the proposal, and writes the same submission/version chain with `sourceSystem: "planner_upload"`. Neither the planner notification nor the vendor confirmation email is sent.
- `GET /api/vendor-responses/proposals` returns the planner's paginated proposal groups with counts and the exact owned response IDs in each displayed group so the dashboard can build an explicit, page-scoped deletion selection.
- `DELETE /api/vendor-responses/:id` permanently deletes one owned vendor response, its Mongo submission/version chain, and its private document objects. It requires authentication and `vendor-response:write`; a response outside the planner's tenant/ownership scope is returned as not found.
- `DELETE /api/vendor-responses` accepts JSON `{ "responseIds": ["..."] }` and permanently deletes that explicit selection (1–100 unique response IDs). Every requested response must belong to the authenticated planner in the active tenant; if any response is unavailable, the operation fails closed without deleting the rest. Registered document sources are tombstoned while immutable governed analysis and audit outputs follow their existing retention windows.

## Requirement registry

All routes are available by default without feature-flag environment variables. They still require an authenticated organization membership and proposal ownership. Reads require `proposal:read`; mutations require `proposal:write` and `Idempotency-Key`. Edit/approve requests also require the current set lock version through `If-Match` (or `expectedVersion`).

- `POST /api/v1/proposals/:proposalId/intelligence/requirement-sets` creates or idempotently returns a deterministic draft from current proposal fields and accepted rendered-RFP narrative.
- `GET /api/v1/proposals/:proposalId/intelligence/requirement-sets` lists versions with requirement counts and freshness.
- `GET /api/v1/proposals/:proposalId/intelligence/requirement-sets/:setId` returns the set, evaluation matrix, criteria, requirements, exact source locators, validation, and freshness reasons.
- `PATCH /api/v1/proposals/:proposalId/intelligence/requirement-sets/:setId/requirements/:requirementId` edits bounded review fields with optimistic locking.
- `POST .../:setId/approve` validates confirmed weights and completed human review, then freezes the version.
- `POST .../:setId/supersede` links an approved set to a new draft generated from the current proposal.

- Existing authenticated list/detail endpoints return current version metadata while retaining their response shape.

## Where to find endpoints

- Backend route overview and legacy API: `../README.md`.
- AI component endpoints and payload examples: the relevant file under `architecture/`.
- Exact executable behavior: route/controller schemas in `src/`; code wins if an old slice example differs.
- Operational health and dependencies: [runbooks/API_AND_DEPENDENCIES.md](runbooks/API_AND_DEPENDENCIES.md).

The repository does not currently publish a generated OpenAPI contract. Adding one from runtime schemas is a documentation gap; until then, avoid copying full endpoint catalogs into multiple documents.
