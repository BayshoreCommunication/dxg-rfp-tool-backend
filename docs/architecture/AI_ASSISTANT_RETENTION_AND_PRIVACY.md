# AI Assistant retention, deletion, and privacy

Status: implemented behind policy and execution gates; production purge disabled
by default.

## Data classes

| Data class | Authority | Default policy | Deletion behavior |
| --- | --- | --- | --- |
| Conversations, messages, citations | PostgreSQL assistant tables | 365 days | User deletion is a recoverable soft delete; purge only after grace, approved policy, and no hold |
| Feedback | PostgreSQL feedback table | 730 days | Removed with a purged conversation; independent policy expiry is reported for governance |
| Product analytics | Content-free PostgreSQL events | 400 days | Policy-window purge; no raw prompts or direct identifiers |
| Proposal analyses and findings | Deterministic guidance reports | 730 days | Previewed by cleanup; physical dependency order requires a separate approved maintenance change |
| Historical reference links | De-identified historical insight reports | 730 days | Previewed by cleanup; source authorization is revalidated at read time |
| Field-change proposals | Candidate review/application tables | Existing `retention_until` | Existing dependency-ordered cleanup boundary; no silent proposal mutation |
| Audit records | Append-only audit events | 2,555 days | Counted for review but never purged by the Assistant cleanup job |

The machine-readable catalog lives in `retentionPolicy.ts`. It is intentionally
conservative: audit, proposal-analysis, historical-reference, and field-change
records are not physically deleted by the initial Assistant job because their
referential and compliance requirements need independent approval.

## User deletion and recovery

Archive remains a reversible organization feature and does not request erasure.
Delete marks a user-owned conversation as archived, records `deleted_at`, and
sets `purge_after`. The default grace period is 30 days. An explicitly approved
organization retention policy may set 7–90 days.

Deleted conversations are excluded from ordinary history and message reads.
The owner can list recently deleted conversations and restore one before
`purge_after`. Every request and restore is owner-scoped, tenant-isolated, and
audited. Deletion does not claim immediate erasure from append-only audit records.

## Retention policy and legal holds

`assistant_retention_policies` is inert until its state is `approved` with a
named approver and approval timestamp. The cleanup command fails closed if no
approved row exists.

`assistant_legal_holds` can extend retention for an organization, Assistant
thread, proposal reference, or audit record. It cannot shorten retention. Active
organization or thread holds remove content from purge eligibility.

Organization offboarding should:

1. disable the Assistant cohort entitlement and generation flags;
2. place a legal hold if required;
3. approve the organization's retention policy;
4. request user/data-owner deletion as applicable;
5. run and retain a dry-run report;
6. obtain the production execution approval;
7. run bounded cleanup for that organization;
8. verify counts and retain content-free audit evidence.

## Provider storage

Both the general Platform Assistant and proposal-specific live AI requests set
the OpenAI Responses API request option `store: false`. RFPilot remains
responsible for its own PostgreSQL conversation and proposal records. Provider
contractual retention, abuse-monitoring exceptions, and regional processing
must still be confirmed by the release owner before production enablement.

API keys, provider payloads, system prompts, and chain-of-thought are not stored
in Assistant conversation, feedback, or analytics tables.

## Evaluation privacy

The versioned Assistant evaluation dataset must declare that it is synthetic
and reviewed and contains no production conversation content. The evaluator
fails integrity validation if that provenance contract is absent. Production
conversation exports must never be copied into fixtures; therefore a user
deletion cannot silently survive in the repository's evaluation dataset.
