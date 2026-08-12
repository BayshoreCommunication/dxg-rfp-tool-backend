# API Guide

> Purpose: API discovery and contract ownership. Last updated: 2026-08-12. Owner: backend engineering.

## Contract rules

- Versioned governed endpoints use `/api/v1`.
- Authentication is necessary but resource ownership/tenant authorization is checked separately.
- Mutation and durable-job creation endpoints use idempotency keys where duplicate side effects or provider charges are possible.
- Long-running operations return durable job/run references; clients recover through reads and SSE/status updates.
- Proposal writes validate canonical paths/values and use version checks against MongoDB authority.
- Public proposal payloads use an allowlisted projection.

## Version-aware vendor submissions

- `GET /api/vendor-responses/check` returns the stable submission ID, current version number, latest version ID, revision eligibility, and the latest compatibility response.
- `POST /api/vendor-responses` accepts `submissionIdempotencyKey` (or `Idempotency-Key`) and optional `submissionReason`. It creates version 1 or a new immutable revision; an idempotent replay returns the original version and receipt.
- `GET /api/vendor-responses/receipt/:versionId?proposalId=...&email=...` requires the same scoped `vendor:submit` public grant and a normalized vendor-email match. It returns version, checksum, timestamps, and safe file metadata without private object URLs.
- Existing authenticated list/detail endpoints return current version metadata while retaining their response shape.

## Where to find endpoints

- Backend route overview and legacy API: `../README.md`.
- AI component endpoints and payload examples: the relevant file under `architecture/`.
- Exact executable behavior: route/controller schemas in `src/`; code wins if an old slice example differs.
- Operational health and dependencies: [runbooks/API_AND_DEPENDENCIES.md](runbooks/API_AND_DEPENDENCIES.md).

The repository does not currently publish a generated OpenAPI contract. Adding one from runtime schemas is a documentation gap; until then, avoid copying full endpoint catalogs into multiple documents.
