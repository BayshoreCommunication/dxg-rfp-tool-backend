# Ticket Breakdown: Organization Accounts

> Derived from [ORGANIZATION_ACCOUNTS_PRD.md](ORGANIZATION_ACCOUNTS_PRD.md) on 2026-10-29. Updated 2026-11-01 for DXG's decisions on Q1–Q7 (see [dxg-open-questions.html](dxg-open-questions.html)): ORG-110 and M5 are new, and ORG-107, ORG-203, ORG-301 and ORG-402 changed. Each ticket names the PRD requirement or DXG decision it satisfies.
> Repos: **BE** = `dxg-rfp-tool-backend`, **DB** = `dxg-rfp-tool-dashboard`, **AD** = `dxg-rfp-tool-admin`.
> Size is engineer-days: S ≤ 2, M 3–5, L 6–8. Anything larger was split. A ticket that says it's blocked by a question can't start until DXG/Bayshore answers that question.
> Status updated 2026-11-09: each ticket ends with ✅ **Closed** (merged to `main`) or ⏳ **Open** with its target date. Closed status follows `PROJECT_STATE.md` ("Organization accounts").

## Summary

| Milestone | Tickets | Sizes | Eng-days (low–high / midpoint) | Status | Done by |
|---|---|---|---|---|---|
| M1 Tenancy foundation | ORG-101 … ORG-110 | 4S 4M 2L | 28–44 / 36 | ✅ Closed (10/10) | Merged |
| M2 People | ORG-201 … ORG-210 | 2S 7M 1L | 29–47 / 38 | ✅ Closed (10/10) | Merged |
| M3 Entry paths and auth | ORG-301 … ORG-307 | 2S 5M | 17–29 / 23 | ✅ Closed (7/7) | Merged 2026-11-08 |
| M4 Experience | ORG-401 … ORG-407 | 2S 4M 1L | 20–32 / 26 | ⏳ Open (2/7 closed: ORG-401, ORG-403) | Thu 12 Nov 2026, 16:00 BDT |
| M5 Plans and shared resources | ORG-601 … ORG-607 | 1S 6M | 19–32 / 25.5 | ⏳ Open (0/7) | Thu 12 Nov 2026, 16:00 BDT |
| Launch gate | ORG-501 … ORG-505 | 4S 1M | 7–13 / 10 | ⏳ Open (0/5) | Thu 12 Nov 2026, 16:00 BDT (ORG-503: see Timeline) |
| **Total** | **46** | 15S 27M 4L | **120–197 / ~158.5** (≈24–39 eng-weeks, midpoint ~32) | **29 closed, 17 open** | **Thu 12 Nov 2026, 16:00 BDT** |

Midpoints use S = 1.5, M = 4, L = 7 days. This bottom-up figure is well above the PRD's first planning range (11–16 eng-weeks). That range left out frontend work on both apps (each screen is its own ticket here), the repository-scoping sweep across every Mongo read path (ORG-104), and per-ticket testing. DXG's 1 Nov decisions added 8 tickets: placing legacy customers (ORG-110), free-trial plan limits (ORG-601 … ORG-603) and shared templates and vendor list (ORG-604 … ORG-607). Treat **~32 eng-weeks** as the working estimate: about 4 months of calendar time with two engineers in parallel after M1. The PRD timeline has been updated to match.

Critical path: ORG-101 → ORG-102 → ORG-103 → ORG-104 → ORG-106 → ORG-108 → (M2 and M3 in parallel) → M4 → launch gate. M5 runs in parallel with M2–M4 once ORG-104 lands.

## Timeline (set 2026-11-09)

**Deadline: Thursday 12 Nov 2026, 16:00 BDT (10:00 UTC)** for every milestone. Planned from Mon 9 Nov 19:00 BDT, which left about 69 hours. ORG-403 and ORG-401 merged on Tue 10 Nov, ahead of their 13:00 window, leaving 17 open tickets of about 55 engineer-days at midpoint estimates, so they run as **four Claude agents in parallel**, one per lane. Each agent works one ticket at a time in its own worktree (`.worktrees/org-<ticket>`, branch `feat/org-<ticket>-<slug>`), using `/ticket ORG-xxx`, and opens one PR per repo per ticket.

