# Spec: Organization Accounts, Users, Teams and Permissions

> Status: ready for agent (not yet published to GitHub). Drafted 2026-10-29. Updated 2026-11-01 with DXG's decisions on the blocking questions (see `dxg-open-questions.html`). Companion documents: `ORGANIZATION_ACCOUNTS_PRD.md` (product requirements, open questions) and `ORGANIZATION_ACCOUNTS_TICKETS.md` (46-ticket breakdown). Terminology follows the workspace glossary. In code and here, an RFP is a **proposal**.

## Problem Statement

Event planners use RFPilot as individuals. A Director of Events can't see the proposals their planners build, can't take over a departing planner's work, and can't bring in colleagues or stakeholders with limited rights. Agencies and associations that want several seats have nothing to buy.

Underneath that, every customer account currently joins one shared default organization, and the legacy customer role expands to planner, organization admin and DXG producer rights. Customers are kept apart only by owner filters on individual queries, not by the tenant boundary that the AI domain already enforces with row-level security. A query that forgets the owner filter would expose another customer's proposals.

## Solution

Each customer becomes its own organization: the tenant that owns subscription, branding, proposals and vendor responses. People join an organization at one of five roles: Owner, Admin, Team Manager, Planner, Viewer. Teams group planners so a Team Manager sees their group's proposals without seeing the whole organization.

What each person sees comes from a single access policy enforced on the server. A planner sees their own proposals plus those shared with them. A Team Manager sees proposals on teams they manage. Admins and the Owner see everything in their organization. Nobody ever sees another organization's data.

Organizations grow through invitations and through access requests from colleagues on a verified email domain. Admins manage people from a Users and Teams area. When someone leaves, their proposals have to be reassigned before they're deactivated, so proposals are never lost or left without an owner.

DXG staff, as RFPilot Support, sit outside every organization and work only under time-limited access grants that the organization issues and can see in its audit log. Existing customers keep exactly the access they have today, in a private holding tenant, until a DXG admin places each of them in an organization.

Organizations start on a free trial that allows two proposals and locks vendor responses and proposal intelligence. Pricing is by proposals created, not by seats. Each organization can share proposal templates and a vendor list across its members.

## User Stories

**Organization signup and setup**
1. As a new customer, I want to create an organization when I sign up, so that my team's proposals live under one account from day one.
2. As a new customer, I want to sign up with email and password, Google, or Microsoft, so that I can use the identity my company already uses.
3. As a new customer, I want my email verified before I create an organization, so that nobody can create an organization in my name.
4. As a new customer, I want to enter my organization's name, type, industry, events per year, country and time zone, so that RFPilot defaults fit how we work.
5. As a new customer, I want to start on the free trial during signup, so that I can start without talking to sales.
6. As a new Owner, I want to invite my team during onboarding or skip it, so that setup doesn't block my first proposal.
7. As a new Owner, I want to land on a dashboard that walks me into building my first proposal, so that I get value immediately.
8. As a customer who abandons signup halfway, I want to resume where I left off when I sign back in, so that I don't repeat steps.

**Invitations**
9. As an Admin, I want to invite one person by email with a role and optional team, so that they arrive with the right access.
10. As an Admin, I want to paste a list of emails and invite them all at once, so that onboarding a department takes minutes.
11. As an Admin, I want a per-row result for a bulk invite, so that I know which addresses failed and why.
12. As an Admin, I want to resend an invitation, so that someone who lost the email can still join.
13. As an Admin, I want to revoke an invitation, so that a mistaken invite can't be used.
14. As an invitee, I want an invitation link that works for seven days, so that I have time to accept.
15. As an invitee, I want to accept with a password, Google or Microsoft, with my role and organization already set, so that I don't configure anything.
16. As an invitee who is already signed in with the invited email, I want accepting to be one click, so that joining is quick.
17. As an invitee, I want a clear message when my link has expired or been revoked, plus a way to ask for a new one, so that I'm not stuck.
18. As an Admin, I want an invite accepted only by the person whose email it was sent to, so that forwarded links can't grant access.
19. As a Team Manager, I want to invite people into teams I manage when my organization allows it, so that I can staff my team without waiting for an Admin.
20. As an Admin, I want to control whether Team Managers may invite, so that our organization decides who adds people.

