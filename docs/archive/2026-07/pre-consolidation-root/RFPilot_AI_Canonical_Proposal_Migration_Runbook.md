# RFPilot AI Intelligence Layer

## Canonical Proposal v1 Migration Runbook

**Status:** Implementation-ready; no production migration executed  
**Migration release:** `proposal-v1.0.0`  
**Strategy:** Non-destructive immutable Mongo snapshots  
**Last updated:** July 16, 2026

---

# 1. Outcome

The migration reads legacy proposals, maps them through the validated canonical adapter, and optionally inserts immutable canonical snapshots. It never edits or deletes the legacy proposal source.

Each candidate is classified:

- `ready`: canonical validation passed without missing, invalid, or unmapped issues.
- `needs_review`: canonical data is valid, but an ambiguity, invalid legacy value, or unmapped source/production field requires review.
- `failed`: required content is missing or canonical validation failed.

# 2. Safety controls

- Dry-run is the default.
- `--apply` is required for writes and rollback deletion.
- Organization ID is mandatory.
- Batches are limited to 1–1,000 proposals and default to 100.
- Pagination uses an `_id` checkpoint; no skip-based drift.
- Stable SHA-256 legacy hashes make identical reruns idempotent.
- Unique index covers legacy ID, legacy hash, and migration release.
- Snapshots contain run ID, status, issues, canonical data, and source update time.
- CLI output never prints canonical proposal content.
- Rollback targets one organization and one exact run ID.
- Legacy proposals remain authoritative until a later approved cutover.

# 3. Prerequisites for any environment

- [ ] Environment and database explicitly identified.
- [ ] Named migration operator and approver.
- [ ] Organization/tenant mapping approved.
- [ ] Current database backup verified.
- [ ] Canonical schema release and application commit recorded.
- [ ] Dependency lock installed with `npm ci`.
- [ ] Backend CI and migration tests pass.
- [ ] Data retention and snapshot access approved.
- [ ] Expected proposal count recorded.
- [ ] Production change window and rollback owner approved when applicable.

# 4. Commands

Run from `dxg-rfp-tool-backend` with the same database configuration used by the service: `MONGODB_URL` or `MONGO_URL`. The migration CLI also accepts the compatibility aliases `MONGODB_URI` and `MONGO_URI`.

## Help

```bash
npm run migrate:proposal-v1 -- --help
```

## Dry-run first batch

```bash
npm run migrate:proposal-v1 -- --organization-id=ORG_ID --run-id=RUN_ID --limit=100
```

## Dry-run next batch

Use the previous `lastProposalId`:

```bash
npm run migrate:proposal-v1 -- --organization-id=ORG_ID --run-id=RUN_ID --limit=100 --after-id=LAST_PROPOSAL_ID
```

## Apply an approved batch

```bash
npm run migrate:proposal-v1 -- --organization-id=ORG_ID --run-id=RUN_ID --limit=100 --apply
```

## Preview rollback

```bash
npm run migrate:proposal-v1 -- --organization-id=ORG_ID --rollback-run=RUN_ID
```

## Apply rollback

```bash
npm run migrate:proposal-v1 -- --organization-id=ORG_ID --rollback-run=RUN_ID --apply
```

# 5. Dry-run review

For every batch record:

- Run ID and migration release.
- Scanned, ready, needs-review, and failed counts.
- Last proposal checkpoint.
- Candidate legacy IDs, hashes, statuses, and issue counts.
- Execution duration and environment.

Do not approve apply when:

- Organization mapping is uncertain.
- Failed records are unexplained.
- Material fields appear systematically unmapped.
- Source-reference issues would remove required proposal evidence.
- Counts differ from the inventory.
- Database backup or rollback ownership is missing.

# 6. Apply verification

After each approved batch:

1. Confirm `inserted + alreadyPresent` equals scanned count.
2. Confirm repeated execution moves records to `alreadyPresent`, not duplicate snapshots.
3. Compare a sample of ready snapshots with the legacy UI and public renderer.
4. Review every failed record and a risk-based sample of needs-review records.
5. Confirm snapshot collection tenant/run/status indexes exist.
6. Confirm application behavior still reads legacy proposals only.
7. Record the next checkpoint or stop decision.

# 7. Rollback

Rollback removes only snapshot documents for the exact organization and run. It does not modify legacy proposals.

1. Disable any future feature flag that reads canonical snapshots.
2. Run rollback preview and confirm matched count.
3. Obtain the named approver's confirmation.
4. Run rollback with `--apply`.
5. Confirm deleted count and absence of the target run.
6. Preserve the dry-run/apply evidence and incident/change reference.

# 8. Production cutover gate

This runbook does not authorize canonical read cutover. Cutover requires a later decision with:

- Complete representative fixture coverage.
- Approved reconciliation thresholds.
- Zero unexplained failed records.
- Reviewed needs-review disposition.
- Dual-read comparison results.
- Tenant-isolation tests.
- Monitoring and rollback feature flag.
- Signed DXG/Bayshore cutover approval.