### Lanes

Lanes are split to keep dependencies inside a lane and to keep agents out of each other's files as much as possible.

| Lane | Focus | Tickets in order | Repos | Midpoint days |
|---|---|---|---|---|
| **Agent 1** | M4 trust: history, support grants, audit | ~~ORG-403~~ ✅ → 404 → 405 → 407 → 406 | BE, DB, AD | 13.5 left |
| **Agent 2** | M4 dashboards, then templates UI | ~~ORG-401~~ ✅ → 402 → 605 | BE, DB | 11 left |
| **Agent 3** | M5 plans and templates backend, metrics | ORG-601 → 603 → 602 → 604 → 505 | BE, DB, AD | 15 |
| **Agent 4** | M5 vendor list, then launch gate | ORG-606 → 607 → 501 → 502 → 504 | BE, DB | 15 |
| Human | Reviews and merges, external access | ORG-503 coordination, prod snapshot access for ORG-501 | — | — |

Cross-lane dependencies: ORG-605 (Agent 2) waits on ORG-604 (Agent 3, merged Thu 00:00). Everything else depends only on its own lane or on merged work.

### Schedule (all times BDT)

Merge windows are fixed. A PR that misses its window goes into the next one, and the agent starts its next ticket anyway.

| Window | Agent 1 | Agent 2 | Agent 3 | Agent 4 | Merge at end of window |
|---|---|---|---|---|---|
| Mon 19:00 → Tue 13:00 | ORG-403 ✅, then ORG-404 | ORG-401 ✅, then ORG-402 | ORG-601 | ORG-606 | ~~403~~ ✅, ~~401~~ ✅, 601, 606 |
| Tue 13:00 → Wed 13:00 | ORG-404 | ORG-402 | ORG-603, ORG-602 | ORG-607, start ORG-501 | 404, 603, 602, 607 |
| Wed 13:00 → Thu 00:00 | ORG-405, ORG-407 | ORG-402 finish | ORG-604 | ORG-501 | 402, 405, 407, 604, 501 |
| Thu 00:00 → Thu 10:00 | ORG-406 | ORG-605 | ORG-505 | ORG-502 | 406, 605, 505, 502 |
| **Thu 10:00 code freeze** → 14:00 | Fix QA findings | Fix QA findings | Fix QA findings | ORG-504 (docs only) | QA fixes, 504 |
| Thu 14:00 → 16:00 | Buffer: final CI, mark tickets Closed, close out `PROJECT_STATE.md` | | | | **Deadline 16:00** |

Thu 10:00–14:00 QA: `npm run ci` in all three repos on `main`, the backend integration suite (including cross-tenant isolation), `/verify-ui` walkthroughs as Owner, Admin, Team Manager, Planner and Viewer, and an internal security review of the new surfaces (support grants, plan gates, templates, vendor list).

### Rules for parallel agents

- **Done means merged.** Each PR needs `npm run ci` green in every repo it touches, plus `npm run test:integration` for backend changes and `/verify-ui` for screens. Run `/rfp-review` (tenant-isolation, AI-safety, dashboard and admin reviewer agents) before asking for human review.
- **Merge order within a window:** backend, then dashboard, then admin. A contract change goes through `/contract-change`, and its backend PR merges before the dashboard PR that uses the regenerated copy.
- **Postgres migrations:** take the next free number after rebasing on `main`, right before opening the PR. `migration:check` catches clashes, and the later PR renumbers.
- **Shared files** (`PROJECT_STATE.md`, `DECISIONS.md`, `API.md`, `DATABASE.md`, the `package.json` lint list, settings navigation): keep each edit small and in its own section, and rebase right before merging. ORG-504 consolidates the docs on Thursday.
- **Stay in the lane.** An agent that needs a change in another lane's ticket notes it in its PR instead of making the change itself.