**Domain-match access requests**
21. As someone signing up with a work email whose domain belongs to an organization already on RFPilot, I want to be offered "Request access", so that I join my colleagues and don't create a duplicate account.
22. As that person, I want to create a separate organization if that's actually right for me, so that I'm not forced into the wrong one.
23. As an Admin, I want to be notified of access requests and approve them with a role and team, or deny them, so that I control who joins.
24. As an Admin, I want to verify our email domain, so that only genuine colleagues are routed to us.
25. As an Admin, I want an option to auto-approve people from our verified domain, so that a large company doesn't wait on approvals.
26. As someone signing up with a public email provider, I want normal signup, so that I'm never matched to a stranger's organization.
27. As a member of an organization, I want our organization's name hidden from people whose domain we haven't verified, so that signup can't be used to discover our customers.

**Users and Teams management**
28. As an Admin, I want to see every member with name, email, role, teams, status and last login, so that I know who has access.
29. As an Admin, I want to filter and search members, so that I can find people in a large organization.
30. As an Admin, I want to change a member's role, so that access follows their job.
31. As an Admin, I want to move a member between teams or put them on several teams, so that the structure matches how we work.
32. As an Admin, I want to deactivate a member, so that someone who left can no longer sign in.
33. As an Admin, I want deactivation to take effect on the member's next request, not at token expiry, so that access is cut immediately.
34. As an Admin, I want to be required to reassign a departing planner's proposals before deactivating them, so that work is never lost or left without an owner.
35. As an Admin, I want to reassign all of a person's proposals at once or pick them individually, so that I can split their work between colleagues.
36. As an Admin, I want to reactivate a deactivated member, so that a returning colleague gets back in.
37. As an Admin, I want to create, rename and archive teams, so that teams reflect our departments.
38. As an Admin, I want to make someone Team Manager of a specific team, so that managers see only their own groups.
39. As an Owner, I want to transfer ownership to another member, so that the account survives my leaving.
40. As an Owner, I want to be prevented from deactivating myself while I'm the only Owner, so that the organization is never left without one.
41. As an Admin, I want conflicting simultaneous edits to a member to be refused rather than silently overwritten, so that two Admins don't undo each other's changes.

**Proposal ownership, teams and sharing**
42. As a Planner, I want my new proposals to land on my team automatically when I belong to exactly one team, so that my manager sees them without me doing anything.
43. As a Planner, I want to change which team a proposal belongs to, so that it's visible to the right manager.
44. As a Planner, I want to share a proposal with a colleague with view or edit rights, so that we can collaborate.
45. As a Planner, I want to see and revoke who a proposal is shared with, so that I control access to my work.
46. As a Team Manager, I want to share any of my team's proposals, so that I can bring in help.
47. As a Team Manager, I want to reassign a proposal between planners on my team, so that I can cover absences.
48. As an Admin, I want to reassign any proposal in the organization, so that I can rebalance work.
49. As a Viewer, I want to only ever receive view access, so that stakeholders can't change proposals by mistake. Viewers are read-only and there is no commenting.
50. As a member, I want vendor responses on a proposal visible to me exactly when the proposal is, so that access rules have no gaps.
51. As a Planner, I want to archive my own proposals, so that my dashboard stays focused.
52. As an Admin, I want deletion to remove a proposal's content everywhere it's stored, so that deleted means deleted.

