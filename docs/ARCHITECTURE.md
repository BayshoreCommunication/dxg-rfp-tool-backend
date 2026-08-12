# RFPilot Architecture

> Purpose: current system map and source-of-truth boundaries. Last updated: 2026-08-12. Owner: engineering.

## System

```text
Planner dashboard ─┐
Admin application ─┼─ HTTPS ─> Express API ─> MongoDB (proposal content)
Vendor/public flow ┘                 │       ├> PostgreSQL + pgvector (AI domain)
                                     │       ├> private S3 (quarantine/sources)
                                     └> outbox -> Redis -> durable worker
                                                        └> ClamAV / OpenAI
```

The backend is a transitional modular monolith. The API creates authoritative records and outbox events; the dispatcher publishes reference-only messages; the durable worker resolves content from authoritative stores and performs scans, extraction, drafting, indexing, guidance, and vendor analysis.

## Repository responsibilities

- `dxg-rfp-tool-backend`: REST API, WebSocket/SSE support, legacy jobs, durable AI jobs, persistence, provider gateway, audit and usage reporting.
- `dxg-rfp-tool-dashboard`: planner authentication, proposal workflow, conversational assistant, review, guidance, publication controls.
- `dxg-rfp-tool-admin`: knowledge, pricing, user, and operational administration. Its backend bearer token stays server-side.

## Sources of truth

| Concern | Authority | Rule |
|---|---|---|
| Proposal content and lifecycle | MongoDB | AI does not become proposal authority. Writes use validation and version checks. |
| Vendor submission identity and immutable versions | MongoDB | A revision creates a new version; `VendorResponse` is only the latest-version compatibility projection. |
| AI runs, evidence, reviews, knowledge, pricing, audit, outbox | PostgreSQL | Tenant RLS and immutable/reconstructable records apply. |
| Requirement sets and evaluation-matrix versions | PostgreSQL | Derived from Mongo proposal authority; approved versions are immutable and become stale when proposal version/checksum changes. |
| Job transport and shared rate limits | Redis | References only; never proposal or document content. |
| Uploaded source bytes | Private S3-compatible storage | Quarantine, malware scan, retention, no public ACL. |
| Session/user identity | Existing application identity plus external IDs | Resource IDs are never authorization. |

## Primary proposal flow

1. A planner creates or opens a proposal and enters `/proposals/{id}/assistant`.
2. Typed messages and attachments enter the conversation. Attachments pass private upload and fail-closed malware scanning.
3. Eligible files and closed typed-conversation segments feed the same cited structured extraction. A detailed single-turn brief closes immediately; shorter chat can be closed explicitly with “Use what I’ve told you.”
4. Valid, high-confidence, single candidates may fill empty draft fields. Conflicts, existing values, low confidence, and invalid values require review.
5. Guided questions close high-impact gaps. Cited drafting, readiness guidance, and deterministic investment guidance follow.
6. A human reviews and publishes. The AI never publishes.

## Vendor submission flow

1. A scoped public grant admits a vendor response; every file is size/count bounded, scanned, and stored privately.
2. The client supplies a stable submission idempotency key. A retry returns the original receipt before scanning or uploading again.
3. The API resolves a stable vendor submission and creates an immutable version with parent, reason, ordered source manifest, and checksum.
4. The latest version is projected into the legacy vendor-response record for current inbox and analysis compatibility.
5. Eligible file metadata is registered in PostgreSQL under the governed `vendor_submission` source purpose. Registration is idempotent and may be reconciled by the backfill when the data foundation was temporarily unavailable.

## Requirement registry flow

1. The authenticated proposal owner requests generation with an idempotency key.
2. The API reads the current Mongo proposal and the latest human-accepted rendered-draft paragraphs, then deterministically creates structured and narrative requirements. No model call occurs in this task.
3. PostgreSQL stores a versioned requirement set, evaluation-matrix version, criteria, source locators, validation state, and content checksum under forced tenant RLS.
4. Planner edits use optimistic locking. Approval requires confirmed weights totaling 100 and explicit mandatory, criterion, and verification review for every requirement.
5. Approval freezes requirements and criteria at the database layer. A later Mongo proposal version or checksum mismatch is reported as stale; supersession creates a new draft version without rewriting the approved set.
6. Public receipts expose version and safe file metadata but never stored object URLs.

## Security and reliability boundaries

- All AI capabilities are deny-by-default through `AI_ENVIRONMENT`, per-capability flags, and kill switches.
- Source text is treated as data, not instruction. Structured output and citations are validated.
- Jobs, messages, applications, and provider attempts use idempotency controls.
- PostgreSQL is authoritative for durable work; Redis loss is recoverable from jobs/outbox.
- Private/quarantined storage, tenant isolation, malware scanning, citation validation, and human publication control are non-removable controls.

## Detailed references

- [AI layer](AI_LAYER.md)
- [Database](DATABASE.md)
- [Architecture component records](architecture/README.md)
- [Production topology](runbooks/PRODUCTION.md)
- [Dashboard boundaries](../../dxg-rfp-tool-dashboard/docs/architecture/README.md)
