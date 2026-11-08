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
- `POST /api/v1/organization/invitations` `{ email, role, teamId? }` invites one person; `POST .../bulk` `{ emails: string | string[], role, teamId? }` takes up to 500 entries and answers with one result per row (`invited`, or `refused` with a code such as `INVALID_EMAIL`, `DUPLICATE_IN_LIST`, `ALREADY_INVITED`, `ALREADY_MEMBER`, `EMAIL_IN_ANOTHER_ORGANIZATION`, `LEGACY_ACCOUNT_PENDING_PLACEMENT`). `teamId` must be an active team of the organization (else `404 TEAM_NOT_FOUND`); on accept the member is added to it in the same transaction, or joins without a team if it was archived in between. An email whose invitation is past its expiry can be invited again at once, before the sweep marks it expired.
- `POST .../:id/resend` rotates the link (the old one stops working at once) and restarts the 7-day expiry; `POST .../:id/revoke` withdraws it.
- Sending limits (create, bulk and resend): the shared limiter allows 30 requests per 15 minutes per inviting user and 60 per organization (`429`, `Retry-After`). Each organization may queue at most `INVITATION_DAILY_EMAIL_LIMIT` invitation emails per UTC day (default 500), counting one per recipient, so a bulk paste counts every row that would be invited; a request that would go over is refused whole with `429 INVITATION_DAILY_LIMIT`, `remaining` and `Retry-After` (seconds to the next UTC day). An invitation can be resent once every five minutes (counted from the invite or the last resend): `429 INVITATION_RESEND_COOLDOWN` with `retryAfterSeconds`. Day-six reminders and delivery retries aren't counted.
- Public, token in the body: `POST /api/v1/invitations/lookup` `{ token }` returns organization, role, inviter, email and whether an account exists. `POST /api/v1/invitations/accept` `{ token, email, password }` signs an existing account in (the email must equal the invited one); `POST /api/v1/invitations/accept/register` `{ token, name, password }` creates the account in the inviting organization. `POST /api/v1/invitations/accept/google` `{ token, idToken }` is for accounts with no usable password (created by Google sign-in) and for Google sign-up: the verified Google email must equal the invited one (`403 INVITATION_EMAIL_MISMATCH`; a bad ID token is `401 INVALID_GOOGLE_IDENTITY`); an existing account joins, otherwise an account is created in the inviting organization with no organization of its own. All three return a session like `/api/auth/login`; the Google accept, like `/api/auth/google`, may instead return the 2FA step (`twoFactorRequired`). Role, team and organization come only from the invitation.
- Emails (ORG-204) go through `utils/emailService.ts` (`sendTransactionalEmail`, no fixed-recipient copy) and link to `${FRONTEND_URL}/invite/<token>`, so `FRONTEND_URL` must be the dashboard origin. The cron worker's invitation sweep (every 15 minutes) expires invitations, sends the day-six reminder once per link with a fresh link, and retries failed sends up to five attempts. Under `NODE_ENV=test` mail goes to an in-memory recorder.
- Dead links answer `404 INVITATION_INVALID` or `410` with `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_ALREADY_USED` or `INVITATION_SUPERSEDED`; none of them names the organization or email.
## Teams

Team administration (ORG-201) lives in `routes/teamsRoute.ts`; rules in `src/modules/teams/application/manageTeams.ts`. Every change writes a `SecurityAuditEvent` (`team.created`, `team.renamed`, `team.archived`, `team.member_added`, `team.member_removed`, `team.manager_changed`).

- `GET /api/v1/teams` — Owners and Admins get every team with its members; other members get `{ id, name }` for active teams.
- `POST /api/v1/teams` `{ name }`, `GET|PATCH /api/v1/teams/:teamId` `{ name }`, `POST /api/v1/teams/:teamId/archive` — Owner/Admin only. Active names are unique per organization, ignoring case (409 `TEAM_NAME_TAKEN`). Archived teams can't be changed (409 `TEAM_ARCHIVED`).
- `POST /api/v1/teams/:teamId/members` `{ userId, isManager? }`, `PATCH /api/v1/teams/:teamId/members/:userId` `{ isManager }`, `DELETE /api/v1/teams/:teamId/members/:userId` — Owner/Admin only. Members must be active in the organization; a manager must hold the `team_manager` role (422 `TEAM_MANAGER_ROLE_REQUIRED`).
- Proposal team (ORG-202): `POST /api/proposals` and copy put a new proposal on its creator's team when they're on exactly one active team (a client-sent `teamId` is ignored). `PUT /api/proposals/:id` with `teamId` (an active team in the organization, or `null`) changes it for anyone allowed to edit; anything else is 422 `TEAM_NOT_ASSIGNABLE`. Resending the current team's id is accepted even after that team is archived.