### Human prerequisites (needed by Tue 09:00 BDT)

1. **Prod snapshot access for ORG-501:** an isolated restore of prod Mongo and PG, with credentials through Secrets Manager. Without it, ORG-501 rehearses on a staging copy and the prod rehearsal moves to cutover day.
2. **ORG-503 external pen test:** an outside vendor can't test M1–M4 between Thursday 00:00 and 16:00. The plan closes ORG-503 at the deadline with the internal security review and a booked external test date. Any high finding from the external test still blocks launch.
3. **Reviewer time at the four merge windows** (Tue 13:00, Wed 13:00, Thu 00:00, Thu 10:00). With about 25 PRs across three repos, review is the bottleneck, not agent time.

### Risks

- **ORG-402** (L) has the longest run, Tue 13:00 → Thu 00:00. If it slips, split it by role and land Planner and Admin first.
- **Agent 1 on Wednesday** has ORG-405 and ORG-407 back to back after ORG-404 merges. If ORG-404 misses Wed 13:00, ORG-406 slips to the freeze.
- **Overnight windows** (Wed 13:00 → Thu 00:00 and Thu 00:00 → 10:00) need someone awake to merge at Thu 00:00, or those PRs all land at 10:00 at once.

---

## M1: Tenancy foundation

**ORG-101 · Organization and membership schema extension** · BE · S · PRD P0-1, P0-2 · ✅ **Closed**
- `Organization`: add `type` (enum), `industry`, `country`, `timeZone`, `eventsPerYear`, `plan`, `billingStatus`, `verifiedDomains[]`, `autoApproveDomain`, `requireTwoFactor`, `allowManagerInvites`.
- `ORGANIZATION_ROLES`: add `owner`, `team_manager`, `viewer`. Keep the legacy DXG values readable for migration only and reject them on new writes.
- Partial unique index: one active `owner` per org.
- AC: model tests for enums and the owner uniqueness. Existing documents still load.

**ORG-102 · Scoped RFP access policy** · BE · M · P0-2 · blocked by: ORG-101 · ✅ **Closed**
- New `src/modules/identity/domain/rfpAccessPolicy.ts`: `canAccessRfp(actor, rfp, action)` and `rfpListScope(actor)` (returns a Mongo filter). Actor carries org id, roles, managed team ids, and share lookups.
- Actions: view, edit, viewResponses, reassign, archive, delete, share, grantSupport.
- AC: table-driven tests covering every source-matrix cell × {own, shared-view, shared-edit, team, other-team, foreign-org}. The list filter and the single-item check agree on a randomized fixture set.

**ORG-103 · Session carries tenant + scope context** · BE · S · P0-2 · blocked by: ORG-102 · ✅ **Closed**
- The authenticated request resolves membership (status active), roles, and managed team ids once per request. Deactivated or removed membership → 401 and revoke the refresh session.
- AC: integration test showing that deactivation takes effect on the next request, not at token expiry.

**ORG-104 · Repository scoping sweep (Mongo)** · BE · L · P0-2 · blocked by: ORG-103 · ✅ **Closed**
- Every read/write of `Proposal`, vendor submission/version/response/draft, canonical snapshot, notification, and public access grant takes `organizationId` from the session and uses ORG-102 for user scope.
- Foreign-org → 404. In-org but out of scope → 403.
- AC: grep/lint guard in CI fails on an unscoped `find`/`findOne`/`updateOne` against these models. Existing proposal and vendor-response suites stay green.

**ORG-105 · Postgres RLS alignment check** · BE · S · P0-2 · blocked by: ORG-103 · ✅ **Closed**
- Confirm that every tenant table's RLS session variable is set from the new per-customer org. Add a test that opens a scope for org A and reads zero rows seeded under org B for each RLS table.
- AC: test enumerates RLS tables from the catalog, so new tables are covered automatically.