**Visibility and isolation**
53. As any member, I want it to be impossible for me to see another organization's proposals, vendor responses, assistant conversations, evidence or exports, so that our data stays ours.
54. As any member, I want a proposal from another organization to look like it doesn't exist, so that its existence isn't revealed.
55. As a Planner, I want to see only proposals I own or that were shared with me, so that I focus on my work.
56. As a Team Manager, I want to see every proposal on teams I manage, so that I can oversee my group.
57. As an Admin or Owner, I want to see every proposal in the organization, including drafts, so that I can manage the whole portfolio.
57a. As a Planner, I want to be told that my organization's Admins can see my drafts, so that I'm not surprised.
58. As a Team Manager whose team is archived, I want to lose manager visibility of its proposals while Admins and the owners keep it, so that archiving doesn't hide work.
59. As a vendor, I want my experience to stay exactly as it is today through my submission link, so that nothing changes for me and I never see organization users or other vendors.

**Dashboards**
60. As a Planner, I want my proposals grouped by status (draft, sent, receiving responses, under review, awarded, archived), so that I see where everything stands.
61. As a Planner, I want upcoming response deadlines and new vendor submissions on my dashboard, so that I act on time.
62. As a Team Manager, I want a team view filterable by planner, so that I can see each person's workload.
63. As an Admin, I want an organization-wide list filterable by planner, team, status, event date and venue city, so that I can manage the portfolio.
64. As an Admin, I want a summary row of active proposals, responses received and proposals awarded this quarter, so that I see the organization at a glance.
65. As any member, I want dashboard counts to always match the lists below them, so that I can trust the numbers.
66. As a Viewer, I want a "Shared with me" view, so that I find what I've been asked to review.

**RFPilot Support access**
67. As an Admin, I want to grant RFPilot Support access to one proposal or the whole organization, so that I get help without sharing a login.
68. As an Admin, I want every grant to expire (seven days by default, thirty at most), so that access doesn't linger.
69. As an Admin, I want to revoke a grant at any time, so that I stay in control.
70. As an Admin, I want to see past and active grants with what Support looked at under each, so that support access is accountable.
71. As a Support agent, I want a list of organizations and proposals granted to me with time left, so that I work only where I'm allowed.
72. As a Support agent, I want a clear banner showing the scope of my current grant, so that I don't overstep.
73. As a Support agent, I want to keep answering helpdesk tickets without a grant but need one to open the proposal behind a ticket, so that customer content stays protected.
74. As an Admin, I want DXG staff never to appear as members of my organization, so that our member list is only our people.

**Security and audit**
75. As a member, I want to turn on two-factor authentication with an authenticator app and recovery codes, so that my account is protected.
76. As an Admin, I want to require two-factor for everyone in my organization, so that our vendor pricing is protected.
77. As a member in an organization that requires two-factor, I want to be taken to enrolment on my next sign-in, so that I can comply without being locked out.
78. As an Admin, I want to reset a member's two-factor when they lose their device, so that they can get back in.
79. As a member, I want my other sessions signed out when my role changes, I'm deactivated or my two-factor is reset, so that old sessions can't keep stale access.
80. As an Admin, I want an audit log of sign-ins, role and team changes, deactivations, invitations, ownership transfers, shares, support grants and support activity, so that I can answer "who did what".
81. As an Admin, I want to filter the audit log by person, action and date and export it, so that I can respond to compliance questions.

**Migration of existing customers**
82. As an existing customer, I want to sign in after the change and find all my proposals exactly as before, so that nothing is lost.
82a. As a DXG admin, I want to place an existing customer in an organization, either a new one where they become Owner or an existing one with a role and team, so that legacy customers join the organization model when it suits them.
82b. As a DXG admin, I want an existing customer's proposals, vendor responses and assistant history to move with them when I place them, so that their work arrives intact.
82c. As an Admin of the receiving organization, I want the placement recorded in our audit log, so that I know how the person and their proposals arrived.
83. As an existing customer, I want my vendor responses, assistant conversations, guidance and knowledge to come with me, so that the AI features keep working.
84. As the operator, I want to dry-run the migration and see per-customer counts before applying it, so that I can check it first.
85. As the operator, I want to roll the migration back by run id, so that a bad cutover is recoverable.
86. As the operator, I want a check that proves every customer sees exactly what they saw before, that nothing still points at the old shared organization, and that every proposal has an active owner, so that I can sign off the cutover.
87. As the operator, I want a nightly check for proposals whose owner is no longer active, so that orphans are caught.