## Organization members

Membership management (ORG-206, ORG-207, ORG-307) lives in `routes/organizationMembersRoute.ts`, mounted at `/api/organization`, Owner/Admin only; rules in `src/modules/organizationMembers/application/manageMembers.ts`. Every write takes the member's current `version` (409 `STALE_VERSION` otherwise).

- `PATCH /members/:userId/role` `{ role, version }`. Becoming a Viewer while owning RFPs is 409 `OWNER_HAS_RFPS` with `ownedRfpCount`, checked again in the same transaction as the write. A demotion by someone else revokes all the member's sessions at once; any other role change revokes the member's other sessions on their next request (see DECISIONS.md).
- `PUT /members/:userId/teams` `{ teamIds, version }` makes the member's active teams exactly `teamIds` (ORG-201 Teams), keeping manager flags on teams they stay on and leaving archived teams' memberships as history. An archived team or another organization's team is 400 `UNKNOWN_TEAMS` with `unknownTeamIds`.
- `DELETE /api/users/:id` (legacy, platform admins only; no dashboard screen calls it) hard-deletes an account. It is refused with 409 `OWNER_HAS_RFPS` and `ownedRfpCount` while the user owns any RFP in any organization, so RFPs are never orphaned; organization members are deactivated and their RFPs reassigned instead.

## Legacy customer placement

ORG-110, DXG admins only, at `/api/admin/legacy-customers` (`routes/adminLegacyCustomersRoute.ts`, `src/modules/tenancy/legacyCustomerPlacement.ts`).

- `POST /:userId/placements` `{ target: "new", organization }` or `{ target: "existing", organizationId, role, teamId? }`. `teamId` must be an active team of that organization (400 `UNKNOWN_TEAM`). A second placement of the same user while one runs is 409 `PLACEMENT_IN_PROGRESS`. A failure leaves nothing moved (409 `PLACEMENT_FAILED`); a run whose ORG-109 checks fail is rolled back at once and answers 409 `PLACEMENT_VERIFICATION_FAILED` with `details.verification`.
- `POST /placements/:runId/rollback` moves back exactly the records the run moved (journaled ids); RFPs given to the user afterwards stay and are counted in `leftInTarget`. One rollback runs at a time (409 `ROLLBACK_IN_PROGRESS`, `ALREADY_ROLLED_BACK`); 409 `ROLLBACK_CONFLICT` when Postgres rows created since still depend on the user's rows.
- Until placed, the account can't use RFPilot: every sign-in method answers 403 `ORGANIZATION_SETUP_REQUIRED` (after the password or identity check, before 2FA), and any request on an existing session answers 401 `ORGANIZATION_SETUP_REQUIRED` and revokes all of that account's sessions.
- The API refuses placement with 503 `PLACEMENT_REQUIRES_MIGRATION_ROLE` when it has no `POSTGRES_MIGRATION_URL`, which is the case in production. There, run `node dist/scripts/placeLegacyCustomer.js` (`--list`; `--email --admin-email --new-org` or `--org-slug --role`; `--rollback=<runId>`; dry run unless `--apply`) as a one-off task on the migrate task definition, which holds both MongoDB and the migration role.

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

## Domain-match access requests (ORG-306)

Someone signing up with an email on a domain an organization has **verified** (ORG-305) is offered "Request access" instead of silently getting a separate organization. Claimed-but-unverified domains and public mail providers never match, and a match never reveals more than the organization's name, which only someone who passed the emailed code sees. Rules in `src/modules/accessRequests/`.