**ORG-106 · Signup creates an organization** · BE · M · P0-1 · blocked by: ORG-101 · ✅ **Closed**
- Replace `requireDefaultOrganizationId()` in the password and Google signup paths. One Mongo transaction creates `Organization` + Owner membership + user. The PG identity projection still runs at sign-in.
- Remove the `customer → [planner, organization_admin, dxg_producer]` expansion from `legacyAuthorizationRoles`.
- AC: two new signups land in different orgs and can't see each other's RFPs (E2E). If the PG projection fails, sign-in still works and AI is shown as unavailable (existing behaviour).

**ORG-107 · Tenancy migration script (legacy holding tenants)** · BE · L · P0-1 · DXG decision Q1 · blocked by: ORG-106 · ✅ **Closed**
- `npm run migrate:customer-organizations` with dry-run default, `--run-id`, `--apply`, `--rollback-run`, migration-journal entries, idempotent. Same shape as `migrate:organization-memberships`.
- Per existing customer user: create a legacy holding tenant (`Organization.kind = legacy_holding`) with a single Planner membership, and rewrite `organizationId` on every Mongo model from ORG-104 and every PG tenant table. Strip DXG roles from customer memberships. No Owner is created.
- Holding tenants expose no org settings, invitations, teams, sharing, templates or vendor list, and are exempt from plan limits. The user sees only their own proposals, as today.
- The rewrite is a reusable function, which ORG-110 calls.
- AC: the dry-run report lists per-user counts per collection/table. Apply → verify → rollback → verify, round-tripped on a seeded fixture. The default org ends empty. A migrated user signs in and sees exactly their previous proposals.

**ORG-108 · Cross-tenant isolation suite** · BE · M · P0-2 · blocked by: ORG-104, ORG-105 · ✅ **Closed**
- `tests-integration/tenantIsolation`: two orgs × every role. Hit every RFP, vendor-response, assistant, evidence, export and file route, and assert no foreign data in bodies, counts, or error messages.
- AC: runs in CI. A deliberately unscoped route added in a test branch makes it fail.

**ORG-109 · Migration verification and orphan check** · BE · S · P0-1 · blocked by: ORG-107 · ✅ **Closed**
- `npm run verify:customer-organizations`: before/after RFP visibility per user is identical, no document carries the default org id, and every RFP's owner is an active member.
- The orphan check also runs nightly as a job (reused by PRD metric "orphaned RFPs = 0").

**ORG-110 · Place a legacy customer in an organization** · BE + AD · M · DXG decision Q1 · blocked by: ORG-107, ORG-206 · ✅ **Closed**
- Admin-app action for DXG staff: choose a legacy user, then either "new organization" (enter org details, and the user becomes Owner) or "existing organization" (pick org, role other than Owner and Viewer, optional team).
- Moves the holding tenant's Mongo and PG records into the target org with ORG-107's rewrite, as one journaled run with rollback by run id. Retires the holding tenant. Writes audit events in the target org and the admin audit trail.
- The admin app lists legacy users still unplaced, with their proposal counts.
- AC: placing into a new org and into an existing org both round-trip with rollback on a seeded fixture. After placement the user sees their proposals under the new org's rules, and the receiving Admin sees them. ORG-109's verifier passes after each run.

## M2: People

**ORG-201 · Teams and team memberships** · BE · M · P0-6 · blocked by: ORG-101 · ✅ **Closed**
- Models `Team` (org, name, archived) and `TeamMembership` (team, user, isManager), with unique (team, user).
- APIs: create, rename, archive; add/remove member; set manager. Owner/Admin only.
- AC: archiving removes manager scope over the team's RFPs (policy test) and keeps the RFPs visible to Admins and owners.

**ORG-202 · RFP team assignment** · BE · S · P0-7 · blocked by: ORG-201, ORG-104 · ✅ **Closed**
- `Proposal.teamId` (optional, indexed with org). Default it to the creator's team on create if they belong to exactly one team. Change it via the edit permission.
- AC: a Team Manager sees a newly created team RFP with no manual share.

