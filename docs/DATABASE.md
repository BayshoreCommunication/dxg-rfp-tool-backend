# Database and Storage

> Purpose: data ownership, consistency, and migration rules. Last updated: 2026-11-11. Owner: backend engineering.

## Ownership

| Store | Owns | Does not own |
|---|---|---|
| MongoDB | Proposal content/lifecycle and vendor submission/version authority | AI runs and queue state |
| PostgreSQL + pgvector | AI jobs/runs, evidence, conversations, reviews, knowledge, pricing, requirement/evaluation versions, audit, outbox | Proposal content authority |
| Redis | BullMQ delivery references, shared rate-limit state | Business content or durable job truth |
| Private object storage | Quarantined and clean source bytes | Public files or application authorization |

PostgreSQL tenant tables use forced row-level security. Cross-store records use external references rather than duplicating proposal content. Queue recovery starts from PostgreSQL/outbox, not Redis.

## Migrations

- PostgreSQL migrations are ordered under `migrations/postgres/` (`NNN_name.up.sql` with a matching `.down.sql`) and run through the repository migration command.
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

## Teams and sharing

- `Team` (organization, name, archived) and `TeamMembership` (team, user, `isManager`, unique per team and user). Active team names are unique per organization, ignoring case. Archiving keeps memberships; the authenticate middleware reads managed teams from active teams only, so an archived team's managers lose its scope on their next request.
- `Proposal.teamId` (optional, indexed with `organizationId`) is the team whose managers reach the proposal.
- `RfpShare` (organization, proposal, user, `permission` view|edit, `grantedBy`; unique per proposal and user). Revoking deletes the row (the audit event keeps the record); a deactivated member's rows are kept and ignored, because actor lookups run for active members only.

## Organization Accounts: what M4, M5 and the launch gate added

Everything these milestones added is in MongoDB. None of them added a PostgreSQL migration (the latest is still 065) or a PostgreSQL table. The sections below cover each item once:

| Collection or field | Ticket | Section |
|---|---|---|
| `Proposal.lifecycle`, `ProposalStatusTransition` | ORG-403 | RFP lifecycle |
| `SupportAccessGrant` | ORG-404 | Support access grants |
| `SecurityAuditEvent` index change, `auth.login.failed` action | ORG-407 | Organization audit log |
| `Organization.plan`, `Organization.proposalsCreated` | ORG-601, ORG-603 | Plans |
| `OrganizationVendor` | ORG-606 | Organization vendor list |
| `ProposalTemplate` | ORG-604 | RFP templates |
| `OrganizationMembership.firstRfpOpenedAt`, `SecurityAuditEvent` index `{ action, createdAt }` | ORG-505 | Launch metrics |

## RFP lifecycle

- `Proposal.lifecycle` (ORG-403) holds the derived stage plus the facts it comes from: `revision` (the compare-and-set token), `stage`, `status` as of the last transition, `changedAt`, the award (`awardedAt`, `awardedByUserId`, `awardSource` manual|comparison, `awardDecisionId`), `reviewStartedAt`, `vendorsInvited` (distinct recipients of `vendor:submit` grants) and `vendorsResponded` (VendorResponse rows). Indexed as `{ organizationId, lifecycle.stage, updatedAt }`.
- `ProposalStatusTransition` is append-only (the model throws on every update path). Each row has the organization, proposal, from/to stage and status, actor type and user, reason and time. Rows outlive a deleted proposal and go only with their organization.
- The lifecycle write and its transition commit in one Mongo transaction, guarded by the proposal's status, draft and archive flags and `lifecycle.revision`.
- `npm run backfill:proposal-lifecycle` is dry-run by default. `--apply` recomputes counts, fills a missing review start or comparison award from Postgres `comparison_runs`/`comparison_decisions` under the organization's RLS context, and appends a `backfill` transition only where the stage or status changed.

## Support access grants

- `SupportAccessGrant` (ORG-404; MongoDB): organization, `proposalId` (null for the whole organization), `grantedBy`, optional `reason`, `expiresAt` (the model refuses more than 30 days from creation), `revokedAt`, `revokedBy`. Rows are never deleted. Indexed `{ organizationId, createdAt }` and `{ revokedAt, expiresAt }`. No Postgres table.
- Support activity is not a separate collection: it is the `SecurityAuditEvent` rows with action `support_access.used` in the customer's organization, joined to a grant by `metadata.grantId`.

## Helpdesk (support tickets)

