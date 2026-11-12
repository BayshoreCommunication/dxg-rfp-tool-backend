# API Guide

> Purpose: API discovery and contract ownership. Last updated: 2026-11-11. Owner: backend engineering.

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

## Organization Accounts: how the sections fit

The sections from here to "Launch metrics" document the Organization Accounts API (ORG-101 … ORG-607), each endpoint once, in this order:

| Area | Sections |
|---|---|
| Sign-in and organization setup | Sign-in (Google, Microsoft, company SSO) · Organization SSO connection · Two-factor authentication · Organization domains · Domain-match access requests · Organization profile (with onboarding) |
| People | Organization members · Teams · Organization invitations · RFP sharing |
| Working with RFPs | Dashboard RFP queries · RFP lifecycle · Support access grants · Organization audit log |
| Plans and shared resources | Plans and entitlements (with plan management for RFPilot staff) · Organization vendor list · RFP templates |
| RFPilot staff only | Legacy customer placement · Launch metrics (plus the staff halves of support access and plan management) |

Conventions that hold across these sections:

- **Roles.** Customer roles are Owner (`owner`), Admin (`organization_admin`), Team Manager (`team_manager`), Planner (`planner`) and Viewer (`viewer`). What each may do is one table, `src/modules/identity/domain/authorizationPolicy.ts`; which RFPs each may reach is `src/modules/identity/domain/rfpAccessPolicy.ts`. RFPilot staff are not members of customer organizations: the staff routes for support access, plan management and launch metrics need a staff role **and** an account in the `admins` collection.
- **Refusals.** On member routes, another organization's resource answers 404, the same as a missing one, and a resource in the caller's organization that they may not reach answers 403. A role refused by the route guard gets 403 `{ success: false, message }` with no `code`; refusals decided later carry a `code`.
- **Tenant.** On member routes the organization comes from the session, never from the request. The public invitation and access-request routes take it from the invitation or the matched email domain, and the staff routes for support access and plan management name a customer organization in the path.
- **Plans.** A plan limits two things only: how many RFPs an organization may create, and the `vendorResponses` and `proposalIntelligence` features (see "Plans and entitlements"). Every other Organization Accounts route is open on every plan.

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

Someone signing up with an email on a company domain already in use is offered "Request access" instead of silently getting a separate organization. A domain matches the organization that **verified** it (ORG-305); failing that, the oldest active organization with an active member whose own email (proven by code or SSO when the account was made) is on that domain. Claimed-but-unverified domains with no such member, public mail providers and reserved example domains never match, and a match never reveals more than the organization's name, which only someone who passed the emailed code sees. Rules in `src/modules/accessRequests/`.