**ORG-203 · Invitations backend** · BE · M · P0-4 · blocked by: ORG-101 · ✅ **Closed**
- `Invitation` model: hashed single-use token, 7-day expiry, status (pending/accepted/revoked/expired).
- Create (single + bulk with per-row results), resend (rotates the token), revoke. Accept requires the authenticated email to equal the invited email. Role and team come from the invite only.
- Team Manager may invite only into their own teams, and only when `allowManagerInvites` is on.
- Refuse an invite when the email already has an active membership in another org. A legacy user still in a holding tenant can't be invited; ORG-110 places them instead.
- No seat check (DXG decision Q2: pricing is by proposals created).
- AC: an expired, revoked or reused token is refused with distinct, non-leaking errors. Bulk paste of 200 emails with duplicates and invalid entries is reported per row.

**ORG-204 · Invitation emails** · BE · S · P0-4 · blocked by: ORG-203 · ✅ **Closed**
- Template with org name, inviter and role. The link goes to dashboard `/invite/[token]`. Resend and expiry reminder (day 6).

**ORG-205 · Accept-invite flow** · DB · M · P0-4 · blocked by: ORG-203 · ✅ **Closed**
- `/invite/[token]`: show org and role, then sign up with password/Google (Microsoft after ORG-302) or sign in. On accept, land on the role dashboard.
- AC: E2E for a new user, an existing signed-in user with the matching email, a mismatched email, and an expired token.

**ORG-206 · Membership management APIs** · BE · M · P0-6 · blocked by: ORG-103 · ✅ **Closed**
- List members (role, teams, status, last login), change role, change teams, deactivate, reactivate. Optimistic locking on `version`.
- Only the Owner can grant or remove `owner`. Ownership transfer is its own endpoint and keeps exactly one owner.
- The last Owner can't deactivate themselves.
- AC: policy tests for each actor. Deactivating a member who still owns RFPs returns 409 `OWNER_HAS_RFPS` with the count.

**ORG-207 · Offboarding reassignment** · BE · M · P0-6, P0-7 · blocked by: ORG-206 · ✅ **Closed**
- Reassign endpoint for many RFPs at once (all RFPs, or a selected list, from user X to user Y). Y must be active and allowed to own RFPs (not a viewer). One audit event per RFP.
- After reassigning, deactivation goes through.
- AC: no state exists in which a deactivated user still owns an RFP. Covered by ORG-109's checker.

**ORG-208 · RFP sharing** · BE · M · P0-7 · blocked by: ORG-104 · ✅ **Closed**
- `RfpShare` (rfp, user, permission view|edit, grantedBy). Share/unshare by owner, a Team Manager of the RFP's team, or an Admin. Same org only. Viewers get view only.
- Shares of deactivated users become inert and are kept for audit.
- AC: the policy picks up shares for list and detail. A vendor-response read through a share works, and works only through a share.

**ORG-209 · Users and Teams settings UI** · DB · L · P0-6 · blocked by: ORG-201, ORG-203, ORG-206, ORG-207 · ✅ **Closed**
- `/settings/users` and `/settings/teams`: table with filters/search, invite (single + paste-list), resend/revoke, change role/team, deactivate with the reassignment step, team CRUD and manager assignment. Hidden for roles without access, and the API refuses them anyway.
- AC: Playwright run through all actions as Admin. A Planner opening the URL directly gets a 403 page.

**ORG-210 · Share and reassign UI on RFPs** · DB · M · P0-7 · blocked by: ORG-208, ORG-207 · ✅ **Closed**
- Share dialog on the proposal page: search members, set view/edit, list current shares, revoke. "Change owner" and "Change team" for permitted roles.

## M3: Entry paths and auth

**ORG-301 · Org signup flow** · DB + BE · M · P0-3 · blocked by: ORG-106 · ✅ **Closed**
- Sign-up → email verification (existing OTP) → org details step → plan step (free trial: 2 proposals, vendor responses and proposal intelligence locked; DXG decision Q2) → "Invite your team" (skippable) → dashboard with a "Build your first RFP" prompt.
- AC: unverified users can't reach org creation or invites. Abandoning mid-flow and signing back in resumes at the right step.