- `SupportTicket`, `SupportMessage`, `SupportAttachment`, `SupportCannedReply` and `SupportTicketCounter` (MongoDB only). A ticket and all of its messages carry the `organizationId` of the customer who opened it, whoever writes the message: an RFPilot staff reply is stored in the customer's organization, not the agent's.
- `ticketNumber` comes from `SupportTicketCounter`, one sequence per organization, unique on `{ organizationId, ticketNumber }`. It is not unique across organizations and is never renumbered; the ticket `_id` is the global identifier.
- Customer reads always filter by the session's organization and the requester. The only reads without an organization filter are the RFPilot staff inbox (`findTicketInAnyOrganization`, `listTicketsInAnyOrganization`, `metricsForAllOrganizations`, `staffAgentLoads` in `mongoSupportDeskRepository.ts`) and the sweeper; each is marked `scope-exempt:` and `tests/tenant-scope-guard.test.js` covers both models.
- `SupportAttachment` rows and S3 keys (`support-attachments/<organizationId>/…`) belong to the uploader's organization, so an agent's upload sits under the staff organization while the message that cites it sits in the customer's. `SupportCannedReply` rows belong to the staff organization.
- Agents are `admins` accounts (`assigneeUserId` and agent `authorUserId` point there); requesters are `users` accounts in the ticket's organization.

## Organization audit log

- No new collection (ORG-407). The audit view reads `SecurityAuditEvent` for one organization, newest first, paged by `(createdAt, _id)`. The index `{ organizationId, createdAt }` is extended to `{ organizationId: 1, createdAt: -1, _id: -1 }` so that order comes from the index; Mongoose builds the new index on start-up (automatic index builds are not switched off anywhere in this repository) but never drops one, so the old two-field index (now a redundant prefix) stays on a deployed database until someone drops it by hand. Rows stay append-only; the view never writes. `auth.login.failed` is a new action on the same collection.

## Plans

- `Organization.plan` (`free_trial` | `full_access`, default `free_trial`) and `Organization.proposalsCreated` (ORG-601). The counter is incremented by one conditional update inside the transaction that inserts a proposal (`claimProposalSlot`), and nothing decrements it. Organizations that existed before ORG-601 start from the stored value, which is 0 unless set: their earlier proposals are not counted.
- Plan management (ORG-603) adds no collection or field. A plan change and its `organization.plan_changed` `SecurityAuditEvent` are written in one MongoDB transaction in the organization whose plan changed; the plan history the admin app shows is read from those events.

## Organization vendor list

- `OrganizationVendor` (organization, `company`, `category`, `contacts` [`name`, `email`], `addedBy`, `archived`, `archivedAt`), ORG-606. Active company names are unique per organization, ignoring case (partial unique index with a case-insensitive collation); an archived name can be reused. Read and written only by `src/modules/organizationVendors`, always with `organizationId` in the filter (the tenant-scope guard covers the model). Legacy holding tenants have no vendor list: their members can't sign in.

## RFP templates

- `ProposalTemplate` (organization, `ownerUserId`, `scope` personal|organization, `title`, `description`, `content`, `presentationLayout`, `publishedAt`, `publishedBy`, `archived`, `archivedAt`), ORG-604. `content` is a snapshot of an RFP's content sections built by `src/modules/proposals/domain/templateSnapshot.ts` (no vendors, responses, dates, files, contacts or system fields); it is customer content and is never copied across organizations. Read and written only by `src/modules/proposalTemplates`, always with `organizationId` in the filter (the tenant-scope guard covers the model); the list query also carries the visibility rule (own personal templates, published organization templates, and for Owners and Admins every organization template). An RFP started from a template is inserted by the proposals module's `createOwned`, never by this module.

## Launch metrics

- ORG-505 adds no collection or table. `OrganizationMembership.firstRfpOpenedAt` (null until the member first opens an RFP in that organization, then never changed; like `lastSignedInAt` it doesn't bump `version`) is the only new field. `SecurityAuditEvent` gains the index `{ action, createdAt }` for counting one action across organizations.
- The report (`src/modules/launchMetrics/mongoLaunchMetricsSource.ts`) reads `Invitation`, `OrganizationMembership`, `Organization`, `SecurityAuditEvent` and `SupportAccessGrant` across all organizations and projects dates and counts only.

## Pricing data

The operator imports the proprietary workbook with `scripts/importPricingWorkbook.ts`. Import is idempotent on category, subcategory, and item label. The workbook itself stays outside git.

Detailed entity and migration history lives in the relevant `architecture/` records and source migrations; source migrations are authoritative for exact columns.
