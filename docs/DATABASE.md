# Database and Storage

> Purpose: data ownership, consistency, and migration rules. Last updated: 2026-08-12. Owner: backend engineering.

## Ownership

| Store | Owns | Does not own |
|---|---|---|
| MongoDB | Proposal content/lifecycle and vendor submission/version authority | AI runs and queue state |
| PostgreSQL + pgvector | AI jobs/runs, evidence, conversations, reviews, knowledge, pricing, requirement/evaluation versions, audit, outbox | Proposal content authority |
| Redis | BullMQ delivery references, shared rate-limit state | Business content or durable job truth |
| Private object storage | Quarantined and clean source bytes | Public files or application authorization |

PostgreSQL tenant tables use forced row-level security. Cross-store records use external references rather than duplicating proposal content. Queue recovery starts from PostgreSQL/outbox, not Redis.

## Migrations

- PostgreSQL migrations are ordered under `src/platform/postgres/migrations/` and run through the repository migration command.
- Canonical proposal migration is non-destructive: immutable Mongo snapshots, dry-run by default, explicit tenant/run IDs, and no legacy overwrite.
- Cross-store deletion uses purge propagation and must preserve audit-safe evidence without retaining deleted business content.
- Schema changes that alter ownership or trust boundaries require an entry in [DECISIONS.md](DECISIONS.md).

## Vendor submission versions

- `VendorSubmission` is the stable proposal/vendor identity and points to the current immutable version.
- `VendorSubmissionVersion` is append-only. It stores parent/version/reason, snapshotted contact/message, ordered document manifest, source IDs, checksums, scan state, receipt time, and a tenant-scoped idempotency key.
- `VendorResponse` remains a latest-version compatibility projection until downstream analysis and inbox reads migrate. It is not version history.
- PostgreSQL migration 044 extends governed `document_sources` with `vendor_submission` purpose and Mongo submission/version linkage. Public submitters are deliberately not represented as planner users.
- `npm run backfill:vendor-submission-versions` is dry-run by default; `--apply` performs idempotent v1 projection and writes a checksummed migration-journal outcome.
- PostgreSQL migration 045 adds `requirement_sets`, `requirements`, `evaluation_matrix_versions`, `evaluation_criteria`, and idempotent registry-operation records. All five tables use forced organization RLS.
- A requirement set records the authoritative Mongo proposal version and checksum plus the accepted rendered-RFP run/checksum. Freshness is evaluated against Mongo on read; staleness does not mutate a frozen set.
- Draft/in-review requirements are editable with a set-level lock version. Database triggers reject edits/deletes to approved or superseded sets and their children; supersession links the old approved set to a newly generated draft.

## Pricing data

The operator imports the proprietary workbook with `scripts/importPricingWorkbook.ts`. Import is idempotent on category, subcategory, and item label. The workbook itself stays outside git.

Detailed entity and migration history lives in the relevant `architecture/` records and source migrations; source migrations are authoritative for exact columns.