**ORG-302 · Microsoft sign-in** · BE + DB · M · P0-11 · needs: Entra app registration (DXG) · ✅ **Closed**
- Multi-tenant Entra ID OIDC alongside Google. Account linking follows the Google rules (verified email match). Works in signup, sign-in and accept-invite.
- AC: E2E against a test Entra tenant. The PG identity projection is created on first Microsoft sign-in.

**ORG-303 · TOTP 2FA enrolment and challenge** · BE + DB · M · P0-11 · ✅ **Closed**
- Enrol (QR + confirm code), 10 single-use recovery codes stored hashed, challenge step after password sign-in, disable with re-auth. Secrets encrypted at rest.
- AC: replaying a used code is refused. Brute force is rate-limited with the existing shared limiter.

**ORG-304 · Org-mandatory 2FA and admin reset** · BE + DB · S · P0-11 · blocked by: ORG-303 · question: Q8 · ✅ **Closed**
- When `requireTwoFactor` is on, members without 2FA are routed to enrolment on next sign-in. An Admin can reset a member's 2FA, and the reset is audited.
- AC: a member who signs in with SSO gets the behaviour Q8 decides (default until answered: still challenged).

**ORG-305 · Domain verification** · BE + DB · M · P0-5 · question: Q7 · ✅ **Closed**
- An Admin adds a domain and gets a DNS TXT token. A background check verifies it and re-checks weekly. A list of public mail domains is never verifiable.
- AC: unit test with a mocked resolver. Removing the TXT record un-verifies the domain after the re-check.

**ORG-306 · Domain-match access requests** · BE + DB · M · P0-5 · blocked by: ORG-305, ORG-301 · ✅ **Closed**
- At signup, if the email domain matches a verified domain, the user chooses "Request access" or "Create separate organization".
- `AccessRequest` model. Admins get a bell notification + email. Approving sets role (default Planner) and team. Auto-approve when `autoApproveDomain` is on.
- AC: the signup response doesn't reveal the org name unless the domain is verified. Denied users can still create their own org.

**ORG-307 · Session hardening for membership changes** · BE · S · P0-6, P0-11 · blocked by: ORG-103 · ✅ **Closed**
- A role change, deactivation, or 2FA reset revokes the member's other refresh sessions. Role changes take effect on the next request without needing to sign out.

## M4: Experience