**Plans and limits**
90. As a new organization, I want to start on a free trial that lets me create two proposals, so that I can try RFPilot before paying.
91. As a free-trial user, I want vendor responses and proposal intelligence to show as locked with a way to upgrade, so that I know what a paid plan adds.
92. As a free-trial user, I want a clear message when I reach the proposal limit, so that I know why I can't create another.
93. As a DXG admin, I want to change an organization's plan, so that customers can upgrade before online checkout exists.
94. As any member, I want invitations never refused for seat reasons, so that adding colleagues and stakeholders is free.

**Organization templates and vendor list**
95. As an Admin, I want to save a proposal as an organization template, so that planners start from our standard.
96. As a Planner, I want to start a new proposal from an organization template or one of my personal templates, so that I don't rebuild common content.
97. As a Planner, I want to save my own personal templates, so that I can reuse my own patterns.
98. As an Admin, I want to unpublish or archive an organization template, so that outdated templates stop being used.
99. As an Admin or Team Manager, I want to maintain one organization vendor list of companies and contacts, so that everyone sends to the right people.
100. As a Planner, I want to pick vendors from the organization list when sending a proposal, so that I don't retype contacts.

**Reporting readiness**
88. As a future reporting user, I want every proposal status change recorded with who made it and when, from launch, so that reports work retroactively.
89. As a future reporting user, I want vendor invited and responded counts recorded per proposal, so that response-rate reporting is possible.

## Implementation Decisions

**Tenancy**
- Every customer is its own organization. Signup creates the organization, the user and an Owner membership in one MongoDB transaction. The shared default organization is no longer assigned to anyone.
- The legacy role expansion that gives every customer planner, organization admin and DXG producer rights is removed. DXG staff remain only in the separate admins collection and hold no customer membership. Legacy DXG role values are readable on existing memberships for migration only and refused on new writes.
- Each user has exactly one active membership at launch. The membership model stays many-to-many (no uniqueness on user alone) so multi-organization users can come later. The session carries the active organization id. Code must never assume a user's single organization field is authoritative.

**Organization and membership model** (proposal content authority, MongoDB)
- Organization gains: type (corporate, association, agency, venue, government, other), industry, country, time zone, events per year, plan (free_trial at launch; paid plan values added when DXG defines them), billing status, proposals-created counter, verified domains, auto-approve-domain flag, require-two-factor flag, allow-manager-invites flag, kind (customer or legacy_holding).
- Membership roles become: owner, organization_admin, team_manager, planner, viewer. Exactly one active owner per organization, enforced by a partial unique index and by the ownership-transfer operation.
- New collections: Team (organization, name, archived), TeamMembership (team, user, is-manager; unique per team and user), Invitation (organization, email, role, team, invited-by, hashed single-use token, expires-at, status pending/accepted/revoked/expired), AccessRequest (organization, requester, status, decided-by), ProposalShare (proposal, user, permission view or edit, granted-by), SupportAccessGrant (organization, optional proposal, granted-by, support admin, expires-at, revoked-at), ProposalStatusTransition (proposal, from, to, actor, at; append-only), ProposalTemplate (organization, owner, scope personal or organization, title, content snapshot, presentation layout, published-by, archived), OrganizationVendor (organization, company, category, contacts with name and email, added-by, archived).
- Proposal gains an optional team id, indexed with organization. The existing owner user id stays the owner.
- Membership changes use the existing optimistic version field. A stale version is a deterministic conflict.