- `POST /api/auth/verify-otp` (signup) also answers `organizationMatch: { name } | null`.
- `POST /api/auth/register`, `POST /api/auth/google`: a NEW account on a matched domain answers 409 `ORGANIZATION_DOMAIN_MATCH` with `organizationName`, unless the body has `separateOrganization: true` (the person chose to create their own organization). Existing accounts sign in as before. A first Microsoft or company-SSO sign-in that would create an organization on a matched domain redirects with `error=ORGANIZATION_DOMAIN_MATCH`; the person can request access through email signup.
- `POST /api/auth/access-requests` `{ email, name }` (public; 5 per 15 minutes per email and IP). The email must hold a verified signup code (403 `EMAIL_NOT_VERIFIED`), which the request uses up. Answers 201 `{ status: "pending" | "invited", organizationName }`; `invited` when the organization auto-approves its domain (the invitation is sent at once, in the Owner's name). 409 `NO_ORGANIZATION_MATCH`, 409 `ACCOUNT_EXISTS`, 400 `INVALID_NAME`. Repeating a pending request is a no-op. Owners and Admins get a bell notification (`type: "access_request"`) and an email.
- Routes under `/api/v1/organization/access-requests` (`organization:manage`, own organization only):
  - `GET ?status=pending|approved|denied|all` (default `pending`) → `{ data: [{ id, email, name, status, autoApproved, decidedAt, createdAt }] }`.
  - `POST /:id/approve` `{ role?, teamId? }` (default Planner) sends an ordinary invitation; no account exists until it is accepted. Invitation refusals pass through with their codes.
  - `POST /:id/deny` emails the requester, who can still create their own organization.
  - Deciding twice: 409 `ACCESS_REQUEST_NOT_PENDING`; another organization's request: 404 `ACCESS_REQUEST_NOT_FOUND`.
  - `GET|PUT /settings` `{ autoApproveDomain }` → `{ autoApproveDomain, verifiedDomains }`; audited as `organization.settings.updated`.
- Audit actions: `organization.access_request.created`, `.auto_approved`, `.approved`, `.denied`.

## Organization profile

Routes under `/api/organization/profile`; rules in `src/modules/organizationProfile/`.

- `GET /api/organization/profile` (any member) answers `{ name, type, industry, country, timeZone, eventsPerYear, plan, onboardingStep, canManage }`.
- Onboarding (ORG-301): every organization created at sign-up (password, Google, Microsoft or company SSO) starts at `onboardingStep: "details"` and walks `details → plan → team → done`; organizations from before onboarding are `"done"`. The dashboard sends an Owner or Admin (`canManage`) to the onboarding wizard until the step is `"done"`.
- `PUT /api/organization/profile` `{ name, type?, industry?, country?, timeZone?, eventsPerYear? }` (`organization:manage`) saves the details and moves `"details"` on to `"plan"`. The name is trimmed with inner whitespace collapsed, 1–200 characters; `type` is one of `corporate|association|agency|venue|government|other`; `industry` up to 120 characters; `country` an ISO 3166-1 alpha-2 code; `timeZone` an IANA zone; `eventsPerYear` a whole number 0–100,000. A field left out is unchanged; `""` or `null` clears it. Otherwise 400 `VALIDATION_ERROR` with `field`. Audited as `organization.settings.updated` (`organization_onboarding_details` or `organization_details_updated`).
- `POST /api/organization/onboarding/plan` `{ plan: "free_trial" }` (`organization:manage`) records the plan and moves on to `"team"`; allowed at the plan or team step, otherwise 409 `ONBOARDING_STEP_CONFLICT` with the current `onboardingStep`.
- `POST /api/organization/onboarding/complete` (`organization:manage`) finishes onboarding from the team step (inviting is optional); repeating it once done is a no-op; earlier steps answer 409 `ONBOARDING_STEP_CONFLICT`.
- Every profile and onboarding write answers the whole profile, as GET does, and is rate-limited (30 per 15 minutes).

## Sign-in: Google, Microsoft and company SSO

Customers sign up with email and password (confirmed by an emailed 6-digit code), or sign in with Google, Microsoft or their organization's own OpenID Connect provider. Setting `PASSWORD_SIGN_IN_ENABLED=false` turns the password, signup-OTP and reset routes (and password invitation accept) off; they then answer 410 `PASSWORD_SIGN_IN_DISABLED`. Setup for operators and customer IT: [SSO_SETUP.md](SSO_SETUP.md).

`POST /api/auth/sso/discover` `{ email }` (dashboard server only: BFF key required, else 403) answers `{ method: "company" | "password" }` for the sign-in page's email-first step: `company` when an active SSO connection covers the email's domain. It never names the organization. Limited to 30 per 15 minutes per visitor; the dashboard passes the visitor's IP in `x-rfpilot-client-ip`, which is trusted only alongside a valid BFF key. A bad email is 400 `VALIDATION_ERROR`. Rules in `src/modules/sso/`.

- `GET /api/auth/sso/start?kind=microsoft|company&email=&invite=&bind=`: `bind` is the lowercase hex SHA-256 of the dashboard's `rfp_sso_bind` cookie; `email` is required for `company`. Redirects (302) to the IdP, or to `${FRONTEND_URL}/sign-in?error=CODE` (`/invite/<token>?error=CODE` when `invite` was given).
- `GET /api/auth/sso/callback`: the redirect URI registered with every IdP. Success redirects to `${FRONTEND_URL}/sso/complete?handoff=…` (single use, 60 s).
- `POST /api/auth/sso/exchange` `{ handoff, bind }` (BFF key required): answers like `POST /api/auth/google`, including the 2FA step. Company SSO never gets our 2FA prompt; Microsoft follows `TWO_FACTOR_SSO_POLICY` like Google.
- Account rules: a first company sign-in joins the connection's organization as Planner (a pending invitation's role wins when signing in from the invite); a first Microsoft sign-in creates a new organization with the person as Owner. A company IdP may only sign in emails on the connection's domains that its organization still has verified. Microsoft work-tenant emails are trusted only with `xms_edov=true`.
- Error codes in the redirect: `SSO_INVALID_REQUEST`, `SSO_NOT_CONFIGURED`, `MICROSOFT_NOT_CONFIGURED`, `SSO_PROVIDER_UNAVAILABLE`, `SSO_STATE_INVALID`, `SSO_CANCELLED`, `SSO_IDENTITY_INVALID`, `EMAIL_MISSING`, `MICROSOFT_EMAIL_UNVERIFIED`, `COMPANY_EMAIL_UNVERIFIED`, `SSO_DOMAIN_NOT_ALLOWED`, `SSO_IDENTITY_MISMATCH`, `SSO_REQUIRED`, `EMAIL_IN_ANOTHER_ORGANIZATION`, `MEMBER_DEACTIVATED`, `USER_BLOCKED`, `SSO_INVITE_ORG_MISMATCH`, plus invitation refusal codes. Exchange errors: 401 `SSO_HANDOFF_INVALID`.
- Require SSO: when an organization requires it, emails on its connection's domains are refused on Google and Microsoft sign-in and invite accept (403 `SSO_REQUIRED`), except the organization's Owner (break-glass) and people whose account belongs to another organization.
- `POST /api/v1/invitations/lookup` includes `invitation.companySso` (true when the inviting organization has an active connection for the invited email's domain).

## Organization SSO connection

Routes under `/api/organization/sso` (`organization:manage`). One OIDC connection per organization; the client secret is sealed with `SSO_SECRET_KEY` and never returned.

- `GET /api/organization/sso` → `{ connection | null, requireSso, redirectUri, verifiedDomains }`; `connection` is `{ issuer, clientId, hasClientSecret, domains, status: "draft"|"active", lastTestedAt, lastTestOutcome, version, updatedAt }`.
- `PUT /api/organization/sso` `{ issuer, clientId, clientSecret?, domains, version? }` (secret required on create; `version` for updates) → `{ connection }`. Refusals: 400 `VALIDATION_ERROR`, 422 `SSO_DOMAIN_NOT_VERIFIED` with `domains` (unverified, or used by another organization's connection), 422 `SSO_ISSUER_UNREACHABLE`, 409 `VERSION_CONFLICT`.
- `POST /api/organization/sso/test` → `{ ok, issuer, authorizationEndpoint, problems[] }` (discovery and signing keys; no sign-in).
- `PUT /api/organization/sso/status` `{ status }` → `{ connection }`. Turning it off (draft) also turns Require SSO off.
- `PUT /api/organization/sso/require` `{ requireSso }` → `{ requireSso, signedOutMembers }`; 409 `SSO_CONNECTION_NOT_ACTIVE`. Turning it on signs out the non-Owner members on the connection's domains (not the person making the change).
- `DELETE /api/organization/sso` → `{ success }`; also turns Require SSO off. 404 `SSO_CONNECTION_NOT_FOUND` where there is none.

## Where to find endpoints

- Backend route overview and legacy API: `../README.md`.
- AI component endpoints and payload examples: the relevant file under `architecture/`.
- Exact executable behavior: route/controller schemas in `src/`; code wins if an old slice example differs.
- Operational health and dependencies: [runbooks/API_AND_DEPENDENCIES.md](runbooks/API_AND_DEPENDENCIES.md).
- Helpdesk (support tickets): `routes/supportDeskRoute.ts` — planner routes under `/api/v1/support`, agent routes under `/api/v1/admin/support`; validation and status rules in `src/modules/supportDesk/domain.ts`.

The repository does not currently publish a generated OpenAPI contract. Adding one from runtime schemas is a documentation gap; until then, avoid copying full endpoint catalogs into multiple documents.