**ORG-401 · Scoped dashboard query APIs** · BE · M · P0-8 · blocked by: ORG-104, ORG-202 · ✅ **Closed** (merged Tue 10 Nov, PR #119)
- One list endpoint with filters (status, owner, team, event date range, venue city) plus a summary endpoint (active RFPs, responses received, awarded this quarter). Both go through `rfpListScope`.
- AC: the summary always equals aggregating the list (property test). p95 < 300 ms on an org with 5k RFPs, with indexes added.

**ORG-402 · Role dashboards UI** · DB · L · P0-8 · blocked by: ORG-401 · ⏳ **Open** (Agent 2 · merge Thu 00:00 BDT)
- Planner: My RFPs by status, deadlines, new submissions. Team Manager: adds a team tab with a planner filter. Admin: org-wide view with all filters and the summary row.
- Planners see a one-line note that their organization's Admins can see their drafts (DXG decision Q6).
- AC: Playwright as each role. A Viewer sees a "Shared with me" view only, read-only, with no commenting (DXG decision Q3).

**ORG-403 · RFP status history** · BE · S · P0-10 · ✅ **Closed** (merged Tue 10 Nov, PR #117)
- Append-only status transitions (from, to, actor, at) on every lifecycle change, plus counts of vendors invited and responded per RFP.
- Backfill existing RFPs with one synthetic "current status as of migration" entry.
- AC: every write path that changes status records a transition (test enumerates them).

**ORG-404 · Support access grants backend** · BE · M · P0-9 · ⏳ **Open** (Agent 1 · merge Wed 13:00 BDT)
- `SupportAccessGrant` (org, optional rfp, grantedBy, expiresAt default 7d and max 30d, revokedAt). Owner/Admin create and revoke.
- Admin-app routes that read customer RFP data require an active matching grant for the signed-in `admins` account. Every use writes an audit event (agent, grant, object).
- AC: an expired or revoked grant is refused immediately. Reading ticket content in `supportDesk` still works without a grant, but reading the RFP behind a ticket requires one.

**ORG-405 · Support grants UI (customer side)** · DB · S · P0-9 · blocked by: ORG-404 · ⏳ **Open** (Agent 1 · merge Thu 00:00 BDT)
- In org settings: grant for the whole org or a picked RFP, set expiry, revoke, and see past grants with their Support activity.

**ORG-406 · Support workspace changes (admin app)** · AD · M · P0-9 · blocked by: ORG-404 · ⏳ **Open** (Agent 1 · merge Thu 10:00 BDT)
- "Granted to me" list with expiry. RFP and vendor views reachable only through a grant. Clear banner showing the grant scope and time left. The existing `clients` and `proposals` pages are changed to respect grants.

**ORG-407 · Org audit log view** · BE + DB · M · P0-10 · blocked by: ORG-203, ORG-206, ORG-208, ORG-404 · ⏳ **Open** (Agent 1 · merge Thu 00:00 BDT)
- Audit events for every action listed in PRD P0-10, on `SecurityAuditEvent` / the PG audit chain.
- Admin view under `/settings/audit` with filters for user, action and date, plus CSV export.
- AC: each audited action has a test asserting the event is written. Members can't read other orgs' events (covered by the isolation suite).

## M5: Plans and shared resources

**ORG-601 · Plan entitlements and the free-trial limit** · BE · M · DXG decision Q2 · blocked by: ORG-101, ORG-104 · ⏳ **Open** (Agent 3 · merge Tue 13:00 BDT)
- Entitlements module: `canCreateProposal(org)` and `hasFeature(org, 'vendorResponses' | 'proposalIntelligence')`. Plan table in code and config. `free_trial` = 2 proposals created per org, both features locked.
- `Organization.proposalsCreated` increments in the same transaction as every proposal creation path (new, duplicate, from template) and never decrements.
- Enforced on the server: proposal create returns a distinct `PLAN_LIMIT_REACHED` error. Vendor-response reads, compare and export and every proposal intelligence action (evaluation, comparison, requirements, evidence extraction, vendor intelligence) return `PLAN_FEATURE_LOCKED`. Intelligence AI jobs aren't queued for locked orgs. Vendor submissions are still accepted and stored.
- Legacy holding tenants are exempt.
- AC: the third create is refused, and so is a concurrent double-create at the limit (race test). Each gated route is refused on free and allowed after a plan change (the test enumerates the routes). Deleting a proposal doesn't free a slot.

**ORG-602 · Locked states and upgrade prompts** · DB · M · DXG decision Q2 · blocked by: ORG-601 · ⏳ **Open** (Agent 3 · merge Wed 13:00 BDT)
- Proposal-limit counter ("1 of 2 proposals used") and a clear message on the create button at the limit.
- Vendor responses tab and the proposal intelligence pages show a locked state with the response count and an upgrade prompt ("Contact us" until paid plans exist), instead of an error.
- AC: Playwright on a free org covers the limit, the locked tabs, and unlocking after a plan change.

**ORG-603 · Plan management in the admin app** · AD + BE · S · DXG decision Q2 · blocked by: ORG-601 · ⏳ **Open** (Agent 3 · merge Wed 13:00 BDT)
- DXG staff view and change an organization's plan, with an audit event for each change. Shows proposals created against the limit.

**ORG-604 · Proposal templates backend** · BE · M · DXG decision Q4 · blocked by: ORG-104, ORG-601 · ⏳ **Open** (Agent 3 · merge Thu 00:00 BDT)
- `ProposalTemplate` (org, owner, scope personal|organization, title, content snapshot, presentation layout, publishedBy, archived). Save from a proposal (content and layout, no vendors, responses or dates). Create a proposal from a template, which counts toward the plan limit.
- Org-scope publish, unpublish and archive by Owner and Admin. Personal templates are visible only to their owner. Viewers can't use templates. Audit events for publish and archive.
- AC: isolation suite covers templates. Policy tests per role. A proposal created from a template is owned by its creator and lands on their team (ORG-202).

**ORG-605 · Templates UI** · DB · M · DXG decision Q4 · blocked by: ORG-604 · ⏳ **Open** (Agent 2 · merge Thu 10:00 BDT)
- "Save as template" on a proposal (personal, or organization for Owner and Admin). Template picker at the start of proposal creation, beside the two existing layouts. Template management list under org settings.

**ORG-606 · Organization vendor list backend** · BE · M · DXG decision Q4 · blocked by: ORG-104 · ⏳ **Open** (Agent 4 · merge Tue 13:00 BDT)
- `OrganizationVendor` (org, company, category, contacts [name, email], addedBy, archived). CRUD by Owner, Admin and Team Manager. Read by every non-viewer member. Search by company and category. Audit events for edits.
- AC: isolation suite covers the vendor list. Vendors never see it through the submission link.

**ORG-607 · Vendor list UI and picking vendors when sending** · DB · M · DXG decision Q4 · blocked by: ORG-606 · ⏳ **Open** (Agent 4 · merge Wed 13:00 BDT)
- Vendor list page under org settings (add, edit, archive, search, paste-import of contacts). When sending a proposal, pick vendors and contacts from the list or type new ones, with an option to save a new vendor to the list if the user's role can edit it.

## Launch gate

**ORG-501 · Migration rehearsal on prod snapshot** · BE · M · blocked by: ORG-107, ORG-109 · ⏳ **Open** (Agent 4 · merge Thu 00:00 BDT)
- Restore a snapshot of prod Mongo + PG into an isolated environment (credentials via Secrets Manager), then run dry-run → apply → verify → rollback → verify, and record timings for the maintenance window.

**ORG-502 · Cutover and rollback runbook** · BE · S · blocked by: ORG-501 · ⏳ **Open** (Agent 4 · merge Thu 10:00 BDT)
- `docs/runbooks/ORG_TENANCY_CUTOVER.md`: pause the worker and dispatcher, drain the outbox, migrate, verify, resume, smoke test. The rollback trigger and its steps are already rehearsed (ORG-501).

**ORG-503 · External pen test** · — · S (coordination) · blocked by: M1–M4 · ⏳ **Open** (internal review Thu 14:00 BDT; external test date set by the vendor)
- Scope: tenant isolation, role escalation, invite/token handling, support grants, 2FA bypass. Any high finding blocks launch.

**ORG-504 · Docs and decisions** · BE · S · ⏳ **Open** (Agent 4 · Thu 14:00 BDT)
- `DECISIONS.md` entries: per-customer tenancy with legacy holding tenants, scoped policy, support-grant model, auth-provider choice, and plan entitlements by proposals created. Update `DATABASE.md`, `API.md`, `PROJECT_STATE.md`.

**ORG-505 · Launch metrics instrumentation** · BE · S · ⏳ **Open** (Agent 3 · merge Thu 10:00 BDT)
- Queries and dashboard for the PRD success metrics: invite acceptance, time from invite to first RFP opened, orgs with 2+ users, support access under a grant, orphan count.

---

## Not ticketed yet (fast follow, or dropped)

- Guest review links for outside clients: a secure, expiring, read-only link to one proposal (fast follow, DXG decision Q7).
- Paid plans and online checkout, once DXG defines them (follow-up F5). ORG-601's plan table takes new plans as data.
- CSV invite, per-team manager-invite setting, stale-invite cleanup (P1-2, P1-5, P1-6).
- Dropped: Viewer commenting (DXG decision Q3) and seat caps (DXG decision Q2).
