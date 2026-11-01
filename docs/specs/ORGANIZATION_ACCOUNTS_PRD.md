# PRD: Organization Accounts, Users, Teams and Permissions

> Source: *RFPilot: Organization-Based Accounts, Users, and Permissions* (DXG → Bayshore). Drafted 2026-10-29 against the current backend (`dxg-rfp-tool-backend`). Status: **DXG decisions recorded 2026-11-01** (see [dxg-open-questions.html](dxg-open-questions.html); its Q1–Q7 numbering differs from the questions below, and each answer is mapped here). In code an RFP is a `Proposal`; this document says "RFP".

## Problem Statement

RFPilot treats every customer as an individual. A Director of Events can't see the RFPs their planners build, can't take over a departing planner's work, and has no way to add colleagues with limited rights. There's also a structural problem the source spec doesn't mention: **every signup today is put into one shared default organization** (`requireDefaultOrganizationId()` in `mongoAuthAccountRepository.ts`), and the legacy `customer` role maps to `planner + organization_admin + dxg_producer`. So right now separation between customers depends on queries filtering by `userId`, not on the tenant boundary. Organization accounts fix the product gap, and the same work fixes this risk.

Without it: no multi-seat sales to agencies or associations, no team visibility (DXG's main ask), and data isolation stays only as strong as each query that filters by owner.

## What already exists (and what doesn't)

| Exists today | Missing |
|---|---|
| `Organization` (name, slug, status) | Org profile fields (type, industry, country, time zone, plan, billing status, verified domain, auto-approve) |
| `OrganizationMembership` (org, user, `roles[]`, status invited/active/suspended/removed, version) | Owner role, Team Manager, Viewer; teams; team memberships |
| Action-based policy (`authorizationPolicy.ts`: `proposal:read/write/publish`, `organization:manage`, …) | Visibility *scope* (own / shared / team / org). Today an action is allowed or refused, with no idea of whose RFP it is |
| `Proposal.organizationId` + `userId` (owner) | `teamId`, shares, status history |
| Forced organization RLS on PostgreSQL tenant tables | The same guarantee on Mongo reads: has to be enforced in repositories |
| Google sign-in, email OTP, refresh sessions, `SecurityAuditEvent` | Microsoft sign-in, TOTP 2FA, invitations, access requests |
| Separate `admins` collection for DXG staff (live 2026-10-26) | Grant-based, time-limited RFPilot Support access into a customer org |
| Vendor portal on `PublicAccessGrant` | — (stays as is; vendors remain external) |

## Goals

1. **Tenant isolation is the system's backstop.** Every customer org is its own tenant. Zero cross-org reads in automated isolation tests and in an external pen test before launch.
2. **Managers get team visibility.** Admins see 100% of their org's RFPs, Team Managers 100% of their teams' RFPs, without anyone sharing manually.
3. **Orgs grow past one seat.** ≥25% of active orgs have 2+ active users 90 days after launch (baseline: 0, because orgs don't exist yet).
4. **Nobody loses access in the migration.** 100% of existing users can sign in after the cutover and see exactly the RFPs they could see before. Zero RFPs orphaned.
5. **Support access is accountable.** 100% of RFPilot Support reads of customer data happen under an active grant and are audit-logged.

## Non-Goals

- **Org reporting and analytics.** That's a later phase. We *do* capture status history from day one (see P0-10) so reports work retroactively.
- **SAML / enterprise SSO.** Later phase. Design the auth-provider abstraction so SAML is a new provider, not a rewrite.
- **A user in several organizations.** Later phase. At launch one user has one active membership. The membership table already supports many, so don't add a unique index on `userId` (P2-3).
- **Seat limits and online checkout.** Pricing is by proposals created, not seats (DXG decision). Launch enforces the free-trial limits (P0-12) and DXG staff change plans by hand. Online checkout waits until DXG defines paid plans.
- **Commenting.** Dropped (DXG decision). Viewers are read-only.
- **Changes to the vendor experience.** Vendors stay on grant links, with no accounts and no view of org users.

## Personas

Owner · Admin (Director of Events) · Team Manager · Planner · Viewer (stakeholder or client exec) · RFPilot Support (DXG staff, outside every org) · Invitee · Existing individual user (migration).

## User Stories

**Owner / Admin**
- As an Owner, I want to create my organization at signup so that my team's RFPs live under one account from day one.
- As an Admin, I want to invite colleagues singly or by pasting a list of emails, each with a role and optional team, so that onboarding a department takes minutes.
- As an Admin, I want to see every RFP in my org, filtered by planner, team, status, event date and venue city, so that I can manage the portfolio.
- As an Admin, I want to be made to reassign a departing planner's RFPs before deactivating them so that no work is lost or orphaned.
- As an Admin, I want to approve or deny access requests from people on our email domain, or auto-approve our verified domain, so that colleagues can't create shadow orgs without me knowing.
- As an Admin, I want to grant RFPilot Support access to one RFP or the whole org for a limited time so that I get help without handing over a login.
- As an Admin, I want to require 2FA for my org so that our vendor pricing is protected.
- As an Owner, I want to transfer ownership so that the account survives my leaving.

**Team Manager**
- As a Team Manager, I want a team view filterable by planner so that I can track my group without seeing the whole org.
- As a Team Manager, I want to reassign an RFP between planners on my team so that I can cover absences.

**Planner**
- As a Planner, I want my dashboard to show only my RFPs and those shared with me, grouped by status with upcoming deadlines, so that I focus on my own work.
- As a Planner, I want to share an RFP with a colleague as view or edit so that we can collaborate.

**Viewer**
- As a Viewer, I want read-only access to the RFPs and vendor responses shared with me, so that I can review without changing anything. (No commenting: DXG decision.)

**RFPilot Support**
- As a Support agent, I want to see which orgs have granted me access and until when, so that I only work where I'm allowed.

**Invitee / new signups**
- As an invitee, I want to accept an invite with a password, Google or Microsoft and land in my org with my role already set.
- As someone signing up with `@company.com` where Company already uses RFPilot, I want to be offered "Request access" rather than silently creating a separate org.

**Existing individual user**
- As an existing user, I want to sign in after the change and find all my RFPs, now inside an org I own.

**Edge cases**
- An invite link expires or is revoked → a clear message and a "request a new invite" path.
- The last Owner tries to leave or deactivate themselves → blocked until ownership is transferred.
- A user is deactivated mid-session → their next API call is refused and the refresh token is revoked.
- A Team Manager's team is archived → its RFPs stay visible to Admins and their owners, and the manager loses team-scope access to them.
- A shared user is deactivated → their shares become inert and are kept for audit.

## Requirements

### P0: Must have for launch

**P0-1. Per-customer tenancy and migration off the shared default org**
Every user belongs to exactly one customer organization. Signup creates a new org; it no longer attaches users to the default org.
- [ ] New signups create `Organization` + Owner membership in one transaction (Mongo session), then project into PG `rfpilot.users` (the existing sign-in hook).
- [ ] Migration script in the existing pattern (`migrate:organization-memberships`): dry-run by default, `--run-id`, `--apply`, `--rollback-run`. Per DXG's decision, existing users are kept as they are: it creates one legacy holding tenant per existing user (single Planner membership, no Owner, no org features, exempt from plan limits) and moves the user's `Proposal`, vendor submissions/responses, grants, support tickets, notifications and PG tenant rows (AI runs, evidence, conversations, requirement sets…) to it.
- [ ] Admin-app operation for DXG staff to place a legacy user in an organization: a new one (user becomes Owner) or an existing one (chosen role and team). Their records move with them in one journaled, reversible run, and the placement is audited.
- [ ] DXG staff (`admins` collection) get no customer membership. Legacy `dxg_producer` / `dxg_admin` / `super_admin` roles are removed from customer memberships.
- [ ] Legacy `customer → [planner, organization_admin, dxg_producer]` mapping removed from `legacyAuthorizationRoles`.
- [ ] Verification report: per-user RFP counts before = after; no document still carries the default org id.
- Given a migrated user, when they sign in, then they see exactly the RFPs they owned before, and nothing changes for them until a DXG admin places them in an organization.

**P0-2. Roles and scoped authorization**
Roles: `owner`, `organization_admin`, `team_manager`, `planner`, `viewer`. RFPilot Support is not a membership role (see P0-9). Authorization becomes *action + scope*: a policy function `canAccessRfp(actor, rfp, action)` evaluated in the backend for every RFP and vendor-response read or write, following the permissions matrix in the source spec.
- [ ] Single authority: one policy module with table-driven tests covering every matrix cell (role × action × own/shared/team/other/foreign-org).
- [ ] Every Mongo repository method that reads RFP-derived data takes the org id from the authenticated session and puts it in the query filter. Lint or test guard: no `Proposal.find` without `organizationId`.
- [ ] Lists come from the same policy, so a list never shows an RFP the detail route would refuse.
- [ ] Refusals return 404 for RFPs in other orgs (no existence oracle) and 403 for in-org RFPs outside your scope.
- [ ] Exactly one active Owner per org, enforced at write time.

**P0-3. Organization signup (Path A)**
Name, work email, password, *or* Google/Microsoft → email verification → org details (name, type, industry, events/year, country, time zone) → plan/trial → "Invite your team" (skippable) → dashboard with "Build your first RFP".
- [ ] Unverified email can't create an org or send invites.
- [ ] Org type enum: corporate, association, agency, venue, government, other.

**P0-4. Invitations (Path B)**
- [ ] Admin (and Team Manager, for their own teams, if the org setting allows) invites one or many emails with role and optional team.
- [ ] Token: random and single-use, stored hashed, expires after 7 days. Resend rotates the token. Revoke invalidates it.
- [ ] Accepting binds the role and org from the invite, not from anything the client sends. The invited email must match the authenticated email (including Google/Microsoft).
- [ ] An invite to an email that already has an active membership elsewhere is refused with an explanation (single-org at launch).
- [ ] Bulk paste: dedupe, validate, report per-row results. No partial silent failure.

**P0-5. Domain-match access requests (Path C)**
- [ ] On signup, if the email domain equals an org's **verified** domain, offer "Request access" or "Create a separate organization". Only verified domains trigger this. Public mail domains (gmail.com, outlook.com…) never do.
- [ ] Requests notify that org's Admins (bell + email). Approve sets role (default Planner) and team.
- [ ] Optional per-org "auto-approve verified domain" setting.
- [ ] Domain verification by DNS TXT record (or verified-email proof by an Admin: open question Q7).

**P0-6. Users and Teams settings**
- [ ] User table: name, email, role, teams, status (active/invited/deactivated), last login. Filters and search.
- [ ] Change role or team (Owner/Admin). Optimistic locking on membership `version`.
- [ ] Deactivate: login and refresh are blocked immediately and the user's RFPs stay in the org.
- [ ] Offboarding: deactivating a user who owns RFPs requires choosing a new owner (bulk, or per RFP). RFPs are never deleted or left without an owner.
- [ ] Teams: create, rename, archive. A user can be on several teams. Team Manager is a per-team flag.

**P0-7. RFP ownership, team assignment and sharing**
- [ ] RFP stores `organizationId`, `ownerUserId` (existing `userId`), optional `teamId`. New RFPs default `teamId` to the creator's team if they have exactly one.
- [ ] Share with in-org users as `view` or `edit`, by the owner, a Team Manager of the RFP's team, or an Admin. Viewers can only ever receive `view`.
- [ ] Vendor responses inherit the RFP's visibility. No separate ACL.
- [ ] Reassign ownership: Owner/Admin anywhere in the org; Team Manager within their team.
- [ ] Archive is the default. Hard delete only by Owner/Admin/own-only per matrix, and it goes through the existing purge propagation (Mongo + PG + object storage).

**P0-8. Role-based dashboards**
- [ ] Planner: My RFPs by status (draft, sent, receiving responses, under review, awarded, archived), upcoming deadlines, new submissions.
- [ ] Team Manager: + team view, filter by planner.
- [ ] Admin: org-wide list filterable by planner, team, status, event date, venue city. Summary row: active RFPs, responses received, awarded this quarter.
- [ ] The dashboard's counts come from the same scoped query as its list.

**P0-9. RFPilot Support access grants**
- [ ] DXG staff sign in through the admin app (`admins` collection), never as org members.
- [ ] Owner/Admin grants access to one RFP or the whole org, with an expiry (default 7 days, max 30), and can revoke at any time.
- [ ] Every Support request into customer data checks for an active grant on the server and writes an audit event naming the agent, the grant and the object.
- [ ] The org's Admins can see active and past grants and the Support activity under each.
- [ ] Support tickets (`supportDesk`) keep working without a grant for ticket content itself. Reading RFP content from a ticket needs a grant.

**P0-10. Audit log and status history**
- [ ] Audit events: login (success/fail), 2FA changes, invite sent/accepted/revoked, role/team change, deactivation, ownership transfer, share granted/revoked, support grant/use/revoke, org settings change. Built on `SecurityAuditEvent` / the PG audit chain. Append-only.
- [ ] Admin-visible audit view for their own org (filter by user, action, date).
- [ ] RFP status transitions stored with actor and timestamp (reporting readiness), plus vendors invited/responded counts per RFP.

**P0-11. Authentication additions**
- [ ] Microsoft sign-in (Entra ID, multi-tenant OIDC) next to the existing Google sign-in.
- [ ] TOTP 2FA (authenticator app) with recovery codes. Per-org "require 2FA": users without it are routed to enrolment on next sign-in. Admins can reset a member's 2FA, and the reset is audited.
- [ ] SSO sign-ins obey org 2FA policy unless the IdP asserts MFA (open question Q8).

**P0-12. Plans and free-trial limits** (DXG decision)
Pricing is by proposals created. Every new organization starts on a free trial.
- [ ] Free trial allows 2 proposals created per organization. Deleting doesn't free a slot. Duplicates and template starts count.
- [ ] Vendor responses and proposal intelligence are locked on the free trial, enforced on the server with a distinct plan-required error. Vendors can still submit, and responses unlock on upgrade.
- [ ] Locked features show an upgrade prompt ("Contact us" until paid plans exist). DXG staff change an organization's plan in the admin app, audited.
- [ ] No seat limits. Invitations never check seats.

**P0-13. Organization templates and vendor list** (DXG decision)
- [ ] Save a proposal as a template, and start a new proposal from one. Owner and Admin publish organization templates. Planners keep personal templates.
- [ ] One organization vendor list of companies and contacts, edited by Owner, Admin and Team Manager, picked from when sending a proposal.
- [ ] Both are org-scoped and covered by the isolation suite.

### P1: Fast follow

- **P1-1.** Guest review links for outside clients: a secure, expiring, read-only link to one RFP (DXG decision). Commenting is dropped.
- **P1-2.** Bulk invite by CSV with role/team columns.
- **P1-3.** Moved to P0-13 (DXG decision).
- **P1-4.** Paid plans and online checkout, once DXG defines them.
- **P1-5.** Team Manager invite permission as a per-team (not only per-org) setting.
- **P1-6.** "Last active" and stale-invite cleanup.

### P2: Design for, don't build

- **P2-1.** Reporting on status history, turnaround, awarded vs budget, by planner/team/event type/city. Needs P0-10 fields now.
- **P2-2.** SAML SSO and SCIM provisioning. Keep providers pluggable and membership provisioning behind one service.
- **P2-3.** Multi-org users with an org switcher. Session carries the active `organizationId`. Keep membership many-to-many and never assume `user.organizationId` is the only one.
- **P2-4.** External guest viewers (client execs outside the org) on time-limited grants, like the vendor grant model.

## Success Metrics

| Metric | Type | Target | Measured by | When |
|---|---|---|---|---|
| Cross-org access in isolation suite + pen test | Leading | 0 | CI isolation tests; third-party test | Pre-launch gate |
| Migrated users with identical RFP visibility | Leading | 100% | Migration verification report | Cutover day |
| Invite acceptance within 7 days | Leading | ≥60% | invitations table | 30 days |
| Invitee time from accept to first RFP opened | Leading | median < 5 min | audit + RFP events | 30 days |
| Support data access under active grant | Leading | 100% | audit log | Continuous |
| Orgs with 2+ active users | Lagging | ≥25% (stretch 40%) | memberships | 90 days |
| Orphaned RFPs (owner inactive, no reassignment) | Lagging | 0 | nightly check | Continuous |
| Access-related support tickets | Lagging | ↓ vs first month | supportDesk tags | 90 days |

## Open Questions

**Decided by DXG (2026-11-01)**
- **Q1. Migration grouping.** *Decided:* keep existing users as they are. Each sits in a private legacy holding tenant with today's access, and a DXG admin places them in an organization later (P0-1).
- **Q2. Auth provider.** *Decided:* our recommendation. Keep the in-house auth and add Microsoft OIDC + TOTP. Revisit when SAML/SCIM is scheduled.
- **Q3. Pricing.** *Decided:* by number of proposals created. Free trial of 2 proposals with vendor responses and proposal intelligence locked. No seat limits, so whether Viewers count as seats no longer matters (P0-12).
- **Q4. Templates and vendor lists.** *Decided:* shared across the organization, at launch (P0-13).
- **Q5. Commenting.** *Decided:* not needed. Viewers are read-only.
- **Q6. Admins and drafts.** *Decided:* Admins see planners' drafts. Planners are told so in the product.
- **Viewers and outside clients.** *Decided:* our recommendation. Viewers are members only at launch, and guest review links are a fast follow (P1-1).

**Follow-ups sent to DXG (built to these assumptions until answered)**
- **F1.** The free limit is per organization. **F2.** Deleting a proposal doesn't free a slot. **F3.** Free users can send to vendors, and responses unlock on upgrade. **F4.** Limits don't apply to unplaced legacy users. **F5.** Upgrades are manual through DXG staff until paid plans exist. **F6.** Owner and Admin publish templates; Owner, Admin and Team Manager edit the vendor list.

**Non-blocking**
- **Q7 (eng/security).** Domain verification: DNS TXT only, or also "an Admin with a verified email at that domain"?
- **Q8 (security).** Does Google/Microsoft sign-in satisfy an org's mandatory 2FA?
- **Q9 (DXG).** Team Manager scope on an RFP with no team: none (matrix reading) or "my planners' RFPs"? *Recommendation: team-tagged RFPs only, and default `teamId` at creation (P0-7).*
- **Q10 (DXG).** Deleting the organization: retention window and data export before purge?
- **Q11 (legal).** Does support access need to show in a customer-facing data-processing addendum?

## Timeline Considerations

DXG wants every role in from day one so permissions are never retrofitted. We keep that scope but ship it in internal milestones so the risky tenancy change lands and gets checked before UI work piles on top of it.

| Milestone | Contents | Rough effort* |
|---|---|---|
| **M1. Tenancy foundation** | P0-1 (signup creates org, legacy holding-tenant migration, placing legacy users), P0-2 policy + repository scoping, isolation test suite | 5.5–9 eng-weeks |
| **M2. People** | P0-4 invites, P0-6 users/teams, P0-7 ownership/sharing/reassignment | 6–9 eng-weeks |
| **M3. Entry paths and auth** | P0-3 signup flow, P0-5 domain requests, P0-11 Microsoft + TOTP 2FA | 3.5–6 eng-weeks |
| **M4. Experience** | P0-8 dashboards, P0-9 support grants + admin-app changes, P0-10 audit view + status history | 4–6.5 eng-weeks |
| **M5. Plans and shared resources** | P0-12 free-trial limits and locked features, P0-13 org templates and vendor list | 4–6.5 eng-weeks |
| **Launch gate** | Pen test, migration rehearsal on prod snapshot, cutover runbook, rollback rehearsal | 1.5–2.5 eng-weeks |

\*Bottom-up from the 46 tickets in [ORGANIZATION_ACCOUNTS_TICKETS.md](ORGANIZATION_ACCOUNTS_TICKETS.md): 24–39 eng-weeks, midpoint ~32, or about 4 months of calendar time with two engineers working in parallel after M1. Bayshore to confirm (source spec Q1).

**Dependencies:** Microsoft Entra app registration (DXG tenant/admin); DNS access for domain verification testing; pen-test vendor booking; a prod Mongo + PG snapshot for migration rehearsal (prod access goes through Secrets Manager).

**Cutover:** the migration rewrites `organizationId` across Mongo and PostgreSQL, so plan a short maintenance window, with workers and dispatcher paused so no jobs are written under the old org id mid-move, and a rehearsed `--rollback-run`.