- `POST /api/auth/verify-otp` (signup) also answers `organizationMatch: { name } | null`.
- `POST /api/auth/register`, `POST /api/auth/google`: a NEW account on a matched domain answers 409 `ORGANIZATION_DOMAIN_MATCH` with `organizationName`, unless the body has `separateOrganization: true` (the person chose to create their own organization). Existing accounts sign in as before. A first Microsoft or company-SSO sign-in that would create an organization on a matched domain redirects with `error=ORGANIZATION_DOMAIN_MATCH`; the person can request access through email signup.
- `POST /api/auth/access-requests` `{ email, name }` (public; 5 per 15 minutes per email and IP). The email must hold a verified signup code (403 `EMAIL_NOT_VERIFIED`), which the request uses up. Answers 201 `{ status: "pending" | "invited", organizationName }`; `invited` when the organization auto-approves its domain (the invitation is sent at once, in the Owner's name); auto-approve applies only to a DNS-verified match, never to a member-email match. 409 `NO_ORGANIZATION_MATCH`, 409 `ACCOUNT_EXISTS`, 400 `INVALID_NAME`. Repeating a pending request is a no-op. Owners and Admins get a bell notification (`type: "access_request"`) and an email.
- Routes under `/api/v1/organization/access-requests` (`organization:manage`, own organization only):
  - `GET ?status=pending|approved|denied|all` (default `pending`) → `{ data: [{ id, email, name, status, autoApproved, decidedAt, createdAt }] }`.
  - `POST /:id/approve` `{ role?, teamId? }` (default Planner) sends an ordinary invitation; no account exists until it is accepted. Invitation refusals pass through with their codes.
  - `POST /:id/deny` emails the requester, who can still create their own organization.
  - Deciding twice: 409 `ACCESS_REQUEST_NOT_PENDING`; another organization's request: 404 `ACCESS_REQUEST_NOT_FOUND`.
  - `GET|PUT /settings` `{ autoApproveDomain }` → `{ autoApproveDomain, verifiedDomains }`; audited as `organization.settings.updated`. Turning it on with no verified domain is 409 `NO_VERIFIED_DOMAIN`.
- Audit actions: `organization.access_request.created`, `.auto_approved`, `.approved`, `.denied`.

## Organization profile

Routes under `/api/organization/profile`; rules in `src/modules/organizationProfile/`.

- `GET /api/organization/profile` (any member) answers `{ name, type, industry, country, timeZone, eventsPerYear, plan, onboardingStep, canManage }`.
- Onboarding (ORG-301): every organization created at sign-up (password, Google, Microsoft or company SSO) starts at `onboardingStep: "details"` and walks `details → plan → team → done`; organizations from before onboarding are `"done"`. The dashboard sends an Owner or Admin (`canManage`) to the onboarding wizard until the step is `"done"`.
- `PUT /api/organization/profile` `{ name, type?, industry?, country?, timeZone?, eventsPerYear? }` (`organization:manage`) saves the details and moves `"details"` on to `"plan"`. The name is trimmed with inner whitespace collapsed, 1–200 characters; `type` is one of `corporate|association|agency|venue|government|other`; `industry` up to 120 characters; `country` an ISO 3166-1 alpha-2 code; `timeZone` an IANA zone; `eventsPerYear` a whole number 0–100,000. A field left out is unchanged; `""` or `null` clears it. Otherwise 400 `VALIDATION_ERROR` with `field`. Audited as `organization.settings.updated` (`organization_onboarding_details` or `organization_details_updated`).
- `POST /api/organization/onboarding/plan` `{ plan: "free_trial" }` (`organization:manage`) records the plan and moves on to `"team"`; allowed at the plan or team step, otherwise 409 `ONBOARDING_STEP_CONFLICT` with the current `onboardingStep`.
- `POST /api/organization/onboarding/complete` (`organization:manage`) finishes onboarding from the team step (inviting is optional); repeating it once done is a no-op; earlier steps answer 409 `ONBOARDING_STEP_CONFLICT`.
- Every profile and onboarding write answers the whole profile, as GET does, and is rate-limited (30 per 15 minutes).

## Organization members

Membership management (ORG-206, ORG-207, ORG-307) lives in `routes/organizationMembersRoute.ts`, mounted at `/api/organization`, Owner/Admin only; rules in `src/modules/organizationMembers/application/manageMembers.ts`. Every write takes the member's current `version` (409 `STALE_VERSION` otherwise).

- `PATCH /members/:userId/role` `{ role, version }`. Becoming a Viewer while owning RFPs is 409 `OWNER_HAS_RFPS` with `ownedRfpCount`, checked again in the same transaction as the write. A demotion by someone else revokes all the member's sessions at once; any other role change revokes the member's other sessions on their next request (see DECISIONS.md).
- `PUT /members/:userId/teams` `{ teamIds, version }` makes the member's active teams exactly `teamIds` (ORG-201 Teams), keeping manager flags on teams they stay on and leaving archived teams' memberships as history. An archived team or another organization's team is 400 `UNKNOWN_TEAMS` with `unknownTeamIds`.
- `DELETE /api/users/:id` (legacy, platform admins only; no dashboard screen calls it) hard-deletes an account. It is refused with 409 `OWNER_HAS_RFPS` and `ownedRfpCount` while the user owns any RFP in any organization, so RFPs are never orphaned; organization members are deactivated and their RFPs reassigned instead.

## Teams

Team administration (ORG-201) lives in `routes/teamsRoute.ts`; rules in `src/modules/teams/application/manageTeams.ts`. Every change writes a `SecurityAuditEvent` (`team.created`, `team.renamed`, `team.archived`, `team.member_added`, `team.member_removed`, `team.manager_changed`).

- `GET /api/v1/teams` — Owners and Admins get every team with its members; other members get `{ id, name }` for active teams.
- `POST /api/v1/teams` `{ name }`, `GET|PATCH /api/v1/teams/:teamId` `{ name }`, `POST /api/v1/teams/:teamId/archive` — Owner/Admin only. Active names are unique per organization, ignoring case (409 `TEAM_NAME_TAKEN`). Archived teams can't be changed (409 `TEAM_ARCHIVED`).
- `POST /api/v1/teams/:teamId/members` `{ userId, isManager? }`, `PATCH /api/v1/teams/:teamId/members/:userId` `{ isManager }`, `DELETE /api/v1/teams/:teamId/members/:userId` — Owner/Admin only. Members must be active in the organization; a manager must hold the `team_manager` role (422 `TEAM_MANAGER_ROLE_REQUIRED`).
- Proposal team (ORG-202): `POST /api/proposals` and copy put a new proposal on its creator's team when they're on exactly one active team (a client-sent `teamId` is ignored). `PUT /api/proposals/:id` with `teamId` (an active team in the organization, or `null`) changes it for anyone allowed to edit; anything else is 422 `TEAM_NOT_ASSIGNABLE`. Resending the current team's id is accepted even after that team is archived.

## Organization invitations (ORG-203)

Routes in `routes/invitationRoute.ts`, rules in `src/modules/invitations/domain/invitationRules.ts`.

- `GET /api/v1/organization/invitations?status=` lists invitations the caller may manage (Owner/Admin: all; Team Manager: their teams, when `allowManagerInvites` is on).
- `POST /api/v1/organization/invitations` `{ email, role, teamId? }` invites one person; `POST .../bulk` `{ emails: string | string[], role, teamId? }` takes up to 500 entries and answers with one result per row (`invited`, or `refused` with a code such as `INVALID_EMAIL`, `DUPLICATE_IN_LIST`, `ALREADY_INVITED`, `ALREADY_MEMBER`, `EMAIL_IN_ANOTHER_ORGANIZATION`, `LEGACY_ACCOUNT_PENDING_PLACEMENT`). `teamId` must be an active team of the organization (else `404 TEAM_NOT_FOUND`); on accept the member is added to it in the same transaction, or joins without a team if it was archived in between. An email whose invitation is past its expiry can be invited again at once, before the sweep marks it expired.
- `POST .../:id/resend` rotates the link (the old one stops working at once) and restarts the 7-day expiry; `POST .../:id/revoke` withdraws it.
- Sending limits (create, bulk and resend): the shared limiter allows 30 requests per 15 minutes per inviting user and 60 per organization (`429`, `Retry-After`). Each organization may queue at most `INVITATION_DAILY_EMAIL_LIMIT` invitation emails per UTC day (default 500), counting one per recipient, so a bulk paste counts every row that would be invited; a request that would go over is refused whole with `429 INVITATION_DAILY_LIMIT`, `remaining` and `Retry-After` (seconds to the next UTC day). An invitation can be resent once every five minutes (counted from the invite or the last resend): `429 INVITATION_RESEND_COOLDOWN` with `retryAfterSeconds`. Day-six reminders and delivery retries aren't counted.
- Public, token in the body: `POST /api/v1/invitations/lookup` `{ token }` returns organization, role, inviter, email and whether an account exists. `POST /api/v1/invitations/accept` `{ token, email, password }` signs an existing account in (the email must equal the invited one); `POST /api/v1/invitations/accept/register` `{ token, name, password }` creates the account in the inviting organization. `POST /api/v1/invitations/accept/google` `{ token, idToken }` is for accounts with no usable password (created by Google sign-in) and for Google sign-up: the verified Google email must equal the invited one (`403 INVITATION_EMAIL_MISMATCH`; a bad ID token is `401 INVALID_GOOGLE_IDENTITY`); an existing account joins, otherwise an account is created in the inviting organization with no organization of its own. All three return a session like `/api/auth/login`; the Google accept, like `/api/auth/google`, may instead return the 2FA step (`twoFactorRequired`). Role, team and organization come only from the invitation.
- Emails (ORG-204) go through `utils/emailService.ts` (`sendTransactionalEmail`, no fixed-recipient copy) and link to `${FRONTEND_URL}/invite/<token>`, so `FRONTEND_URL` must be the dashboard origin. The cron worker's invitation sweep (every 15 minutes) expires invitations, sends the day-six reminder once per link with a fresh link, and retries failed sends up to five attempts. Under `NODE_ENV=test` mail goes to an in-memory recorder.
- Dead links answer `404 INVITATION_INVALID` or `410` with `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_ALREADY_USED` or `INVITATION_SUPERSEDED`; none of them names the organization or email.

## RFP sharing

Sharing (ORG-208) lives in `routes/rfpSharesRoute.ts`; rules in `src/modules/rfpSharing/application/manageRfpShares.ts`. Who may share is the access policy's `share` decision: the proposal's owner, a manager of its (active) team, or an Owner/Admin.

- `GET /api/v1/proposals/:proposalId/shares` lists shares as `{ userId, permission, grantedBy, memberActive, createdAt, updatedAt }`. `memberActive: false` marks a deactivated member's share, which is kept but grants nothing.
- `PUT /api/v1/proposals/:proposalId/shares/:userId` `{ permission: "view" | "edit" }` grants or changes a share; `DELETE` revokes it. The member must be active in the same organization (404 `MEMBER_NOT_FOUND`, 409 `MEMBER_INACTIVE`); Viewers get view only (422 `VIEWER_VIEW_ONLY`). Grants and revocations write `proposal.share_granted` / `proposal.share_revoked` audit events.
- A share reaches list, detail and vendor-response reads through `rfpListScope` and `canAccessRfp`; an edit share also allows edits.

## Dashboard RFP queries (ORG-401)

`routes/rfpDashboardRoute.ts`, rules in `src/modules/rfpDashboard/`. Both endpoints need `proposal:read` and return only what `rfpListScope` lets the member see: everything in the organization for Owners and Admins, their managed teams' RFPs for Team Managers, their own for Planners, plus anything shared with them. Filters only narrow that set. Saved copies are never listed.

- Filters (both endpoints): `stage` (comma-separated lifecycle stages; default is every stage except `archived`), `owner` (user id), `team` (team id), `eventFrom` / `eventTo` (inclusive, `YYYY-MM-DD`, against the event start date; RFPs without a start date drop out), `venueCity` (whole name, case-insensitive), `search` (event name contains). An invalid value is 400 `DASHBOARD_FILTER_INVALID`, never silently ignored.
- `GET /api/v1/rfps` — adds `page`, `limit` (max 100, default 25), `sortBy` (`updatedAt` default, `createdAt`, `eventStartDate`, `eventName`) and `sortOrder`. Items: `{ id, eventName, stage, status, isDraft, ownerUserId, ownerName, teamId, teamName, eventStartDate, eventEndDate, venueCity, vendorsInvited, vendorsResponded, reviewStartedAt, awardedAt, createdAt, updatedAt }` with `pagination { total, page, limit, totalPages }`.
- `GET /api/v1/rfps/summary` — over exactly the list's set: `{ total, activeRfps (sent + receiving_responses + under_review), responsesReceived (sum of vendorsResponded), awardedThisQuarter, byStage, quarter { label, start, end, timeZone } }`. "This quarter" is the calendar quarter in the organization's `timeZone` (UTC when unset). The integration suite checks, over randomized filters, that the summary equals aggregating every list page.
- An RFP the lifecycle backfill hasn't reached yet is listed with the stage its flags give (archived, draft, otherwise sent).
- Measured on 5,000 RFPs in one organization (integration suite, local Docker): p95 16–136 ms against the 300 ms budget.

## RFP lifecycle (ORG-403)

Every RFP has a derived stage, stored on the proposal as `lifecycle` and recomputed after each write: `draft` → `sent` → `receiving_responses` → `under_review` → `awarded`, or `archived`. Archived outranks everything, an unpublished proposal is a draft, then awarded, then under review (a vendor comparison was opened), then receiving responses (at least one vendor response), else sent. Rules in `src/modules/proposalLifecycle/`. Clients can't write `lifecycle`: create, update and copy strip it.

- `POST /api/proposals/:id/award` — "Mark as awarded". Needs `proposal:publish` and edit access to the RFP (403 / 404 otherwise). Only a sent, unarchived RFP qualifies (409 `PROPOSAL_NOT_AWARDABLE`). Returns `{ stage, awardedAt, awardSource, awardedByUserId, changedAt }`. Repeating it keeps the first award time. A planner's award replaces one set by a comparison, and a comparison never overrides a planner's.
- `DELETE /api/proposals/:id/award` — withdraws the award, whichever source set it. Same permissions and response.
- `GET /api/proposals/:id/status-history` — `proposal:read` and view access. Returns the same fields plus `transitions`, oldest first: `{ fromStage, toStage, fromStatus, toStatus, actorType: user|vendor|system, actorUserId, reason, at }`, capped at 500.
- Recording a comparison decision (`POST /api/v1/proposals/:proposalId/intelligence/comparisons/:runId/decisions`) also moves the stage: `selection` awards the RFP (source `comparison`), and a later `shortlist` or `no_award` withdraws that award. Creating a comparison starts the review.

## Support access grants (ORG-404)

Routes in `routes/supportAccessRoute.ts`; rules in `src/modules/supportAccess/`. RFPilot Support (DXG staff signed in to the admin app with an `admins` account) reads a customer organization's RFP data only under an active grant from that organization. A grant is to RFPilot Support as a whole, not to a named agent.

Organization side (Owner and Admin only; other roles get the route guard's plain 403, and a staff account 403 `SUPPORT_GRANT_FORBIDDEN`):

- `POST /api/v1/organization/support-grants` `{ proposalId?, expiresInDays? | expiresAt?, reason? }` creates a grant for one RFP (`proposalId`) or, without it, the whole organization. Expiry defaults to 7 days and is refused past 30 (400 `INVALID_GRANT_EXPIRY`). An RFP outside the organization is 404 `PROPOSAL_NOT_FOUND`.
- `GET /api/v1/organization/support-grants?page=` lists active and past grants, newest first: `{ id, scope: "organization" | "rfp", rfp, reason, status: "active" | "expired" | "revoked", grantedBy, createdAt, expiresAt, revokedAt, revokedBy, activity: { useCount, lastUsedAt } }`.
- `GET /api/v1/organization/support-grants/:grantId` adds `events`: what Support did under the grant (`{ at, agent: { id, label: "RFPilot Support" }, operation, rfp }`, newest 200). Staff are never shown by name.
- `POST /api/v1/organization/support-grants/:grantId/revoke` ends a grant at once (409 `SUPPORT_GRANT_EXPIRED` if it already expired; revoking twice is a no-op). Another organization's grant is 404 `SUPPORT_GRANT_NOT_FOUND`.

RFPilot Support side (staff role and an `admins` account; customers get the route guard's plain 403, and a member holding a staff role 403 `SUPPORT_ACCESS_FORBIDDEN`):

- `GET /api/v1/admin/support-access/grants` is "granted to me": every organization's active grants with `organization`, `scope`, `rfp: { id }`, `expiresAt` and `secondsRemaining`. It carries no RFP content (titles come from the audited routes below), so it is not logged as a use.
- `GET /api/v1/admin/support-access/organizations/:organizationId/rfps?page=&search=` lists the RFPs the active grants cover (all of them under an organization grant, otherwise only the granted RFPs).
- `GET /api/v1/admin/support-access/organizations/:organizationId/rfps/:proposalId` returns the RFP, its owner and the `grant` it was read under (for the admin app's banner). `…/vendor-responses` lists that RFP's vendor responses (summary fields, no document links).
- `GET /api/v1/admin/support/tickets/:ticketId/rfps` lists the requester's RFPs in the ticket's organization. Reading the ticket itself (`/api/v1/admin/support/tickets/:ticketId`) needs no grant; this does. The ticket is looked up in whichever organization it belongs to (RFPilot Support reads every organization's tickets, see "Helpdesk" below), and the grant must be an active one from the ticket's organization: the agent's own organization, or a grant from any other organization, opens nothing. An unknown ticket is 404 `SUPPORT_TICKET_NOT_FOUND`.
- No active grant in the organization: 403 `SUPPORT_GRANT_REQUIRED`, whether the organization exists or not. An RFP the active grants don't cover, or one that isn't in that organization: 404 `PROPOSAL_NOT_FOUND`. Grants are checked on every request, so expiry and revocation apply to the next call.
- Every successful read writes a `support_access.used` audit event in the customer's organization (agent, `metadata.grantId`, target, `metadata.operation`: `rfp.list`, `rfp.read`, `vendor_responses.list`, `ticket.rfp.list`) before anything is returned; a refused one writes `support_access.denied`. Creating and revoking write `support_access.granted` / `support_access.revoked`.
- "Granted to me" returns at most 500 active grants.
- The older `GET /api/admin/proposals`, `GET /api/admin/proposals/:id` and `GET /api/all-clients` (which returns an RFP count per account) are unchanged by ORG-404: they are not grant-checked and write no audit event, and they read only the signed-in staff member's own organization. The admin app stopped calling the two `proposals` routes in ORG-406 and still uses `/api/all-clients` for account management. Gating or removing them is an open follow-up (`PROJECT_STATE.md`, "Before launch").

## Helpdesk (support tickets)

Routes in `routes/supportDeskRoute.ts`; rules in `src/modules/supportDesk/`. Customers write to RFPilot support from the dashboard and RFPilot staff answer from the admin app. Decision: `DECISIONS.md`, 2026-11-12.

Customer side (`/api/v1/support/...`, any active member): create, list, open, reply, resolve, unread count, attachments. A member sees only the tickets they opened, in their own organization; any other ticket, including a colleague's and another organization's, is 404 `SUPPORT_TICKET_NOT_FOUND`. Internal notes and triage activity never leave through these routes, and the customer hears from "RFPilot support", never a named agent.

Agent side (`/api/v1/admin/support/...`, route guard: a staff membership role; the service then decides the scope in `agentScopeFor`):

- **RFPilot staff** (an `admins` account holding a staff role, the ORG-404 / ORG-603 test) work **every organization's tickets**: `GET /tickets` (inbox), `GET /metrics` (stat cards, unread and overdue), `GET /tickets/:ticketId`, `POST /tickets/:ticketId/messages`, `POST /tickets/:ticketId/notes`, `PATCH /tickets/:ticketId` (assignee, status, priority, category, subject), `POST|DELETE /tickets/:ticketId/presence`, `GET /tickets/:ticketId/attachments/:attachmentId`, `GET /agents` (every unblocked staff account) and the canned replies.
- A `users` account holding a staff membership role is refused: 403 `SUPPORT_FORBIDDEN`. A `users` account whose account role is administrative is an agent of its own organization only, as before: another organization's ticket is 404 for it.
- What staff read is the ticket conversation and its attachments. A customer's proposals are not reachable from here: `GET /api/v1/admin/support/tickets/:ticketId/rfps` needs an active grant from the ticket's organization (see "Support access grants").
- `GET /tickets?status=&assignee=&priority=&category=&search=&organization=&sort=&page=&perPage=` returns `{ scope, tickets, pagination }`. `scope` is `all_organizations` for RFPilot staff and `organization` otherwise. Each ticket carries `organization: { id, name }` (the customer organization it belongs to), `requester` and `assignee`. `organization=<id>` narrows the staff inbox to one organization (400 `SUPPORT_INVALID_ID` for a malformed id; ignored outside staff scope). `search` matches the subject, the requester's name or email, a ticket number (`#3` or `3`) and, for staff, the organization's name.
- `GET /tickets/:ticketId` returns `{ ticket, organization, requester, assignee, messages }`.
- **Ticket numbers are per organization** and are the numbers customers see; they are not unique across organizations. A number search returns every match, each with its organization; number plus `organization` is exact. Agent alerts name the organization beside the number.
- Replies, notes and status events are written into the ticket's organization. Canned replies and an agent's pending uploads stay in the agent's own organization.
- New tickets are assigned to the RFPilot staff account with the fewest active tickets across all organizations. Bell notifications (and the admin app's real-time alert, which rides on them) go to the ticket's owner, or to every staff account when it has none or when it is escalated; the alert email goes to `SUPPORT_DESK_NOTIFY_EMAIL`.
- Reading or answering a ticket writes no `SecurityAuditEvent` in the customer's organization.

## Organization audit log (ORG-407)

`routes/auditLogRoute.ts`, rules in `src/modules/auditLog/`. Read-only view of the caller's own organization's `SecurityAuditEvent` rows (PRD P0-10). Owner and Admin only (`audit:read` in `authorizationPolicy.ts`); every other role gets the route guard's plain 403. The organization always comes from the session, never from the request. Open on every plan.

- `GET /api/v1/organization/audit-events?actor=&action=&category=&from=&to=&limit=&cursor=` returns `{ events, nextCursor }`, newest first. `actor` is a member's user id, or `support` for RFPilot Support activity. `action` is one catalogued action, `category` one of the keys below. `from` is inclusive and `to` exclusive (ISO timestamps with `Z` or an offset; anything else is refused); a bare `YYYY-MM-DD` is read as UTC, and a bare `to` date includes that whole day. `limit` defaults to 50 and is capped at 100. A bad filter is 400 `AUDIT_FILTER_INVALID`.
- An event is `{ id, occurredAt, action, label, category, decision, reason, actor, target: { type, id, name }, details }`. `actor` is `{ kind: "member", id, name, email }`, `{ kind: "support", id, name: "RFPilot Support" }` (staff are never shown by name; the id is the stable agent reference ORG-404 uses), `{ kind: "unknown", id, name: "Unknown user" }` for an id that isn't a member of the organization, or `{ kind: "system" }`. `target.name` is filled only when the target is a member. `target.id` is null for a session (`refresh_session`): the id means nothing to a reader. `details` is an allowlist of scalar metadata (`role`, `previousRole`, `setting`, `from`, `to`, `scope`, `operation`, `domain`, `grantId`, ...); anything else a writer stored, and any value containing an email address, is left out. `reason` is shown only when it is a machine code.
- `GET /api/v1/organization/audit-events/filters` returns `{ categories: [{ key, label, actions: [{ value, label }] }], supportActor }` for the filter controls.
- `GET /api/v1/organization/audit-events/export` takes the same filters (no paging) and returns `text/csv`, newest first, up to 5,000 rows; `X-Audit-Export-Truncated: true` means the date range should be narrowed. The file says "rfp" where an internal name says "proposal" (target type, `rfpId`); role and result codes are exported as stored. Cells that a spreadsheet would run as a formula (leading `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with an apostrophe. Limited to 20 exports per user per 15 minutes.
- The view is an allowlist (`AUDIT_CATALOG` in `src/modules/auditLog/domain.ts`): sign-in (`auth.session.created`, `auth.login.failed`, session revocations), two-factor, invitations and access requests, members and roles, teams, RFP sharing, support access, organization settings (profile, domains, SSO, and a plan change by RFPilot staff, `organization.plan_changed` from ORG-603, shown as RFPilot Support with the old and new plan only) and the vendor list. An action that isn't catalogued (for example `auth.refresh.rotated`) is never returned. Not catalogued today, so not shown: the RFP template actions (`proposal_template.*`, ORG-604). **A new audited action must be added to the catalog to appear**, with `staffActor` if its actor is an `admins` account.
- `auth.login.failed` (new in ORG-407) is written when a password sign-in fails on a known account (`reason`: `wrong_password` or `account_blocked`), in that account's organization. It carries the user id, never the email or password. An unknown email has no organization and writes nothing.
- `DELETE /api/auth/sessions/:id` now writes `auth.session.revoked` only when a session was actually revoked. Before ORG-407 it recorded the id from the request even when it matched nothing (the isolation sweep caught another organization's session id echoed into the caller's audit log).

## Plans and entitlements (ORG-601)

Rules in `src/modules/entitlements/`. Pricing is by RFPs created; the plan table (`domain/plans.ts`) is the only definition of a plan's limit and features. The server enforces it; the dashboard only reads it.

- Plans: `free_trial` (2 RFPs created per organization, vendor responses and RFP intelligence locked) and `full_access` (no limit, both features; assigned by DXG staff until paid plans exist). `PLAN_FREE_TRIAL_PROPOSAL_LIMIT` overrides the free-trial limit. An absent or unknown plan value is treated as `free_trial`. Legacy holding tenants are exempt.
- `GET /api/organization/entitlements` (any member) answers `{ data: { plan, exempt, proposals: { created, limit, remaining, canCreate }, features: { vendorResponses, proposalIntelligence } } }` for the caller's organization; `limit` and `remaining` are `null` when there is no limit.
- Creating an RFP (`POST /api/proposals`, `POST /api/proposals/:id/copy`) takes one slot in the same MongoDB transaction that inserts it. `Organization.proposalsCreated` counts every RFP created through the API since ORG-601 and never goes down, so archiving or deleting one doesn't free a slot. With no slot left the answer is 403 `{ success: false, code: "PLAN_LIMIT_REACHED", message, plan, limit, created }`.
- Locked features answer 403 `{ success: false, code: "PLAN_FEATURE_LOCKED", message, title, status, plan, feature }` before the handler runs, whatever ids the request carries:
  - `vendorResponses`: `GET /api/vendor-responses`, `/proposals`, `/:id`, `/:id/submission-detail`, `/:id/submission-export` and `PATCH /:id/read`.
  - `proposalIntelligence`: every route under `/api/v1/proposals/:proposalId/intelligence/` (requirement sets, evidence extraction, vendor intelligence, evaluation, comparisons, clarifications, reports, retention and legal holds). No request can queue an intelligence job for a locked organization.
  - Both: `/api/v1/vendor-responses/:responseId/analysis-*` (jobs, runs, export).
- Open on every plan: the vendor submission routes (workspace, drafts, finalize, receipt, revisions), questionnaire publish and rollout, recording a response on a vendor's behalf, deleting a response by id, and public-access grants. Submissions received while locked are stored and readable once the plan changes. The planner's notification for a response received while locked says only that a vendor responded (`metadata: { planLocked: true, feature: "vendorResponses" }`).
- Not plan features, so open on every plan: teams, members, invitations, sharing, the dashboard queries, the RFP lifecycle routes, support access grants, the audit log, the vendor list and templates. Starting an RFP from a template takes an RFP slot like any other create (403 `PLAN_LIMIT_REACHED`).
- `tests/plan-entitlements.test.js` lists every route of the RFP intelligence, vendor analysis, vendor response, audit log and template routers with the feature it requires; a new route in one of those routers fails that test until it is classified. Other routers, the staff-only ones included, are not covered by that test.

### Plan management for RFPilot staff (ORG-603)

Mounted at `/api/v1/admin/organization-plans`. RFPilot staff only: the caller needs a staff membership role (`dxg_admin` or `super_admin`) **and** an `admins` account with role `admin` or `super_admin`. Every customer role gets 403, and a `users` account holding a staff role gets 403 `PLAN_MANAGEMENT_FORBIDDEN`. These are the only routes that can set `full_access`.

- `GET /` `?search=&page=` lists customer organizations by name, 20 per page (`search` matches name, slug or an organization id). Answers `{ data: { organizations: [{ id, name, slug, status, createdAt, plan, proposals: { created, limit, remaining, canCreate }, features }], plans: [{ id, proposalLimit, features }], pagination, filters } }`. `plans` is the plan table, so the admin app doesn't hard-code limits. Legacy holding tenants are exempt from plans and aren't listed.
- `GET /:organizationId` answers `{ data: { organization, plans, history } }`; `history` is the last 20 plan changes, newest first: `{ at, fromPlan, toPlan, note, changedBy: { id, name } | null }`.
- `PUT /:organizationId` `{ plan: "free_trial" | "full_access", note?: string (≤ 500) }` sets the plan and answers the same shape as GET plus `changed`. Raising and lowering are both allowed and apply on the customer's next request. Setting the plan the organization already has answers `changed: false` and writes nothing. Rate-limited to 120 writes per 15 minutes per staff account.
- Each change writes one `organization.plan_changed` audit event in the organization whose plan changed, in the same MongoDB transaction as the plan: actor (the staff account), `metadata.fromPlan`, `metadata.toPlan`, `metadata.proposalsCreated`, `metadata.actorOrganizationId` and the optional `metadata.note`.
- Errors: 400 `INVALID_PLAN` or `INVALID_PLAN_NOTE`; 404 `ORGANIZATION_NOT_FOUND` for a missing organization, a malformed id or a legacy holding tenant (identical bodies); 409 `PLAN_CHANGE_CONFLICT` when someone else changed the plan between the read and the write.
- A downgrade keeps the organization's RFPs, stored vendor responses and `proposalsCreated`; it locks the features and refuses new RFPs once the count is at the limit. AI jobs queued before a downgrade still finish (DECISIONS, ORG-603).

## Organization vendor list (ORG-606)

`routes/organizationVendorsRoute.ts`, rules in `src/modules/organizationVendors/application/manageOrganizationVendors.ts`. One shared list of vendor companies and contacts per organization (DXG decision Q4), for picking recipients when sending an RFP. Every route needs a signed-in member and acts on the caller's own organization only; another organization's vendor is 404 `VENDOR_NOT_FOUND`. No route accepts a public access grant, so a vendor's submission link never reaches the list. Roles (`authorizationPolicy.ts`): `vendor-list:write` for Owner, Admin and Team Manager; `vendor-list:read` for those plus Planner; a Viewer gets 403 on every route.

A vendor is `{ id, company, category, contacts: [{ name, email }], addedBy, archived, archivedAt, createdAt, updatedAt }`.

- `GET /api/v1/vendor-list?search=&category=&status=active|archived|all&limit=&offset=` returns `{ items, total, limit, offset }`, sorted by company. `search` matches part of the company or the category, ignoring case; `category` is an exact match, ignoring case. `status` defaults to `active`; `limit` defaults to 50 (max 200). Any other `status` is 400 `INVALID_VENDOR_STATUS`.
- `GET /api/v1/vendor-list/categories` returns the distinct categories of active vendors, as `string[]`.
- `GET /api/v1/vendor-list/:vendorId` returns one vendor, archived or not. A malformed id is 404, like a missing one.
- `POST /api/v1/vendor-list` `{ company, category?, contacts? }` adds a vendor (201). `company` is 1 to 200 characters, `category` free text up to 80, `contacts` up to 50 `{ name?, email }` with a valid email, each email once per vendor (400 `INVALID_VENDOR_COMPANY`, `INVALID_VENDOR_CATEGORY`, `INVALID_VENDOR_CONTACTS`, `INVALID_VENDOR_CONTACT_EMAIL`, `DUPLICATE_VENDOR_CONTACT_EMAIL`). Emails are stored in lower case. Active company names are unique per organization, ignoring case (409 `VENDOR_COMPANY_TAKEN`).
- `PATCH /api/v1/vendor-list/:vendorId` changes only the fields sent; `contacts` replaces the whole list (`[]` removes every contact; `null` is 400), and `category: ""` clears the category. Two people editing the same vendor at once: the last write wins. An archived vendor can't be edited (409 `VENDOR_ARCHIVED`).
- `POST /api/v1/vendor-list/:vendorId/archive` and `/restore` take a vendor off the default list and put it back. Both are idempotent. Restoring is 409 `VENDOR_COMPANY_TAKEN` when an active vendor has taken the name. There is no hard delete.
- Each add, edit, archive and restore writes a `SecurityAuditEvent` with `targetType: "organization_vendor"` (`organization_vendor.created`, `.updated`, `.archived`, `.restored`). The metadata records which fields changed and the contact count, never contact names or emails.

## RFP templates (ORG-604)

`routes/proposalTemplatesRoute.ts`, rules in `src/modules/proposalTemplates/application/manageProposalTemplates.ts`, snapshot rules in `src/modules/proposals/domain/templateSnapshot.ts`. A template is a snapshot of an RFP's content and presentation layout that members start new RFPs from (DXG decision Q4). Every route needs a signed-in member and acts on the caller's own organization only; no route accepts a public access grant. Responses are `{ success, data }`, errors `{ success: false, code, message }`; a role refused at the route (a Viewer anywhere, a non-manager on publish and unpublish) gets the shared 403 `{ success: false, message }` with no `code`.

Roles (`authorizationPolicy.ts`): `template:use` (Owner, Admin, Team Manager, Planner) lists and opens templates, saves personal ones and starts RFPs from them; `template:publish` (Owner, Admin) also manages organization templates. Viewers are refused on every route (403). Who sees what:

- A **personal** template is visible to the member who saved it and to nobody else, whatever their role.
- An **organization** template is visible to every `template:use` member while it is published and not archived. Unpublished or archived, only Owners and Admins see it.
- Another organization's template is 404 `TEMPLATE_NOT_FOUND`, the same answer as a missing or malformed id. A template in the caller's organization that they may not see is 403 `TEMPLATE_ACCESS_DENIED` (the RFP convention: in the organization but out of scope is 403).

A template is `{ id, title, description, scope: "personal"|"organization", presentationLayout: "template-one"|"template-two"|null, published, publishedAt, publishedBy, ownerUserId, ownedByMe, usable, archived, archivedAt, eventName, createdAt, updatedAt }`; the detail routes add `content`. `usable` says whether an RFP can be started from it now (not archived, and personal or published).

- `GET /api/v1/proposal-templates?scope=personal|organization|all&status=active|archived|all&search=&limit=&offset=` returns `{ items, total, limit, offset }` without `content`, sorted by title. Defaults: `scope=all`, `status=active`, `limit=50` (max 200). `search` matches part of the title or description, ignoring case. Any other `scope` or `status` is 400 `INVALID_TEMPLATE_SCOPE` / `INVALID_TEMPLATE_STATUS`.
- `GET /api/v1/proposal-templates/:templateId` returns one template with `content`.
- `POST /api/v1/proposal-templates` `{ proposalId, title, description?, scope?, presentationLayout? }` saves an RFP as a template (201). The caller needs view access to the RFP: one outside the organization is 404 `TEMPLATE_SOURCE_NOT_FOUND`, one in the organization that they can't see is 403 `PROPOSAL_ACCESS_DENIED` ("You don't have access to this RFP."). `scope` defaults to `personal`; `organization` needs `template:publish` (403 `TEMPLATE_PUBLISH_DENIED`) and publishes at once. `title` is 1 to 120 characters, `description` up to 500 (400 `INVALID_TEMPLATE_TITLE`, `INVALID_TEMPLATE_DESCRIPTION`, `INVALID_TEMPLATE_SCOPE`, `INVALID_TEMPLATE_LAYOUT`, `INVALID_TEMPLATE_SOURCE`). The RFP does not store which presentation layout it uses, so the client sends `presentationLayout`. The snapshot keeps the sections `event`, `venueSchedule`, `roomByRoom`, `production`, `hybridVirtual`, `contentCreative`, `venue` and `budget`, minus every key that names a date or schedule time, a contact person, an uploaded file, a co-vendor or the venue's in-house AV company name (`inHouseAvRequired` stays). It never holds the contact section, uploads, vendors, responses, status, lifecycle, team or owner. A snapshot over 512 KB is 413 `TEMPLATE_TOO_LARGE`. Saving a template uses no plan slot.
- `PATCH /api/v1/proposal-templates/:templateId` `{ title?, description? }` renames it. The snapshot never changes after it is saved. An archived template is 409 `TEMPLATE_ARCHIVED`.
- `POST /api/v1/proposal-templates/:templateId/publish` (Owner, Admin) makes one of the caller's own personal templates, or an unpublished organization template, an organization template in the picker. `POST …/unpublish` takes it out of the picker; it stays an organization template that Owners and Admins can publish again. Both are idempotent. Publishing an archived template is 409 `TEMPLATE_ARCHIVED`.
- `POST /api/v1/proposal-templates/:templateId/archive` and `/restore`: a personal template by its owner, an organization template by Owner or Admin (otherwise 403 `TEMPLATE_PUBLISH_DENIED`). Archiving also unpublishes, so a restored organization template is unpublished until someone publishes it again. Both are idempotent. There is no hard delete.
- `POST /api/v1/proposal-templates/:templateId/proposals` `{ eventName? }` starts a new RFP from the template (201, `data` is `{ proposal, presentationLayout }`: the RFP in the same shape as `POST /api/proposals`, and the template's layout for the client to apply, because the RFP record has no layout field). The route also needs `proposal:write`. The RFP is an unsubmitted draft owned by the caller, on the caller's team when they're on exactly one (ORG-202), with the template's content and no dates, contacts, vendors or files; nothing else in the body is read. Without `eventName` (up to 200 characters, 400 `INVALID_TEMPLATE_EVENT_NAME`) it takes the template's event name, then its title. It counts toward the plan limit like any new RFP: 403 `PLAN_LIMIT_REACHED` (ORG-601 body) at the limit. For a member who can see it, an archived template is 409 `TEMPLATE_ARCHIVED` and an unpublished organization template 409 `TEMPLATE_NOT_PUBLISHED` (Team Managers and Planners can't see either, so they get 403 `TEMPLATE_ACCESS_DENIED`).
- Each save, rename, publish, unpublish, archive and restore writes a `SecurityAuditEvent` with `targetType: "proposal_template"` (`proposal_template.created`, `.updated`, `.published`, `.unpublished`, `.archived`, `.restored`). The metadata carries the title and scope, never the snapshot. These actions are not in the audit view's catalog yet (see "Organization audit log"), so they are stored but an Owner or Admin does not see them at `/settings/audit`.

## Legacy customer placement

ORG-110, DXG admins only, at `/api/admin/legacy-customers` (`routes/adminLegacyCustomersRoute.ts`, `src/modules/tenancy/legacyCustomerPlacement.ts`).

- `GET /` lists the legacy customers not yet placed, with each one's RFP count. `GET /target-organizations?q=` searches the organizations a customer can be placed in. `GET /placements/:runId` returns one placement run (404 `PLACEMENT_NOT_FOUND`).
- `POST /:userId/placements` `{ target: "new", organization }` or `{ target: "existing", organizationId, role, teamId? }`. `teamId` must be an active team of that organization (400 `UNKNOWN_TEAM`). A second placement of the same user while one runs is 409 `PLACEMENT_IN_PROGRESS`. A failure leaves nothing moved (409 `PLACEMENT_FAILED`); a run whose ORG-109 checks fail is rolled back at once and answers 409 `PLACEMENT_VERIFICATION_FAILED` with `details.verification`.
- `POST /placements/:runId/rollback` moves back exactly the records the run moved (journaled ids); RFPs given to the user afterwards stay and are counted in `leftInTarget`. One rollback runs at a time (409 `ROLLBACK_IN_PROGRESS`, `ALREADY_ROLLED_BACK`); 409 `ROLLBACK_CONFLICT` when Postgres rows created since still depend on the user's rows.
- Until placed, the account can't use RFPilot: every sign-in method answers 403 `ORGANIZATION_SETUP_REQUIRED` (after the password or identity check, before 2FA), and any request on an existing session answers 401 `ORGANIZATION_SETUP_REQUIRED` and revokes all of that account's sessions.
- The API refuses placement with 503 `PLACEMENT_REQUIRES_MIGRATION_ROLE` when it has no `POSTGRES_MIGRATION_URL`, which is the case in production. There, run `node dist/scripts/placeLegacyCustomer.js` (`--list`; `--email --admin-email --new-org` or `--org-slug --role`; `--rollback=<runId>`; dry run unless `--apply`) as a one-off task on the migrate task definition, which holds both MongoDB and the migration role.

## Launch metrics (ORG-505)

`GET /api/v1/admin/launch-metrics?days=` returns the PRD success metrics for Organization Accounts as counts, rates and durations across all customer organizations (`routes/launchMetricsRoute.ts`, `src/modules/launchMetrics`). It carries no names, emails, ids or RFP content. Staff role and an `admins` account only: customers get the route guard's plain 403, and a member holding a staff role 403 `LAUNCH_METRICS_FORBIDDEN`. Each read writes a `platform.launch_metrics.read` audit event in the staff organization before anything is returned. `days` (1 to 365, default 30; otherwise 400 `INVALID_WINDOW`) is the window for the first three figures; the last two are as of now. `npm run report:launch-metrics -- [--days=30]` prints the same report for an operator with database access.

- `inviteAcceptance` `{ sent, atLeast7DaysOld, acceptedWithin7Days, acceptedLater, rate, target: 0.6 }`: of the invitations created in the `days`-long window that ended 7 days ago (so each has had its 7 days), the share accepted within 7 days of creation. Revoked and expired invitations stay in the denominator.
- `timeToFirstRfpOpened` `{ accepted, opened, notYetOpened, excludedOpenedBeforeAccepting, excludedAcceptedBeforeTracking, medianSeconds, openedWithin5Minutes, targetMedianSeconds: 300 }`: for invitations accepted in the window, the median time from acceptance to that member's first RFP opened in the organization (`OrganizationMembership.firstRfpOpenedAt`, stamped once by an authenticated `GET /api/proposals/:id`). Members who haven't opened one are counted, not timed. Acceptances from before the stamp existed (earlier than the earliest stamp on any membership) are counted in `excludedAcceptedBeforeTracking` and not timed, and a member invited back starts again from the new acceptance.
- `supportAccessUnderGrant` `{ reads, underActiveGrant, withoutActiveGrant, refusedWithoutGrant, rate, target: 1 }`: of the `support_access.used` audit events in the window, the share whose `metadata.grantId` names a grant in the same organization that covers the target and was active at that moment. `reads` counts audit events (one per grant used), not HTTP requests. `refusedWithoutGrant` counts `support_access.denied` attempts, which returned no data.
- `organizationsWithTwoOrMoreActiveUsers` `{ organizations, withTwoOrMoreActiveUsers, rate, target: 0.25 }`: active organizations (not legacy holding tenants) with at least one active member in a customer role, and how many have two or more. Staff memberships don't count.
- `orphanedRfps` `{ total, organizations, target: 0 }`: RFPs whose owner is not an active member of the RFP's organization, from the same check the nightly job runs.
- A `rate` or `medianSeconds` is `null` when there is nothing to measure yet.

## Where to find endpoints

- Backend route overview and legacy API: `../README.md`.
- AI component endpoints and payload examples: the relevant file under `architecture/`.
- Exact executable behavior: route/controller schemas in `src/`; code wins if an old slice example differs.
- Operational health and dependencies: [runbooks/API_AND_DEPENDENCIES.md](runbooks/API_AND_DEPENDENCIES.md).
- Helpdesk (support tickets): see "Helpdesk (support tickets)" above; `routes/supportDeskRoute.ts`, validation and status rules in `src/modules/supportDesk/domain.ts`.

The repository does not currently publish a generated OpenAPI contract. Adding one from runtime schemas is a documentation gap; until then, avoid copying full endpoint catalogs into multiple documents.
