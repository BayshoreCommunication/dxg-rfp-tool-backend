# ADR-002 — Non-Destructive Canonical Proposal Migration

**Status:** Accepted and implemented for dry-run/staging use  
**Date:** July 16, 2026  
**Scope:** Milestone 1 Slice 1A

## Context

Existing proposals are stored in MongoDB with partially typed event/contact fields and multiple `Schema.Types.Mixed` sections. Canonical `proposal.v1` normalizes lifecycle, dates, counts, booleans, measurements, contacts, source references, and proposal sections. Replacing legacy documents in place would create unacceptable data-loss and rollback risk.

## Decision

1. Do not overwrite or delete legacy proposal documents during canonical migration.
2. Create immutable canonical snapshots in a separate `ProposalCanonicalSnapshot` collection.
3. Identify a snapshot by legacy proposal ID, stable legacy-content hash, and migration release.
4. Default the CLI to dry-run; require explicit `--apply` for writes.
5. Classify each candidate as `ready`, `needs_review`, or `failed`.
6. Store mapping issues and canonical validation results with the protected snapshot.
7. Require an explicit organization ID because legacy records are not yet tenant-owned.
8. Paginate by ascending Mongo ObjectId checkpoint and cap batch size.
9. Make re-running the same legacy hash/release idempotent through a unique index and insert-if-absent behavior.
10. Roll back only snapshots from an exact organization/run ID; legacy data remains untouched.
11. Ordinary CLI output contains IDs, hashes, status, and issue counts—not proposal content.

## Why snapshots instead of in-place updates

- Existing application behavior remains unchanged.
- Canonical output can be compared with legacy output before cutover.
- Invalid or ambiguous records are reviewable without corrupting production data.
- A release can be discarded by run ID while preserving source records.
- Multiple mapping releases can be evaluated safely.

## Alternatives rejected

### In-place conversion

Simpler storage, but destructive, hard to audit, and unsafe for mixed legacy values. Rejected.

### Read-time conversion only

Avoids migration storage but repeatedly performs conversion, hides data-quality totals, and makes cutover evidence difficult. Retained only as a temporary compatibility behavior, not the migration record.

### Immediate PostgreSQL proposal migration

Could provide stronger relational controls but combines contract, tenancy, and database migration risks in one change. Deferred until the canonical snapshot and tenant foundation are accepted.

## Consequences

- Temporary duplicate proposal representations require reconciliation and retention rules.
- Snapshot access must be restricted because canonical data remains confidential.
- `needs_review` cases require a controlled DXG/Bayshore review workflow before cutover.
- Actual production backfill remains gated by a database backup, tenant mapping, approved run ID, dry-run report, and change window.

## Evidence

- Stable hash tests.
- Invalid-value review-routing tests.
- Dry-run no-write tests.
- Apply idempotency tests.
- Rollback preview/apply tests.
- [Canonical Proposal Migration Runbook](./RFPilot_AI_Canonical_Proposal_Migration_Runbook.md).