**Access policy (one deep module)**
- One access-policy module is the single authority for proposal visibility. It exposes two operations: a decision for an actor, a proposal and an action, and a list scope for an actor that list queries apply as a filter.
- Actions: view, edit, view responses, reassign, archive, delete, share, grant support.
- The actor is resolved once per request from the session: organization id, roles, managed team ids, and active-membership status. Shares are looked up as needed.
- Rules follow the source permissions matrix: Owner and Admin across the organization, drafts included (DXG decision Q6). Team Manager on proposals whose team they manage. Planner on proposals they own, or shared with them (edit only with an edit share). Viewer on view shares only. Vendor responses inherit the proposal's decision.
- A proposal in another organization is reported as not found. An in-organization proposal outside the actor's scope is forbidden. Authority is evaluated before optimistic-lock checks, matching existing workflow behaviour.
- The existing action-based organization policy stays for non-proposal capabilities (assistant use, knowledge, organization management). The new module adds the scope dimension it doesn't have.

**Repository scoping**
- Every MongoDB repository that reads or writes proposals or proposal-derived data (vendor submissions, versions, responses, drafts, canonical snapshots, notifications, public grants) takes the organization id from the authenticated session and includes it in the query, then applies the policy's list scope or decision.
- A CI guard fails on unscoped queries against these models.
- AI-domain tables keep forced row-level security keyed by organization. With per-customer organizations, the row-level security GUC now carries a real tenant boundary.

**Invitations and access requests**
- Invitation tokens are random, stored hashed, single-use and valid for seven days. Resend rotates the token.
- Accepting requires the authenticated email (password, Google or Microsoft) to equal the invited email. Role, organization and team come only from the invitation.
- An invitation is refused if the email already has an active membership in another organization.
- Domain matching uses verified domains only. A built-in list of public mail providers can never be verified. Verification is by DNS TXT token with a weekly re-check. The signup response doesn't reveal an organization unless the domain is verified.
- There are no seat limits (DXG decision Q2: pricing is by proposals created). Invitations and acceptances never check seats, and Viewers cost nothing.

**Plans and entitlements**
- One entitlements module answers, for an organization: can it create another proposal, and is a feature (vendor responses, proposal intelligence) unlocked. The plan table lives in code and configuration, so paid plans are a data change.
- Free trial: at most two proposals created per organization. The counter increments in the same transaction as proposal creation and never decrements, so deleting a proposal doesn't free a slot. Duplicating a proposal or starting one from a template counts as creating one.
- Vendor responses locked: vendors can still submit through their link, and submissions are stored. Planners can't open, compare or export responses until the organization upgrades. Response counts can show, so the planner sees there is something to unlock.
- Proposal intelligence locked: the proposal intelligence routes (evaluation, comparison, requirements, evidence extraction, vendor intelligence) refuse with a plan-required error, and the AI jobs behind them aren't queued for free organizations.
- Enforcement is on the server: proposal create, vendor-response reads and the intelligence actions call the entitlements module and return a distinct plan-required error. The dashboard shows locked states and an upgrade prompt from the same check.
- Legacy holding tenants are exempt until placed in an organization. DXG staff change an organization's plan from the admin app, and each change is audited.

**Organization templates and vendor list**
- A template is a snapshot of a proposal's content and presentation layout, without vendors, responses or dates. Starting from a template creates a normal proposal owned by the creator, and that counts toward the plan limit.
- Organization-scope templates are published, unpublished and archived by Owner and Admin. Every non-viewer member can use them. Planners keep personal-scope templates that only they see.
- The organization vendor list is edited by Owner, Admin and Team Manager. Anyone who can create proposals can pick from it when sending. Vendors stay external and never see the list.
- Both are organization-scoped like proposals, sit inside the tenant-isolation suite, and get audit events for publish, archive and vendor-list edits.
- The two existing presentation layouts stay as they are. A template records which one it uses.

**Offboarding**
- Deactivating a member who owns proposals is refused with a conflict that reports the count until those proposals are reassigned. Reassignment works on all of a person's proposals or a chosen list. The new owner must be an active non-viewer member. One audit event is written per proposal.
- Deactivation, role change and two-factor reset revoke the member's other refresh sessions. The per-request actor resolution refuses a non-active membership.

