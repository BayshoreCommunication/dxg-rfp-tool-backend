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

## Organization invitations (ORG-203)

Routes in `routes/invitationRoute.ts`, rules in `src/modules/invitations/domain/invitationRules.ts`.

- `GET /api/v1/organization/invitations?status=` lists invitations the caller may manage (Owner/Admin: all; Team Manager: their teams, when `allowManagerInvites` is on).
- `POST /api/v1/organization/invitations` `{ email, role, teamId? }` invites one person; `POST .../bulk` `{ emails: string | string[], role, teamId? }` takes up to 500 entries and answers with one result per row (`invited`, or `refused` with a code such as `INVALID_EMAIL`, `DUPLICATE_IN_LIST`, `ALREADY_INVITED`, `ALREADY_MEMBER`, `EMAIL_IN_ANOTHER_ORGANIZATION`, `LEGACY_ACCOUNT_PENDING_PLACEMENT`).
- `POST .../:id/resend` rotates the link (the old one stops working at once) and restarts the 7-day expiry; `POST .../:id/revoke` withdraws it.
- Public, token in the body: `POST /api/v1/invitations/lookup` `{ token }` returns organization, role, inviter, email and whether an account exists. `POST /api/v1/invitations/accept` `{ token, email, password }` signs an existing account in (the email must equal the invited one); `POST /api/v1/invitations/accept/register` `{ token, name, password }` creates the account in the inviting organization. Both return a session like `/api/auth/login`. Role, team and organization come only from the invitation.
- Emails (ORG-204) go through `utils/emailService.ts` (`sendTransactionalEmail`, no fixed-recipient copy) and link to `${FRONTEND_URL}/invite/<token>`, so `FRONTEND_URL` must be the dashboard origin. The cron worker's invitation sweep (every 15 minutes) expires invitations, sends the day-six reminder once per link with a fresh link, and retries failed sends up to five attempts. Under `NODE_ENV=test` mail goes to an in-memory recorder.
- Dead links answer `404 INVITATION_INVALID` or `410` with `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_ALREADY_USED` or `INVITATION_SUPERSEDED`; none of them names the organization or email.
## Teams

Team administration (ORG-201) lives in `routes/teamsRoute.ts`; rules in `src/modules/teams/application/manageTeams.ts`. Every change writes a `SecurityAuditEvent` (`team.created`, `team.renamed`, `team.archived`, `team.member_added`, `team.member_removed`, `team.manager_changed`).

- `GET /api/v1/teams` — Owners and Admins get every team with its members; other members get `{ id, name }` for active teams.
- `POST /api/v1/teams` `{ name }`, `GET|PATCH /api/v1/teams/:teamId` `{ name }`, `POST /api/v1/teams/:teamId/archive` — Owner/Admin only. Active names are unique per organization, ignoring case (409 `TEAM_NAME_TAKEN`). Archived teams can't be changed (409 `TEAM_ARCHIVED`).
- `POST /api/v1/teams/:teamId/members` `{ userId, isManager? }`, `PATCH /api/v1/teams/:teamId/members/:userId` `{ isManager }`, `DELETE /api/v1/teams/:teamId/members/:userId` — Owner/Admin only. Members must be active in the organization; a manager must hold the `team_manager` role (422 `TEAM_MANAGER_ROLE_REQUIRED`).
- Proposal team (ORG-202): `POST /api/proposals` and copy put a new proposal on its creator's team when they're on exactly one active team (a client-sent `teamId` is ignored). `PUT /api/proposals/:id` with `teamId` (an active team in the organization, or `null`) changes it for anyone allowed to edit; anything else is 422 `TEAM_NOT_ASSIGNABLE`. Resending the current team's id is accepted even after that team is archived.

## Proposal sharing

Sharing (ORG-208) lives in `routes/rfpSharesRoute.ts`; rules in `src/modules/rfpSharing/application/manageRfpShares.ts`. Who may share is the access policy's `share` decision: the proposal's owner, a manager of its (active) team, or an Owner/Admin.

- `GET /api/v1/proposals/:proposalId/shares` lists shares as `{ userId, permission, grantedBy, memberActive, createdAt, updatedAt }`. `memberActive: false` marks a deactivated member's share, which is kept but grants nothing.
- `PUT /api/v1/proposals/:proposalId/shares/:userId` `{ permission: "view" | "edit" }` grants or changes a share; `DELETE` revokes it. The member must be active in the same organization (404 `MEMBER_NOT_FOUND`, 409 `MEMBER_INACTIVE`); Viewers get view only (422 `VIEWER_VIEW_ONLY`). Grants and revocations write `proposal.share_granted` / `proposal.share_revoked` audit events.
- A share reaches list, detail and vendor-response reads through `rfpListScope` and `canAccessRfp`; an edit share also allows edits.

## Two-factor authentication (ORG-303, ORG-304)

Routes in `routes/twoFactorRoute.ts` (`/api/auth/2fa`) and `routes/organizationSecurityRoute.ts`; rules in `src/modules/twoFactor/`.

- `POST /api/auth/2fa/disable` `{ password?, code | recoveryCode }`: a current TOTP or recovery code is always required. `password` is required too unless the account is linked to Google sign-in, which may have no password its owner knows; a wrong password is never ignored (401 `REAUTHENTICATION_FAILED`).
- Wrong codes are counted per account across challenges and IPs, and each attempt is counted before the code is checked. Ten failures lock the second factor for 15 minutes (429 `TWO_FACTOR_LOCKED` with `Retry-After`); each further lock before a successful code doubles, up to 24 hours. Signed-in 2FA endpoints are also limited per user, whatever the IP.
- `POST /api/organization/members/:userId/two-factor/reset` answers 409 `TWO_FACTOR_RESET_SHARED_ACCOUNT` when the member is also active in another organization: the enrolment belongs to the person, so only DXG support resets it.

## Organization domains (ORG-305)

Routes under `/api/organization/domains` (`organization:manage`); rules in `src/modules/domainVerification/`.

- `POST /api/organization/domains` `{ domain }` answers 201 with the TXT record to publish, also for a domain another organization already holds verified: the response never says a domain is taken. Such a domain stays `pending` and its checks report `lastCheckOutcome: "not_verified"`, because only one organization can hold a domain verified. Refusals: 400 `DOMAIN_INVALID`, 422 `DOMAIN_NOT_VERIFIABLE` (public mail providers), 409 `DOMAIN_LIMIT_REACHED`, 409 `DOMAIN_ALREADY_ADDED`.
- The cron worker checks due domains every 15 minutes, five at a time, leasing each record so concurrent tasks don't check it twice. A check that errors is retried after an hour (`dns_error:<code>` or `check_failed`).

## Where to find endpoints

- Backend route overview and legacy API: `../README.md`.
- AI component endpoints and payload examples: the relevant file under `architecture/`.
- Exact executable behavior: route/controller schemas in `src/`; code wins if an old slice example differs.
- Operational health and dependencies: [runbooks/API_AND_DEPENDENCIES.md](runbooks/API_AND_DEPENDENCIES.md).
- Helpdesk (support tickets): `routes/supportDeskRoute.ts` — planner routes under `/api/v1/support`, agent routes under `/api/v1/admin/support`; validation and status rules in `src/modules/supportDesk/domain.ts`.

The repository does not currently publish a generated OpenAPI contract. Adding one from runtime schemas is a documentation gap; until then, avoid copying full endpoint catalogs into multiple documents.
