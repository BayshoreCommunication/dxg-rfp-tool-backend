# Database and Storage

> Purpose: data ownership, consistency, and migration rules. Last updated: 2026-07-22. Owner: backend engineering.

## Ownership

| Store | Owns | Does not own |
|---|---|---|
| MongoDB | Proposal content, lifecycle, legacy application records | AI runs and queue state |
| PostgreSQL + pgvector | AI jobs/runs, evidence, conversations, reviews, knowledge, pricing, audit, outbox | Proposal content authority |
| Redis | BullMQ delivery references, shared rate-limit state | Business content or durable job truth |
| Private object storage | Quarantined and clean source bytes | Public files or application authorization |

PostgreSQL tenant tables use forced row-level security. Cross-store records use external references rather than duplicating proposal content. Queue recovery starts from PostgreSQL/outbox, not Redis.

## Migrations

- PostgreSQL migrations are ordered under `src/platform/postgres/migrations/` and run through the repository migration command.
- Canonical proposal migration is non-destructive: immutable Mongo snapshots, dry-run by default, explicit tenant/run IDs, and no legacy overwrite.
- Cross-store deletion uses purge propagation and must preserve audit-safe evidence without retaining deleted business content.
- Schema changes that alter ownership or trust boundaries require an entry in [DECISIONS.md](DECISIONS.md).

## Pricing data

The operator imports the proprietary workbook with `scripts/importPricingWorkbook.ts`. Import is idempotent on category, subcategory, and item label. The workbook itself stays outside git.

Detailed entity and migration history lives in the relevant `architecture/` records and source migrations; source migrations are authoritative for exact columns.