**Authentication additions**
- Microsoft sign-in is added as a multi-tenant OIDC provider beside Google, following the same verified-email linking rules. It also runs the existing sign-in hook that creates the AI-domain identity projection.
- TOTP two-factor: encrypted secret, ten hashed single-use recovery codes, a challenge after primary sign-in, rate-limited through the existing shared limiter. Organization-mandatory two-factor routes non-enrolled members to enrolment. Until the open question on SSO-asserted MFA is decided, SSO sign-ins are still challenged.

**RFPilot Support**
- Support works from the admin application under grants only. Admin-application routes that read customer proposal or vendor data require an active grant matching the signed-in support admin, and every use writes an audit event naming agent, grant and object. Helpdesk ticket content stays readable without a grant.
- Grant expiry defaults to seven days, with a thirty-day maximum. Owner and Admin can grant and revoke.

**Audit and status history**
- Organization-scoped audit events are written for: sign-in success and failure, two-factor changes, invitation sent/accepted/revoked, role and team changes, deactivation and reactivation, ownership transfer, proposal reassignment, share granted and revoked, support grant/use/revoke, and organization settings changes. They build on the existing security audit events and the AI domain's append-only audit chain.
- Every proposal status change writes an append-only status transition. Existing proposals get one transition at migration recording their status at cutover.

**Migration and placing existing customers** (DXG decision Q1)
- Existing customers are kept as they are rather than turned into Owners of new organizations. A DXG admin places them in organizations later.
- A dedicated migration command follows the existing migration-script conventions: dry-run by default, explicit run id, apply flag, rollback by run id, migration-journal entries, idempotent.
- For each existing customer it creates a legacy holding tenant: an organization of kind legacy_holding with a single Planner membership. It rewrites the organization id on every proposal-derived MongoDB record and every AI-domain tenant row, and strips DXG roles from customer memberships. This keeps the row-level-security boundary real while the user's experience stays unchanged: they see their own proposals and nothing else.
- A holding tenant has no organization settings, invitations, teams, sharing, templates or vendor list, and isn't shown to the user as an organization. Plan limits don't apply to it.
- Placing a customer is an admin-application operation for DXG staff. The target is either a new customer organization, where the person becomes Owner, or an existing one, where they get a chosen role (not Owner) and optional team. It moves the holding tenant's records into the target organization with the same rewrite the migration uses, in one journaled run that can be rolled back. Then it retires the holding tenant and writes audit events in both the target organization and the admin audit trail.
- Placing into an existing organization is refused if the person would then own proposals there as a Viewer. The target role must be able to own proposals.
- A separate verification command proves three things: per-customer visibility is identical before and after, no record still references the default organization, and every proposal has an active owner.
- Cutover runs in a maintenance window with the durable worker and dispatcher paused and the outbox drained.

**Dashboards**
- One scoped list endpoint (filters: status, owner, team, event date range, venue city) and one summary endpoint (active proposals, responses received, awarded this quarter). Both derive from the policy's list scope, so counts and lists can't disagree.
- The planner dashboard renders the Planner, Team Manager, Admin and Viewer variants from the same endpoints.

**Surfaces**
- Planner dashboard: signup steps, accept-invite page, Users and Teams settings, share and reassign controls on proposals, support grant management, audit view, role dashboards, locked-feature and upgrade states, template picker and template management, organization vendor list.
- Admin application: "granted to me" workspace, grant enforcement on its existing clients and proposals pages, placing legacy customers in organizations, and changing an organization's plan.

## Testing Decisions

**What a good test is here:** it drives the system the way a caller does and asserts outcomes a user or operator would notice: who can see or change what, what's refused and with which error class, what's recorded. It doesn't assert which repository method was called or how queries are built. Tests use real MongoDB and PostgreSQL wherever isolation is the claim being tested, because mocks can't prove isolation.

