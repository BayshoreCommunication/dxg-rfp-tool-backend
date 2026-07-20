# Slice 2B Approval Policy — Interim Amendment

## Decision

For the current test-environment phase, an authenticated organization administrator with `knowledge:approve` permission may upload, review, submit, approve, and publish the same knowledge-resource version.

Independent approval is deferred to a future governance increment. It can be enabled with:

```env
KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED=true
```

The interim default is `false`.

## Required safeguards

- Approval remains an explicit action; upload or submission never auto-approves a release.
- Fragment review is optional. On submission, unreviewed fragments are recorded as accepted by default; rejected or flagged fragments are excluded from the release.
- The approval endpoint still requires `knowledge:approve` permission.
- PostgreSQL row-level security continues to enforce organization isolation.
- The review version records `submitted_by_external_user_id`.
- The separate approval decision records `decided_by_external_user_id`.
- The published release separately records `approved_by_external_user_id`.
- Correlation IDs, timestamps, immutable review checksums, fragment provenance, and audit events remain unchanged.
- Only accepted fragments enter the immutable release manifest.
- Superseded, revoked, expired, rejected, or unapproved content remains ineligible for future retrieval.
- Approval does not enable AI retrieval, live-model processing, or proposal auto-application.

The submitter and approver fields may contain the same administrator ID during this interim phase. Keeping the records separate allows DXG to restore independent approval later without a database redesign.

## Current workflow

```text
Admin uploads
    -> private validation and malware scan
    -> parsing into traceable fragments
    -> admin optionally reviews exceptions
    -> admin explicitly submits immutable version
    -> authorized admin approves
    -> approved release is published
```

## Future transition

When DXG activates independent approval, set `KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED=true`. The API will then reject a decision when the deciding user is also the submitter. Role assignment and operational procedures must ensure another authorized approver is available before enabling the flag.

## Acceptance criteria

1. Same-admin approval succeeds when the flag is absent or `false`.
2. Same-admin approval returns `SELF_APPROVAL_FORBIDDEN` when the flag is `true`.
3. Users without `knowledge:approve` remain unable to approve.
4. Submission and approval actors remain separately auditable, even when their IDs match.
5. Tenant isolation, version immutability, release eligibility, and revocation behavior are unchanged.
6. A review may be submitted without deciding every fragment; unreviewed fragments become accepted decisions at submission time.