**Seam 1 (primary): real-infrastructure integration suite.** Organization use cases run against the Docker MongoDB and PostgreSQL stack:
- signup creates an isolated organization;
- invite → accept, including email mismatch, expiry, revocation and reuse;
- domain request → approve or deny;
- share and unshare, reassignment, deactivation with the reassignment requirement;
- scoped proposal list and detail for every role;
- support grant use, expiry and revocation;
- free-trial limits: the third proposal refused, vendor responses and intelligence refused with the plan-required error, and both unlocked after a plan change;
- placing a legacy customer into a new and into an existing organization, with rollback;
- organization templates and vendor list visible only inside their organization;
- audit events written for each audited action.

The isolation part extends the existing tenant-isolation test. Two organizations × every role hit every proposal, vendor-response, assistant, evidence and export use case, asserting no foreign data in bodies, counts or error messages. The suite also enumerates row-level-security tables from the catalog so new tables are covered automatically. Prior art: the existing tenant-isolation, platform-assistant tenant-isolation, proposal-workflow and identity-projection sign-in integration tests and their shared tenant-seeding helpers.

**Seam 2: the access policy as a pure module.** A table-driven test covers every cell of the permissions matrix: role × action × relationship (own, shared-view, shared-edit, team-managed, other team, other organization, archived team). It also includes a randomized agreement check that the list scope and the single-proposal decision never disagree. Prior art: the existing authorization-policy unit tests.

**Seam 3: the migration command as a child process.** It runs dry-run, apply, verify, rollback and verify on a seeded multi-customer fixture covering both stores, and asserts the reports and the post-rollback state. Prior art: the PostgreSQL migration command tests that spawn the migration script and the existing organization-membership migration's dry-run/apply/rollback contract.

**Also:** end-to-end planner dashboard checks per role for the settings and dashboard screens, and a lint guard against unscoped queries on proposal-derived models. Both are outside the three seams and kept thin.

## Out of Scope

- Organization reporting and analytics. Status history and vendor counts are captured, but no reports are built.
- SAML single sign-on and SCIM provisioning.
- Users belonging to more than one organization, and an organization switcher.
- Seat limits of any kind (pricing is by proposals created).
- Online checkout and billing integration. Paid plans are set by DXG staff in the admin app until DXG defines them.
- Commenting, for Viewers or anyone else (DXG decision Q3).
- External guest review links for people outside the organization (fast follow, DXG decision Q7).
- Automatically placing existing customers in organizations by email domain.
- Any change to the vendor submission experience or public grants.

## Further Notes

- **DXG decisions (2026-11-01):** Q1 existing customers kept as they are and placed in organizations later by a DXG admin; Q2 pricing by proposals created, free trial of two proposals with vendor responses and proposal intelligence locked; Q3 no commenting; Q4 templates and vendor lists shared across the organization at launch; Q5 keep in-house auth, add Microsoft OIDC and TOTP; Q6 Admins see drafts; Q7 Viewers are members only, guest links as a fast follow.
- **Follow-ups sent to DXG, built to these assumptions until answered:** the free limit is per organization (F1); deleting a proposal doesn't free a slot (F2); free users can send to vendors and responses unlock on upgrade (F3); limits don't apply to legacy holding tenants (F4); upgrades are manual through DXG staff (F5); Owner and Admin publish templates, and Owner, Admin and Team Manager edit the vendor list (F6).
- **Non-blocking:** domain verification beyond DNS TXT; whether SSO-asserted MFA satisfies mandatory two-factor; Team Manager scope over team-less proposals (assumed none); organization deletion retention; whether support access belongs in the data-processing addendum.
- **Protected boundaries this work must not weaken:** tenant isolation, private storage, malware scanning, human control of publication. The move to per-customer organizations makes the existing tenant row-level security mean something. It shouldn't be treated as a reason to relax repository-level checks.
- **Needs a decision record:** per-customer tenancy with legacy holding tenants, the scoped access policy, the support-grant model, the auth-provider choice, and plan entitlements by proposals created.
- **Bottom-up effort from the ticket breakdown:** about 32 engineer-weeks (range 24–39), up from 26 after DXG's decisions added plans, shared templates and vendor list, and placing existing customers.
