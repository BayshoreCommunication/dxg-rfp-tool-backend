# RFPilot AI — Project State & Handoff

**Last updated:** 2026-11-17 · **Branch:** `main` (`ai-agent` is merged) · **Status:** audit roadmap M1–M6 complete; governed proposal creation, Platform Assistant, structured vendor responses (v9) and the in-app helpdesk shipped; Organization Accounts milestones M1–M3 (tenancy, people, sign-in/SSO/2FA) merged; M4 and M5 are merged to `main` (2026-11-11); in the launch gate the rehearsal (local only), cutover runbook and launch metrics are merged, the docs ticket (ORG-504) is merged and the pen test (ORG-503) is open. The backend was released to production on 2026-11-11 (PR #131) and again on 2026-11-12 (PR #134, `744e81d`: helpdesk across organizations); four dashboard fixes shipped on 2026-11-12, including the wording change that makes "Proposal" the user-facing noun. Signed-in checks on production passed on 11, 12 and 16 Nov. The tenancy cutover has not been run, company single sign-on is untested on production, and ORG-503 is open. See "Organization accounts", "After the release" and "Before launch" below.

This is the single document to read before picking the project up. It records
what exists, why it is built the way it is, what is deliberately not done, and
what is owed to the client. Start with `docs/README.md`; the current system map
is `docs/ARCHITECTURE.md`, with component history under `docs/architecture/`.
This file remains the authority for current implementation status.

---

## 1. What the product is

RFPilot lets event planners create AV production RFPs, send them to vendors,
and review responses. The work in this repo is the **AI Intelligence Layer**
from the client SOW (`RFPilot-AI-Scope-of-Work.pdf`), whose four workstreams
are: a knowledge/pricing foundation, in-build recommendations, an investment
guidance engine, and vendor proposal analysis.

The intended experience — confirmed against a reference video from the client —
is a ChatGPT/Claude-style workspace: upload files or type details, get
requirements extracted, answer a few high-impact questions, receive a cited
draft plus readiness and investment guidance, then publish. Humans keep control
of publication.

### Three repositories

| Repo | Role | Stack |
|---|---|---|
| `dxg-rfp-tool-backend` | REST API, workers, all AI | Express, TypeScript, MongoDB + PostgreSQL(+pgvector) + Redis, S3 |
| `dxg-rfp-tool-dashboard` | Planner app | Next.js 16 App Router, NextAuth v5, Tailwind |
| `dxg-rfp-tool-admin` | Back office (clients, users, proposals read-only, support desk, AI operations; knowledge and pricing screens removed 2026-10-25) | Next.js 16 |

---

## 2. How to run it

```bash
# backend — three processes, all required for AI features
npm run dev            # API (nodemon)
npm run dev:worker     # durable job worker  (nodemon; prod uses worker:source-security)
npm run dev:dispatcher # outbox -> Redis     (nodemon; prod uses worker:dispatcher)

# dashboard / admin
npm run dev
```

Infrastructure: MongoDB, PostgreSQL 16 + pgvector, Redis, an S3-compatible
private bucket, and optionally ClamAV on `CLAMAV_HOST:3310`.

**Gotcha that cost real debugging time:** the API reloads on save, the workers
historically did not, so backend changes applied on some paths and not others.
Use the `dev:` variants. Production keeps the plain scripts because nodemon is
a devDependency (PM2 runs all three; see `docs/runbooks/PRODUCTION.md`).

### Feature flags

Everything AI is deny-by-default. `AI_ENVIRONMENT` (`test|staging|production`)
authorizes the runtime; unset falls back to the historical `NODE_ENV==="test"`
behaviour. On top of that: `CONVERSATIONS_ENABLED`, `PROPOSAL_CONTEXT_ENABLED`,
`PROPOSAL_DRAFT_ENABLED`, `CANDIDATE_APPLICATION_ENABLED`,
`PROPOSAL_WORKFLOW_ENABLED`, `KNOWLEDGE_*`, `GUIDANCE_ENABLED`,
`INVESTMENT_GUIDANCE_ENABLED`, `HISTORICAL_INSIGHTS_ENABLED`, `PRICING_CORPUS_ENABLED`,
`VENDOR_ANALYSIS_ENABLED`, `CONVERSATION_EXTRACTION_ENABLED`,
`ROOM_RECOMMENDATIONS_ENABLED`, `LIVE_AI_*` (+ kill switches). Dashboard
mirrors: `NEXT_PUBLIC_CONVERSATIONS_ENABLED`,
`NEXT_PUBLIC_PROPOSAL_WORKFLOW_ENABLED`, `NEXT_PUBLIC_VENDOR_ANALYSIS_ENABLED`,
`NEXT_PUBLIC_CONVERSATION_EXTRACTION_ENABLED`,
`NEXT_PUBLIC_ROOM_RECOMMENDATIONS_ENABLED`,
`NEXT_PUBLIC_AI_ASSISTANT_ENABLED`. Admin no longer has a pricing flag; its
pricing and knowledge screens were removed on 2026-10-25.

**`.env.local` overrides `.env`** (`config/env.ts` loads it second with
`override: true`). Reading only `.env` will tell you live AI is off when it is
on — that misread shaped a whole review cycle.

The Platform Assistant additionally requires `AI_ASSISTANT_ENABLED=true` and
an organization allowed by `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS`; production
fails closed when that cohort is absent or invalid. New messages additionally
require `AI_ASSISTANT_KILL_SWITCH=false`. Its runtime model remains the
approved baseline unless `AI_ASSISTANT_MODEL` is explicitly promoted.

Model is pinned to the dated snapshot `gpt-5.4-mini-2026-03-17`.

---

## 3. What was built (milestones M1–M6)

Delivered against an independent audit of the original codebase. Each milestone
was committed on `ai-agent`, which has since been merged into `main`.

- **M1 — Unblock & de-risk.** The whole governed AI surface was hard-gated to
  `NODE_ENV==="test"` and returned 503 in production, while the *ungoverned*
  legacy `gpt-4o` endpoint was the only live AI. Replaced with `AI_ENVIRONMENT`;
  governed the legacy endpoint; declared `openai` directly (it was resolving
  transitively through unused langchain packages); pinned the model snapshot;
  added the `ai_provider_attempts` billing ledger (pre-call row + idempotency
  fingerprint) to close a duplicate-charge window. Security: admin app no longer
  leaks its bearer token to the browser, CORS allowlist, Helmet, Redis-backed
  rate limits, fail-closed public grants, private+scanned vendor uploads,
  redacted public proposal payload, password/bcrypt hardening.
- **M2 — Conversational slice.** Migration 017: conversations, messages,
  attachments, clarification questions. Idempotent message endpoint, durable
  `conversation_chat` jobs with persisted placeholders, bounded dashboard
  polling (the backend SSE route remains for compatibility), pasted-notes
  intake through the same scan boundary, and the first workspace UI.
- **M3 — Full-schema application.** The candidate whitelist went from **4 paths
  to 112**, generated against the canonical contract with typed normalizers;
  `extractionPathEnum` feeds the model's structured output so it can only
  propose fields a reviewer can apply. Migration 018 added draft section
  decisions and scoped regeneration.
- **M4 — Knowledge & guidance.** Real OpenAI embeddings behind a release
  registry (migration 019), open governed retrieval, knowledge fragments cited
  in drafts as `/knowledge/...`, and a deterministic guidance engine
  (completeness + ~12 rules) that unlocked workflow step 4.
- **M5 — Pricing & vendor analysis.** Migration 020: pricing records and expert
  rules with an approval workflow; a deterministic investment engine with
  provenance and explicit refusals; a vendor-response analysis durable job
  producing cited findings with human-escalation flags.
- **Proposal Intelligence Task 3 — requirement registry (2026-08-12).** Migration 045 and the `requirementRegistry` module add tenant-isolated, idempotent requirement/evaluation versions derived from the complete safe proposal surface and accepted rendered narrative. Planner review is optimistic-lock protected; approval requires confirmed 100% weights and explicit mandatory/criterion/verification review. Approved rows are database-immutable, proposal version/checksum changes surface as stale, and supersession creates a linked new draft. The dashboard route is `/proposals/:id/intelligence/requirements`. Task 4 evidence extraction remains unstarted and requires confirmation.
- **M6 — Hardening.** A real docker-compose integration suite (25 tests against
  live Postgres/Redis/Mongo), the gold evaluation harness as a release gate,
  cross-store purge propagation, `/api/v1/ai/usage-report`, PM2 config for all
  three processes, the production runbook, and an admin AI Operations page for
  runtime readiness, provider-attempt outcomes, token usage, and gateway runs.

### Proposal Intelligence foundation (Task 2, 2026-08-12)

Vendor responses now have a stable `VendorSubmission` identity and immutable
`VendorSubmissionVersion` records. Every initial, revised, clarification, BAFO,
or administrative version receives a parent pointer, monotonic version number,
idempotency key, source manifest, SHA-256 checksum, and receipt metadata. The
legacy `VendorResponse` remains a latest-version compatibility projection so
the current inbox and vendor-analysis behavior continue during migration.

New files retain private storage and fail-closed malware scanning, and are
registered idempotently as `vendor_submission` sources in PostgreSQL when the
data foundation is available. Migration 044 adds version/source linkage without
attributing a public upload to a planner. The dry-run-first
`backfillVendorSubmissionVersions.ts` projects legacy responses to version 1,
reconciles eligible sources, and journals checksummed outcomes. Comparison,
requirement mapping, extraction, evaluator scoring, and decision UX remain later
explicitly approved tasks.

### Vendor response questionnaire publication (Task 2, 2026-09-14)

The vendor response workspace now starts from an immutable, tenant-scoped
questionnaire version rather than exposing the proposal document directly. A
deterministic canonical-proposal projection retains the vendor-safe event,
venue, deadline, currency, room, and specification context; every room and
specification receives a stable identifier and exact proposal source reference.
Publishing unchanged source data is idempotent. A changed projection creates
version `n + 1`, records its actor and checksums, and supersedes the prior
published version without mutating it.

`GET /api/vendor-responses/workspace` validates the scoped public grant and
returns only the allowlisted workspace contract. It never includes raw access
tokens, organization or owner identifiers, private upload URLs, internal flags,
or unrelated proposal fields. Access state is derived from the published/open
lifecycle and deadline; revoked, expired, or otherwise invalid grants fail in
the public-access boundary before the workspace service runs. Authenticated
proposal owners can explicitly publish through `POST
/api/vendor-responses/questionnaires/publish`.

### Vendor response draft lifecycle (Task 3, 2026-09-14)

Structured vendor responses now have one active MongoDB draft per tenant,
proposal, and durable invitation ID. Drafts pin the exact questionnaire
snapshot and grant-subject hash, accept contract-shaped partial responses, and
use `draftRevision` compare-and-swap for every response or document mutation.
The public DTO exposes only the response and safe document metadata; raw grants,
private URLs, object keys, and payload values are excluded from telemetry.

Categorized uploads are authorized before multipart intake, then validated
against the pinned questionnaire for purpose, response scope, filename
extension, detected content type, size, category count, and global count. Files
must pass the existing fail-closed malware boundary before entering private
storage. Successful and failed requests remove local temporary files, and stale
write failures remove newly uploaded orphan objects. Retirement and the daily
expiry/abandonment cleanup check immutable submission versions before deleting
objects, retaining submitted evidence and retrying provider failures. Task 4,
documented below, adds final validation, calculation snapshots, immutable
structured versions, and revision-draft inheritance.

### Vendor response structured finalization (Task 4, 2026-09-14)

An active draft can now be finalized through a grant-scoped, revision-aware
transaction. The server checks the live proposal lifecycle, validates the
complete response against the draft's immutable questionnaire, verifies that
response document references exactly match active stored documents, supplies
acknowledgement timestamps, and freezes a reproducible
`vendor-response-calculation.v1` snapshot. `VendorSubmissionVersion` stores the
questionnaire and response snapshots, calculation, structured document
metadata, retired-document provenance, and an expanded manifest checksum while
its existing update guards continue to reject mutation.

Finalization uses a draft claim and a unique `finalizedDraftId`, so concurrent
or repeated requests converge on one version and the original safe receipt.
After persistence, the legacy `VendorResponse` projection, PostgreSQL source
registration, first-version planner notification, and vendor confirmation keep
their existing behavior. Revision drafts can be created only for a current
structured submission associated with the same public grant. They seed the
previous immutable questionnaire, response, and document manifest, explicitly
distinguishing inherited and added documents and recording retired inherited
documents without deleting submitted storage objects. The planner rendering of
these structured fields remains Task 7; the vendor workspace UI begins in Task
5.

### Planner-entered vendor responses (2026-08-25)

Not every vendor replies through the portal. `POST
/api/vendor-responses/manual` lets a planner record a response that arrived by
email, courier, or in person. It reuses the portal use case, so the response
joins the same `VendorSubmission` chain, gets the same immutable version,
manifest checksum, private storage, fail-closed malware scan, and idempotency
key — only the attribution and the notifications differ: the version is stamped
`sourceSystem: "planner_upload"`, and neither the planner notification nor the
vendor confirmation email is sent (the vendor submitted nothing, so a receipt to
them would be false). The route requires the new `vendor-response:write` action
and ownership of the proposal, checked against the same `ownerUserId` the
dashboard reads are scoped to. The dashboard exposes it as "Add response
manually" on a proposal's responses page; reusing a vendor's email adds the next
version to that vendor's existing response rather than creating a second one.

### Vendor-response deletion (2026-09-10)

Planners can permanently delete one vendor response or an explicit selection
of 1–100 responses from a proposal's response list. There is no global
delete-all operation. The protected delete routes require
`vendor-response:write` and repeat tenant plus proposal-owner scoping in the
repository. Selected deletion fails closed before purging anything if any
requested response is unavailable. Deletion removes the Mongo compatibility
response, submission, and immutable version chain; private objects are removed
from storage and registered document sources are tombstoned. Governed analysis
and audit records remain subject to their existing retention policy. The
dashboard requires a destructive confirmation before invoking either the
single or selected operation and refreshes counts and lists after success. The
proposal-summary read exposes the exact owned response IDs for each paginated
group, allowing the main inbox to select proposal groups without restoring a
global delete-all operation.

### The DXG pricing engine (client workbook)

The founder supplied `RFPilot_AV_Pricing_Engine` (baseline v3): 433 line items
across 10 categories, 22 regional factors, 13 modifiers, 13 confidence rules.

- **Imported** via `npx ts-node scripts/importPricingWorkbook.ts <workbook.xlsx>`
  (idempotent on category+subcategory+item label). Migration 022 added
  subcategory/spec/unit_label/quantity_dimension/calibration_tier plus the
  factor tables. **The workbook is deliberately NOT in git** — DXG proprietary
  data per SOW §10; the operator supplies the path.
- **The investment engine was rebuilt on his model**: package templates select
  the median-priced approved record per component (it previously summed an
  entire category, which was harmless with 18 demo rows and nonsense with 149
  audio SKUs), then applies `base × regional × multi-day(equipment) ×
  union(labor) × in-house(equipment) + service charge(subtotal)`.
- **Acceptance:** reproduces his own worked example (13 Chicago breakouts) at
  **$54,060 against his $54,366 — 0.56%**. That is the strongest acceptance
  evidence the project has; lead with it.

### Room specification recommendations (added 2026-07-27; auto-apply same day)

Conversation messages may carry a bounded `actions` array. Migration 032 adds
the persisted allowlist for downloading the room schedule template and opening
Room Specifications; room-schedule intent has a deterministic fallback so the
guidance remains available when the live model is disabled. Proactive guidance
appears once after the initial guided questions are answered or skipped, not in
the opening assistant turn. An explicit room-schedule request still receives
the actions immediately, and the persisted action guard prevents duplication.

When live chat is unavailable, the deterministic first turn welcomes the
planner and points to the guided intake; later turns acknowledge conversation
context. These fallbacks do not claim that chat text was saved or applied to
proposal fields.

The guided intake includes Event Type among its first eight questions and uses
the same closed choice list as the advanced proposal editor.

Location intake asks city before state. A validated US city answer can fill an
empty state and the editor-compatible time-zone label in the same guarded
Mongo update. Explicit `City, ST` or `City, State` answers are supported;
ambiguous or unknown bare city names are not guessed and leave the state
follow-up open. Existing state or time-zone values are not overwritten.

**Policy note for DXG:** originally built review-first; changed the same day
by product decision to **apply automatically into empty room fields** (the
planner adjusts values in the form; filled fields are never overwritten and
are reported as skipped), including `recommended_assumption` values below the
0.8 automatic-confidence bar. As of 2026-07-29 this is the platform's **only**
unattended application path: extracted field candidates now require explicit
review, so this no longer extends a shared boundary — it is the single
exception to one, which is what DXG needs told. Engine is `room-rules.v3`; v3 evaluates every function in a
physical room, sizes shared AV guidance from peak function attendance, and
validates each function schedule independently. Migration 031 added
automatic/skipped columns. The paragraph below otherwise stands, with crew
roles now applied as append-only `$addToSet` writes and manual review/apply
endpoints retained.

Originally: a review-first, deterministic room recommendation capability behind
`ROOM_RECOMMENDATIONS_ENABLED`. The dashboard Smart Fill surface and its
`NEXT_PUBLIC_ROOM_RECOMMENDATIONS_ENABLED` flag were removed on 2026-09-07;
the backend endpoints and governed audit history remain available but are no
longer exposed by the planner dashboard. Confirmed room/event facts plus approved synthetic
knowledge fixtures produce a strictly validated `room-recommendation.v1`
payload (migration 030) in which every value is classified
(`deterministic_derivation` / `recommended_assumption` / questions for
`unknown`), everything is review-gated, and explicit application is limited to
a three-field wireless-microphone allowlist with proposal-version CAS **and a
per-room identity guard** (ordinary wizard saves do not bump the proposal
version, so apply re-checks each room's `roomFunction` label). Reviewer
decisions persist with the schema's first enumerated reason-code vocabulary as
governed evaluation data. Crew suggestions mirror the wizard's auto-suggest
and are review-only. Extraction is unchanged — `rooms[]` remains excluded from
the scalar candidate whitelist. Details:
`docs/architecture/ROOM_RECOMMENDATIONS.md`. Deferred: crew/array application,
production knowledge adapter, workflow-facts integration, integration-suite
coverage for the new tables, and any AI enrichment stage (fine-tuning
explicitly out of scope until enough producer-reviewed outcomes exist).

### The conversational workspace

Lives at **`/proposals/{id}/assistant`** (one surface, one implementation).
`add-new-proposal` is the "start something new" entry and redirects there once
a proposal exists. The editor keeps its stepper and review panels and links to
the assistant.

Flow: type or attach → sources scan → extraction auto-runs → normalized,
non-conflicting defaults fill empty guided fields automatically and stay visible
with field-level Edit → guided questions ask only for missing or unclear details
with typed controls (date picker, time, choice pills, number) → progress card with
real completeness → generate cited draft → readiness and investment guidance.

Proposal-source extraction now packages PDF, DOCX, XLSX, CSV, and TXT evidence
with source-fair selection, table-header context, exact fragment checksums, and
opaque citations. The governed model remains the primary semantic extractor and
receives value guidance for every scalar path. A single optional batched recovery
call targets only high-value paths whose concepts appear in evidence but remain
absent. Dates, attendance, and event format receive conservative field-aware
normalization; recording or remote presenters alone never imply Hybrid.
Candidates are canonical-normalized and deduplicated before persistence, while
genuine disagreements remain separate and create blocking conflicts. In the
assistant workspace, usable defaults are applied only to empty fields and remain
editable; publication and vendor delivery remain explicitly human-controlled.

### The Platform AI Assistant

The dashboard sidebar now exposes a compact helper popup for onboarding,
navigation, proposal workflow, and event-planning guidance. It is a separate
bounded module from proposal conversations and is read-only.

PostgreSQL owns personal threads/messages with organization RLS plus explicit
owner predicates. Approved `operating_guidance` is accessed behind an
Assistant-owned knowledge port, with versioned platform facts as a safe
fallback. OpenAI streaming stays behind a provider port and emits only
versioned product SSE through a same-origin dashboard BFF. Attempts are
recorded before provider calls; user and organization rate/concurrency limits
are enforced through Redis with a bounded fallback.

The baseline/candidate evaluation and live staging comparison are complete.
The runtime baseline remains `gpt-5.4-mini-2026-03-17`; promoting the evaluated
candidate still requires an explicit Product Owner decision. Production
internal/cohort rollout also remains blocked until an organization-scoped
entitlement or deployment allowlist exists.

### In-app helpdesk / support inbox (2026-10-18; on `main`, production email alerts on since 2026-10-26)

Client request from the 2026-10-15 review: a support channel inside the
product, handled by DXG from the admin app. The AI Assistant is untouched.
Plan and scope: `../rfpilot-chatbot-support-plan.md` ("Scope change").

Backend `src/modules/supportDesk/` (domain + customer/agent application
services + Mongo repository + notifier), models `modal/supportTicketModel.ts`
(with a per-organization ticket counter), `supportMessageModel.ts`,
`supportCannedReplyModel.ts`; routes `routes/supportDeskRoute.ts` mounted at
`/api/v1`. Planner: create/list/get/reply/resolve/unread-count. Agent
(admin roles): inbox with filters and pagination, ticket detail with requester
card, reply (default status waiting-on-customer, auto-assign, first-response
stamp), internal notes, assign/priority/category/status with a system-message
audit trail, metrics, agent list, canned replies CRUD. Customer replies reopen
resolved/closed tickets. Notification type `support_ticket` added;
`SUPPORT_DESK_EMAIL_NOTIFICATIONS`, `SUPPORT_DESK_NOTIFY_EMAIL`,
`ADMIN_FRONTEND_URL` in `.env.example`. Attachments: `POST /support/attachments`
and `POST /admin/support/attachments` take multipart `files` (PNG/JPEG/GIF/WebP/
PDF, 10 MB, 3 per message), run the same ClamAV fail-closed scan as vendor
uploads, store the object privately with its MIME type, and record a `pending`
`SupportAttachment` owned by the uploader; a message cites upload ids and the
server claims them (same organization, same uploader, unused) before binding
them to the message. Downloads go through
`GET …/tickets/:ticketId/attachments/:attachmentId`, which authorizes the
ticket (and hides internal-note attachments from customers) and returns a
5-minute presigned URL; both web apps proxy that through a same-origin route
that redirects.

Admin app: sidebar **Support**, `/support` inbox (metrics, filters, unread
dot), `/support/[ticketId]` workspace (thread, reply/internal-note composer,
canned-reply insert, triage sidebar), `/support/canned-replies`; support
metrics also on the admin dashboard. Dashboard: sidebar **Support** with
unread badge, `/support` list + new-request form, `/support/[ticketId]`
thread with reply and "This is solved"; `support_ticket` notifications link to
the ticket; Help page lists Support.

Follow-ups shipped 2026-10-19 → 10-27: ticket assignment with a collision
guard, response targets and auto-close, automatic acknowledgement, a 3-day
reopen window after resolve, one "DXG support" display name, triage activity
kept internal to agents, and real-time admin alerts for new tickets.

**Cross-organization fix (2026-11-12, branch `fix/helpdesk-cross-organization`).**
Found on production the same day: a customer Owner's ticket in their own
organization was created and acknowledged but never reached RFPilot staff,
because every agent operation was bounded to the agent's organization and
sign-up now gives each customer their own (ORG-106). No agent was assigned and
no bell or real-time alert fired either, since both looked for admins inside
the ticket's organization; only the alert email to `SUPPORT_DESK_NOTIFY_EMAIL`
was not scoped that way. RFPilot staff (`admins` accounts with a staff role)
now work every organization's tickets through `agentScopeFor`; customers are
unchanged; the proposals behind a ticket still need a grant from the ticket's
organization. Agent list and detail responses carry the ticket's
`organization`, the inbox can be narrowed to one organization and searched by
organization name, and ticket numbers stay per organization. Decision:
`DECISIONS.md` 2026-11-12; API: `API.md` "Helpdesk (support tickets)". Tests:
`tests/support-desk-cross-organization.test.js`,
`tests/support-desk-notifier.test.js`,
`tests-integration/support-desk-cross-organization.test.ts`. The admin app shows
the organization on each ticket (admin branch of the same name). It reaches
customers when `main` is merged into `production`. Not done: tickets opened
before the release in a customer's organization have no owner until an agent
replies or assigns them, and nobody was alerted about them; staff should look
through the inbox once after the release.

### Organization accounts (2026-11-01 → 2026-11-11)

Spec, PRD and 46-ticket breakdown: `docs/specs/ORGANIZATION_ACCOUNTS_*.md`;
DXG's decisions on the blocking questions: `docs/specs/dxg-open-questions.html`.
Decisions taken during delivery are in `DECISIONS.md`: per-customer tenancy with
legacy holding tenants, the scoped access policy and the auth-provider choice
(recorded 2026-11-11), and dated rows for ORG-110, 203/204, 303–307, 403, 404,
407, 505, 601, 603, 604 and 606. Work shipped directly on `main` without the
`ORG_ACCOUNTS_ENABLED` flag the original 4-week plan proposed.

**Where it stands (2026-11-11, about 16:30 BDT; from the pull-request lists of the
three repositories):** 45 of 46 tickets are closed, meaning every PR for the ticket
is merged to `main`. ORG-504 (these docs) merged as #130. ORG-503 is open. The
backend was released to production the same day (see "Before launch").
The commitment of 2026-11-09 was every milestone by Thursday 12 Nov 2026, 16:00
BDT; the fixed merge windows were dropped on 11 Nov to finish early. Per-ticket
state is in the ticket breakdown.

"Merged to `main`" is not "live". See "Before launch" below for what is deployed
and what is still owed.

| Milestone | Tickets | State |
|---|---|---|
| M1 Tenancy foundation | ORG-101 … 110 | Closed (merged). Scoped access policy, repository sweep with a CI guard, RLS alignment, signup creates an organization, legacy holding tenants + verification and nightly orphan check, cross-tenant isolation suite, legacy-customer placement with journaled rollback. |
| M2 People | ORG-201 … 210 | Closed (merged). Teams, RFP team assignment, invitations (capped, team-aware, Google accept) and emails, accept-invite page, membership APIs, offboarding reassignment, RFP sharing, Users/Teams settings and the RFP access panel (share, team, reassign owner). |
| M3 Entry paths and auth | ORG-301 … 307 | Closed (merged). Sign-up with organization onboarding, Google + Microsoft + company OIDC SSO (email-first discovery, Require SSO), TOTP 2FA and org-mandatory 2FA with admin reset, DNS TXT domain verification, domain-match access requests (2026-11-08), session hardening on membership changes. |
| M4 Experience | ORG-401 … 407 | Closed (merged to `main`, 2026-11-10 and 2026-11-11). ORG-403 (PR #117, merged 2026-11-10): derived, stored lifecycle stage (draft, sent, receiving responses, under review, awarded, archived), append-only transitions, "Mark as awarded" plus comparison-selection awards (DECISIONS 2026-11-09), status-history endpoint, backfill. ORG-401 (PR #119, 2026-11-10): scoped dashboard list and summary with stage, owner, team, event-date and venue-city filters; summary property-tested against the list; p95 ≤ 136 ms on 5k RFPs. ORG-404 (PR #123, 2026-11-10): Owner/Admin grant, list and revoke RFPilot Support access per RFP or organization (7-day default, 30-day cap); grant-gated admin routes for RFPs, vendor responses and the RFPs behind a helpdesk ticket; every read audited in the customer's organization (DECISIONS 2026-11-10). ORG-402 (dashboard PR #73, 2026-11-10): role dashboards for Planner, Team Manager, Admin/Owner and Viewer. ORG-405 (dashboard PR #75, 2026-11-11): support access grants screen for Owners and Admins. ORG-406 (admin PR #14, 2026-11-11): "Support access" workspace in the admin app, where RFPs and vendor responses are reachable only through a grant; the old Proposals pages redirect to it. ORG-407 (backend PR #127 and dashboard PR #78, 2026-11-11): Owner/Admin audit log at `/settings/audit`, read over `SecurityAuditEvent` with user, action, category and date filters, CSV export, an allowlisted action catalog, and failed sign-ins audited as `auth.login.failed` (DECISIONS 2026-11-11). |
| M5 Plans and shared resources | ORG-601 … 607 | Closed (merged to `main`, 2026-11-10 and 2026-11-11). ORG-606 (PR #121) and ORG-601 (PR #122) merged 2026-11-10: organization vendor list backend, and plan entitlements with the free-trial limit. Merged 2026-11-11: ORG-603 (backend PR #124, admin PR #13: staff view and change an organization's plan from the admin app's Organizations page), ORG-604 (PR #125: RFP templates backend), ORG-605 (dashboard PR #77: save as template, picker, Settings → Templates) and ORG-607 (dashboard PR #74: vendor list settings page and picking vendors when sending). ORG-602 (dashboard PR #76, 2026-11-11): RFP counter, a message on the create button at the limit, and locked states with a "Contact us" prompt on the vendor-response and RFP-intelligence screens; the backend enforces the plan either way. Also, DXG's pricing corpus, expert rules and knowledge are shared with every organization (2026-11-01). |
| Launch gate | ORG-501 … 505 | 4 of 5 closed. Merged 2026-11-11: ORG-505 (PR #126: the five PRD success metrics as counts and rates for DXG staff at `GET /api/v1/admin/launch-metrics` and `npm run report:launch-metrics`, plus a first-RFP-opened stamp on the membership; no admin-app screen), ORG-501 (PR #128: rehearsal on a seeded fixture in local Docker only; the production-snapshot rehearsal is still owed, see "Tenancy migration rehearsal") and ORG-502 (PR #129: `docs/runbooks/ORG_TENANCY_CUTOVER.md`, written from the local rehearsal). ORG-504 (PR #130: these docs) merged 2026-11-11. **Open, ORG-503 (external pen test):** it closes on an internal security review plus a booked external test date; neither has happened yet. |

Operational notes:

- Plan entitlements (ORG-601, merged to `main` 2026-11-10, not yet in
  `production`): every organization is on `free_trial` (2 RFPs created, vendor
  responses and RFP intelligence locked) unless its `plan` is `full_access`;
  legacy holding tenants are exempt. ORG-603 (merged 2026-11-11) gives RFPilot
  staff the supported way to change it: the admin app's Organizations page,
  backed by `/api/v1/admin/organization-plans` (staff only, each change audited
  in the customer's organization; DECISIONS 2026-11-10). Right after the deploy
  that carries ORG-601, a staff admin sets DXG's own organization and any
  customer DXG wants unlocked to `full_access`, or they lose vendor responses
  and RFP intelligence.
- Production now requires `OTP_PEPPER`, `TWO_FACTOR_ENCRYPTION_KEY` and
  `SSO_SECRET_KEY` (see `.env.example` and `docs/SSO_SETUP.md`); the API fails
  at startup without the pepper. The AWS deploy passes the 2FA and SSO keys to
  the API and cron tasks.
- Accounts not yet placed in an organization cannot sign in by any method and
  see `ORGANIZATION_SETUP_REQUIRED`; place them with the ORG-110 script.
- Placement from the admin API on production (decision 2026-11-17): the backend
  and infrastructure half is done. The API validates and journals the request and
  starts a Step Functions state machine, which runs the placement in its own task;
  the run is reported at `GET /api/admin/legacy-customers/placements/:runId`. The
  API still never holds the Postgres migration role and cannot start ECS tasks.
  Not yet deployed, and never exercised on production: no execution or task has
  been started and the new IAM statements are untested there. The admin app
  screen that calls it is a separate ticket, still pending; until then operators
  place by hand as before.
- A user who still owns RFPs cannot be deleted; reassign first.
- `scripts/purgeTestAccounts` removes test sign-ups (2026-11-08).
- M5, ORG-606 (2026-11-10): the organization vendor list backend is merged: `OrganizationVendor` in Mongo and `/api/v1/vendor-list` (list, search, categories, add, edit, archive, restore) with audit events; Owner, Admin and Team Manager edit, Planners read, Viewers have no access; covered by the cross-tenant isolation suite. The settings page and the picker when sending an RFP are ORG-607 (merged 2026-11-11).
- M5, ORG-604 (merged 2026-11-11): the RFP templates backend: `ProposalTemplate` in Mongo and `/api/v1/proposal-templates` (list, open, save from an RFP, rename, publish, unpublish, archive, restore, start an RFP) with audit events; personal templates are private to their owner, Owners and Admins manage organization templates, Viewers have no access; starting an RFP from a template counts toward the plan limit and lands on the creator's team; covered by the cross-tenant isolation suite. The picker and the management list are ORG-605 (merged 2026-11-11).

### Tenancy migration rehearsal (ORG-501, 2026-11-11)

Rehearsed **locally only**, on a generated legacy-shaped fixture in an isolated Docker stack
(`deploy/rehearsal`, `npm run rehearsal:*`), by the owner's decision of 2026-11-10 because no
production or staging copy was available. Results, timings, findings and the step list are in
`docs/runbooks/ORG_TENANCY_REHEARSAL.md`.

- Rehearsed: dry run → apply → verify → rollback → verify → apply again → verify → idempotent
  re-run, at two fixture sizes, as the table-owner role production uses.
- **Pending: the rehearsal on a restored production snapshot, on cutover day before the real
  run.** Production data, production scale, pausing the worker and dispatcher and draining the
  outbox have not been rehearsed.
- Two defects found and fixed with tests: the verifier's Postgres leftover check passed without
  reading a row when run as the production migration role, and rollback left a previously
  suspended membership active.
- Open for ORG-502 and the owner: the migration alters every tenant table once per customer
  (dry run included), so it cannot share the database with a serving API, and a suspended
  customer becomes an active Planner in their holding tenant.

### Tenancy cutover runbook (ORG-502, 2026-11-11)

`docs/runbooks/ORG_TENANCY_CUTOVER.md` is the maintenance-window procedure and rollback for the
ORG-107 migration. It is written from the local rehearsal only: seven steps are marked for the
operator to confirm against the production deployment, and the snapshot rehearsal it requires
as a go/no-go has not been run.

### After the release: fixes and production checks (2026-11-12 → 2026-11-16)

**Shipped on 2026-11-12**

- Dashboard #79: "Proposal" replaces "RFP" as the user-facing noun across the
  dashboard. The product name RFPilot, code identifiers, routes and API fields are
  unchanged. `lib/wording.test.ts` fails the build on a user-visible standalone
  "RFP"; the rule is in the dashboard `CLAUDE.md`. Deliberately kept: the one
  sentence that defines the term, "Request for Proposal" on the rendered document
  cover and in sign-in metadata, and the wordmark.
- Dashboard #80: a proposal's title opens the edit page (the preview for Viewers);
  Edit is no longer shown to Viewers; Settings → Users has a "What each role can
  do" guide built from the backend's permission code
  (`components/organization/members/roleAccess.ts`).
- Dashboard #81: the dashboard list keeps filters, sort and page in the URL and
  filters server-side; filters popover with chips; sortable headers for Proposal,
  Event date and Updated (the only fields the backend sorts by); one date-range
  field; row menu (Edit, Preview, Duplicate, Archive); status badges; page size 10.
  `Badge`, `FilterChip`, `DataTable`, `DateRangePicker` and `Dropdown` are in
  `components/ui/`; the last two are adapted from Untitled UI and add
  `react-aria-components` and `@internationalized/date`.
- Backend #133, admin #15, release #134: the helpdesk across organizations (see
  "In-app helpdesk / support inbox"). The same release carried the vendor autosave
  rate-limit fix, whose own deploy had failed at the image vulnerability scan
  earlier that day, and the mongoose bump that clears the scan.

**Checked on production while signed in**

- 2026-11-11, as the Owner of "Bayshore Communication": dashboard home; vendor
  responses locked on the free trial and open after the plan was set to Full
  access, with no sign-out; the Security page links to the audit log and Support
  access; the audit log and its user filter; templates end to end (save as
  personal, start a proposal from it, dates dropped, archive); admin Support
  access with no grant, an organization-scope grant, the customer's activity view
  naming only "RFPilot Support", and a grant revoked mid-session.
- 2026-11-12: a ticket opened by a customer organization appears in the admin
  inbox with its organization, opens, and a staff reply reaches the customer.
- 2026-11-16: a Google Workspace account (`dxg.agency`) signed in with "Continue
  with Google", completed onboarding as the Owner of a new organization, and the
  dashboard, Users, Security and audit log pages loaded correctly.

**Not checked on production:** any role other than Owner; an RFP-scope support
grant; publishing organization templates; the audit CSV export; Duplicate and
Archive from the new dashboard row menu; the role guide on a phone; company single
sign-on (blocked: nobody available could publish the DNS TXT record for
`dxg.agency`); a second user joining by domain match; a legacy customer in the
shared organization.

**Test data left on production**

- Organization "DXG Workspace QA" (free trial), Owner on a `dxg.agency` address,
  with `dxg.agency` added as a pending, unverified domain. A pending domain routes
  nobody. There is no organization delete in the customer app.
- In "Bayshore Communication": two draft proposals named "Northstar Leadership
  Summit 2027", one archived template "QA check 11 Nov", one revoked support
  grant, and support ticket #3 "QA check 12 Nov: test ticket, please ignore" with
  one staff test reply. Tickets #1 and #2 in that organization are real requests
  that were invisible to staff before 2026-11-12.

**Wording rule (changed 2026-11-12):** the user-facing noun is "Proposal". The
earlier rule, "UI copy says RFP", is withdrawn. Text the backend writes is converted
(2026-11-16, guarded by `tests/proposal-wording-guard.test.js`) except AI prompts and
knowledge text and rows already stored; the admin app is converted separately (see
follow-ups).

### Before launch: Organization accounts (2026-11-11, updated 2026-11-16)

What has to happen before external organizations are invited. Each line was
checked against the code, the docs or the pull requests on 2026-11-11; where it
could not be, it says so.

**What is deployed (checked 2026-11-11, about 16:10 BDT)**

- Backend: released to production on 2026-11-11 by merging `main` into
  `production` (PR #131, `8420ee6`, "Deploy to AWS" run 42997387438, all jobs
  green). It carries M4, M5 and the launch-gate tooling. Checked without a session
  afterwards: `GET /health` answers 200, and `/api/v1/rfps`, `/api/v1/rfps/summary`,
  `/api/v1/vendor-list`, `/api/v1/proposal-templates`,
  `/api/v1/organization/audit-events`, `/api/v1/organization/support-grants`,
  `/api/v1/admin/organization-plans` and `/api/v1/admin/launch-metrics` answer 401
  (they answered 404 before the release).
- Backend, second release: 2026-11-12, PR #134, `744e81d`, "Deploy to AWS" run
  43190684155, all jobs green. `GET /health` answered 200 afterwards.
- Dashboard and admin app: these repositories have no `production` branch. Vercel
  deploys `main` to its Production environment on every merge (on 2026-11-12:
  dashboard `d0be97e`, admin `8fb6174`), and `av-rfpilot.com` is served from Vercel. Between
  the dashboard merges of 10 Nov and the backend release of 11 Nov the live web
  apps called routes the production API did not have. **A dashboard or admin PR
  that needs a new API route must not merge before a backend release carries that
  route.** Not confirmed from here: that the Vercel project making those
  deployments is the one serving the public domain (two Vercel scopes appear in
  the deployment URLs).

**1. Released.** Nothing is left to merge for M4, M5 or the launch gate; ORG-504
merged as #130. Later backend work still reaches production only when `main` is
merged into the `production` branch.

**2. The plan change is live (ORG-601).** From the backend deploy that
carries ORG-601, every existing organization is on `free_trial`: 2 RFPs created,
vendor responses and RFP intelligence locked. RFPs created before that deploy are
not counted. It stays that way until RFPilot staff set `full_access` on the admin
app's Organizations page (ORG-603), which includes DXG's own organization. Legacy
holding tenants are exempt.
The owner reported on 2026-11-11, after the release, that Full access was set for
the organizations that need it; which organizations were changed was not checked
from here. Any organization created or left out since is on the free trial.

**3. Tenancy cutover (ORG-107).** No production run is recorded, so existing
customers are taken to be still in the shared organization (not checked against
production data).

- The rehearsal on a restored production snapshot is owed. ORG-501 was rehearsed
  only on a generated fixture in local Docker, up to 150 customers.
- The cutover runbook (ORG-502) makes that snapshot rehearsal a hard go/no-go and
  has seven steps marked "operator to confirm" against the production deployment.
- Decisions to record before cutover: (a) the apply makes every moved customer an
  active Planner in their holding tenant, including ones whose membership was
  suspended or removed (rehearsal finding 3); (b) customers who hold Owner or Admin
  in the shared organization; (c) RFPs owned by DXG staff in the shared
  organization. (b) and (c) were not in the rehearsal fixture.
- After cutover every legacy customer is refused at sign-in until DXG places them
  (ORG-110), so the placement list has to be ready first.

**4. ORG-503, external pen test: open.** It closes on an internal security review
plus a booked external test date. Neither has happened yet. Any high finding from
the external test blocks launch.

**5. Browser verification: mostly done on production, some owed.** The checks
that were skipped on 11 Nov were run on production on 11, 12 and 16 Nov as an
Owner; see "After the release" for what passed and what was not checked. Still
owed: every non-Owner role, an RFP-scope support grant, Duplicate and Archive from
the dashboard row menu, the role guide on a phone, and company single sign-on.

**6. Known follow-ups.**

- ~~`GET /api/admin/proposals`, `GET /api/admin/proposals/:id` and the per-account
  proposal count on `GET /api/all-clients` are not grant-checked and write no audit
  event.~~ Done on 2026-11-17 (`DECISIONS.md`; on `main` when the PR merges, not
  released): the two `proposals` routes are removed and answer 404, so staff reach
  proposals only under a support grant. The count on `GET /api/all-clients` stays
  as an account-level count under the owner's decision of the same date; it is a
  number, counted inside the staff member's organization only, and the list writes
  no audit event (`API.md`, "Staff client list"). The sent-email total on that
  list and both per-account numbers on `GET /api/admin/overview` are counted the
  same way, inside the staff member's organization. Rows with no `organizationId`
  are no longer counted (an undercount, not checked against production data).
  What remains, found and not changed: the tenant scope guard does not see
  `$lookup` stages, calls written with a type argument (`Model.aggregate<T>(`) or
  raw `Model.collection.*` calls, and `EmailCampaign` is not in its model list;
  `/api/all-clients` and `/api/admin/overview` check the account role but not the
  account type; and the staff guards do not require the caller's organization to
  be RFPilot's own (MongoDB stores no platform marker).
- ~~Template audit actions (`proposal_template.*`) are not in the customer audit
  catalog.~~ Resolved by decision (2026-11-16, `DECISIONS.md`): customers do not see
  template actions in their audit log. The events are still written for staff and
  forensics; `AUDIT_CATALOG` carries a comment and the wording guard test fails if
  one is added.
- Decided on 2026-11-17 (`DECISIONS.md`): the admin organization detail page shows
  account information only (owner, plan, counts of members, teams and proposals,
  domains, sign-in method, created and last-active dates) and no member list
  without a support grant. The backend route exists
  (`GET /api/v1/admin/organizations/:organizationId`, `API.md` "Organization account
  detail for RFPilot staff"; not released). The admin page is not built and must
  not merge before the route is in production.
- Decided on 2026-11-17 (`DECISIONS.md`), backend and infrastructure built, not
  deployed: legacy-customer placement on production runs in a one-off task that
  the admin API starts through a Step Functions state machine. The API is never
  given `POSTGRES_MIGRATION_URL` or permission to start ECS tasks.
  Not built, for the owner to decide: a Postgres-side anchor the API's database
  role cannot write (the task's checks all read MongoDB, which the API can write),
  and an alarm on the state machine's `ExecutionsStarted`.
- The admin app has no legacy-customer placement screen, although ORG-110
  describes one. Until it exists, placement is run with the ORG-110 script (or by
  calling the placement API once the change above is deployed).
- `tests/plan-entitlements.test.js` classifies the RFP intelligence, vendor
  analysis, vendor response, audit log and template routers. It does not cover the
  staff-only routers (support access, plan management, launch metrics) or the
  other member routers.
- Done and released 2026-11-12 (backend #133 and #134, admin #15; confirmed on
  production): the helpdesk inbox spanned only the staff
  organization, so customer tickets never reached staff and the grant-gated
  "RFPs behind a ticket" route was unreachable for them. RFPilot staff now work
  every organization's tickets; see "In-app helpdesk / support inbox".
- The presentation layout saved on a template is returned when an RFP is started
  from it, but the dashboard does not apply it.
- The dashboard sidebar's unread badge calls `GET /api/vendor-responses`, which is
  plan-locked: on a free-trial organization it gets a 403 and shows nothing.
- Launch metrics (ORG-505) have no admin-app screen; staff read the endpoint or
  run the report script.
- `SecurityAuditEvent`: ORG-407 changes `{ organizationId, createdAt }` to
  `{ organizationId, createdAt, _id }`. The new index is built at start-up; the
  old one has to be dropped by hand on deployed databases after that deploy.
- The "Workers Builds" check fails on the admin repository's `main`. It was
  already failing on 2026-10-27, before this work.
- "Continue with Google" never asks Google for the account chooser: the
  dashboard's `auth.ts` sends `prompt: "consent"` only, so a user with one Google
  session, typically a personal account, is signed in with it and is not offered
  their work account. Company single sign-on already sends `select_account`.
- Settings → General → Branding shows a "Proposal Link Prefix" ending in
  `.goprospero.com`, another product's domain.
- Country offers only "United States" in onboarding and organization settings.
- Team Manager cannot be chosen when inviting during onboarding (Planner, Admin
  and Viewer only).
- "RFP" in text the backend writes: converted on 2026-11-16 (branch
  `fix/proposal-wording-backend`). Audit log category and action labels and the CSV
  export (which no longer rewords stored names to `rfp`; it exports `proposal` and
  `proposalId` as stored), the form contract (`Proposal Timeline` and two helper
  texts; the dashboard's generated copy is regenerated in its own pull request),
  refusal and error messages (`OWNER_HAS_RFPS` and the other member, template, plan,
  support-access and award refusals: codes unchanged), the headline "This proposal
  has been sent to vendors", the dashboard list's "Untitled proposal", the vendor
  confirmation email's sign-off and the assistant's three fixed answers that said
  "generate or update the RFP". The assistant's field guidance reads the form
  contract, so its evidence for those three fields changed with it (guidance release
  `proposal-form-guidance.v5`); "rfp timeline" is kept as an alias so a question that
  uses the old name still finds the field. `tests/proposal-wording-guard.test.js` fails on a
  new standalone "RFP" in `src/`, the legacy top-level folders or `contracts/`, with
  a listed exception for each one that stays. Still saying "RFP":
  - AI prompts and assistant knowledge text, which a model reads
    (`platformAssistant/platformKnowledge.ts`, `liveAi/operations.ts`, the vendor fact-mapping instruction, the legacy
    extraction prompt) and requirement titles derived from field keys
    (`requirementRegistry/generator.ts`, "RFP Timeline Notes"). Changing these
    changes model input and needs its own evaluation run.
  - Stored codes shown as stored: support-access audit rows export `scope: rfp`
    and `operation: rfp.read` in the CSV's Details column. Codes keep their names.
  - Rows already stored: notifications, helpdesk messages, canned replies, saved
    requirement sets and audit rows keep the text they were written with. No
    backfill is planned.
  - The admin app's own text (separate pull request there), including "1 RFPs" on
    the Clients page.
- Row actions don't follow the access policy yet: the dashboard row menu is
  offered to Owners and Admins on every row and to others only on their own rows
  (Team Managers get none on team proposals), and a member with a view-only share
  still gets Edit on the proposal list. Backend half done (branch
  `feat/rfp-list-row-permissions`): `GET /api/v1/rfps` and `GET /api/proposals`
  items carry `permissions { canEdit, canDuplicate, canArchive }`, the same
  decisions the mutation endpoints enforce (`docs/API.md`, "Dashboard RFP
  queries"). Dashboard half pending: read the flags in the row menu and in the
  proposal list's Edit and title link, after the backend release. No `canDelete`:
  who may permanently delete is still an open product decision.
- Role rules where the code differs from the PRD (the Users page guide follows the
  code): `allowManagerInvites` defaults to off and no customer route changes it;
  reassigning a proposal's owner has only an Owner/Admin route; a Team Manager can
  permanently delete proposals of teams they manage.
- Pressing Enter in the "Access ends after" select submits the grant dialog.
- A proposal started from a template takes the template's event name, so it can
  duplicate an existing name; the dashboard tells them apart by date or ID.
- Colour contrast: the "View activity" button on Support access failed the
  light-theme axe check in local runs; the grey field labels (`labelClass`) in the
  invite and change-role dialogs and the blue support button (3.77:1) also fail.
- Flaky browser specs under load: "Enter on the title opens the edit page" and the
  audit log user filter (50 rows where 2 were expected, once).
- The dashboard has no pending indicator on tab, sort, chip or page links.
- "Acme Events" is still on the free trial.
- The built-in browser of the Claude desktop app cannot complete Google sign-in
  for a second account when a security key for another account is saved on the
  machine; use Chrome for sign-in tests.

### Onboarding funnel report (2026-09-13)

`GET /api/dashboard/onboarding-funnel` (security-admin) answers two questions
about accounts that started in a date window: what share sent a first
proposal-assistant message and generated a first draft within seven days, and
how long each took from account start (p50/p90 hours). No new event stream
was added: both milestones already exist as durable rows (user-role
`conversation_messages` and succeeded `proposal_draft_runs`, each stamped
with the acting user) and account start is `rfpilot.users.created_at`, the
tenant projection written at first sign-in. The report is organization-scoped
under RLS, aggregate-only with the same five-observation floor as Assistant
Quality, audited as `onboarding_funnel_report_viewed`, and excludes accounts
whose activity predates their projection (backfilled legacy users). Rates
are measured only over accounts old enough for the full window to have
elapsed. The admin AI Operations page shows it beside Assistant Quality
(`components/ai/OnboardingFunnelSection.tsx`). Module:
`src/modules/dashboard/application/onboardingFunnelReport.ts`.

---

## 4. Design decisions worth knowing

- **MongoDB stays authoritative for proposal content**; PostgreSQL owns the AI
  domain (runs, evidence, reviews, knowledge, pricing, audit, outbox); Redis
  carries references only, never content.
- **Human control boundary is explicit.** Every extracted field requires
  individual review followed by a current-versus-proposed confirmation.
  Empty fields are not treated as implicit consent. Submission and publication
  remain manual.
- **Never fabricate a number.** Investment guidance refuses categories the
  corpus cannot support, with a concrete ask. All 433 imported records are
  `calibration_tier = 'baseline'`, so every estimate says it rests on national
  baseline figures, not DXG actuals.
- **Prompt injection:** source content is data, never instructions; strict JSON
  schemas; citations validated against a whitelist of supplied evidence ids.
- **Idempotency everywhere** — messages, jobs, applications, provider attempts.

---

## 5. Known issues & deferred work

**Owed to the client**
1. **Written provider comparison** (SOW §4). DXG's stated preference is
   Anthropic; OpenAI was chosen. The gold harness's first live run scored
   **recall 87.5% against the 90% gate** (precision 93.3%, citations and schema
   100%, zero fabrications) — that result is the key input.
2. **Three questions for Ace:** does the service charge compound on the
   in-house subtotal (the engine assumes yes, matching his 1.40 × 1.22
   scenario)? Can the questionnaire gain **projector lumens** and an
   **in-house-vs-outside-AV** flag (worth ~20 confidence points on every
   estimate)? And confirmation that room recommendations may keep filling empty
   room fields unattended, now that extracted candidates no longer do.

**Product gaps**
- ~~**Typed conversation is not extracted.**~~ **Closed 2026-07-29.** The
  segmentation pipeline existed but its gate was never switched on;
  `CONVERSATION_EXTRACTION_ENABLED=true` now routes typed chat through the same
  cited-extraction and review path as an upload. Since 2026-08-04, a detailed
  single-turn brief closes immediately and the API exposes its runtime gate to
  the dashboard, so the “Use what I've told you” control cannot disagree with
  backend availability. Missing capability data fails closed in the dashboard.
- Stepper and assistant can disagree — the stepper counts gaps from extraction
  runs, questions now also come from empty fields.
- Completeness scores against all ~120 canonical fields, so it reads harshly
  (~9% for a real proposal). Weighting toward RFP-relevant fields would help.
- Rooms/arrays are not extracted (only scalar fields are mapped). The room
  recommendation capability (2026-07-27) covers part of this gap with
  deterministic, review-gated suggestions, but extraction itself still skips
  `roomByRoom`.
- Invalid extracted candidates are reported by the API (`invalidOperations`)
  but not rendered anywhere.
- Report envelope: confidence/assumptions/scenarios ride inside the
  `line_items` JSONB as `payloadVersion: 2`; promoting them to real columns is
  a small migration.
- Vendor analysis has no attempt-ledger coverage; bid-vs-bid pricing comparison
  and exportable client-ready reports are unbuilt.
- Existing vendor analysis still reads the latest `VendorResponse` compatibility
  projection. Binding analysis to an explicitly selected immutable version is
  part of the later comparison orchestration task.

**Testing**
- Unit suites are strong (backend 440, dashboard 332) and there is a real
  integration suite, but there are still no browser E2E tests, no load tests,
  and no production smoke tests. This remains the highest-value testing gap:
  every one of the three worst defects in §8 was invisible to unit tests and
  surfaced only by driving the real UI.

---

## 6. Class of bug to watch for

Repeatedly, the failure mode was **stale assumptions from the 4-field era**
surviving into the 112-field world, each hidden behind a generic error:

- `selected_count` capped at 25 and item `ordinal` at 0–24 → applying 46 fields
  failed (migrations 023/024).
- The review endpoint normalized all candidates eagerly, so two unmappable
  values broke the whole request — and with it version lookup and auto-apply.
- Enum fields only accepted exact tokens while extraction returns prose
  ("Confirmed", "Human captioner preferred").
- Clarification questions could only exist against an extraction run, so a
  conversation-only proposal was asked nothing (migration 025).
- Completion state lived in session-local React state and vanished on refresh.

From the 2026-07-29 UI review, the same class again — plus a second class:
**a value the code reads that the UI never writes**, and **a failure that is
caught and softened until it becomes invisible**.

- `contactRequired` read `this.isDraft`, but `findOneAndUpdate` binds validators
  to the query, not the document, so every assisted draft save failed with an
  opaque "Validation failed".
- `ROOM_AUDIO_QA_001` required `audienceQa.audienceQa === "Yes"`, a field the
  Room Specifications form never writes — the mic recommendations were
  unreachable in the app while every fixture set the flag by hand. Worse, save
  normalisation *cleared* `audienceQaMethod` whenever that flag was not "Yes",
  so the planner's Q&A selection was discarded on every save.
- `uniqueItems` in the conversation reply schema 400'd every live call; the
  provider error was caught and replaced with the canned acknowledgement, so
  the assistant appeared to work and simply never used the model.
- Sidebar completion was `activeStep > step.id`, so opening the last page marked
  every earlier step done regardless of content.
- Expiry queried `isActive: true`, which defaults to true, so unsubmitted drafts
  were swept into the published-proposal lifecycle.

When something "doesn't work", check for a limit or gate written when the
feature was smaller, and prefer per-item resilience over all-or-nothing. When
something "works" but produces nothing, check whether a fallback is hiding a
hard failure, and whether the field a rule reads is one the UI actually writes.
Fixtures shaped by hand will not catch that — shape them the way the form saves.

---

## 7. Suggested next steps

1. Draft the provider comparison and close the recall gap (prompt tuning,
   `gpt-5.4` full tier, or benchmark Claude through the existing port).
2. Add browser E2E coverage for the assistant → wizard → draft journey. Every
   defect in §8 was invisible to the unit suites.
3. Real-asset acceptance run with the SOW test RFP and vendor responses,
   reviewed by the founder — the contractual acceptance test.
4. Add the two questionnaire fields; promote the report envelope to columns.
5. ~~Merge `ai-agent` to the default branch~~ (done). Stand up staging per the runbook.
6. Organization accounts: work through "Before launch: Organization accounts"
   in §3 before inviting external organizations. In order: (a) the small fixes
   from the 16 Nov checks, starting with the Google account chooser and the
   `.goprospero.com` text; (b) per-row permissions on `GET /api/v1/rfps`;
   (c) "Proposal" wording in the admin app (backend-written text is done except
   AI prompts and knowledge text, which need an evaluation run);
   (d) company single sign-on on production, once a DNS TXT record can be
   published; (e) the production-snapshot rehearsal and cutover decisions;
   (f) ORG-503.

---

## 8. End-to-end UI review (2026-07-29)

A full pass over the AI proposal-creation journey in a browser, against a real
draft. Everything below is fixed and verified in the running app; the durable
rules are registered in `DECISIONS.md`.

**Three defects that made features look built but inert**

| What | Why it mattered |
|---|---|
| `uniqueItems` in the conversation reply schema | Strict structured output rejects the keyword, so every live reply 400'd and fell back to canned text. The assistant had never once used the model — this alone explained most of what read as "the AI ignores what you type". |
| Contact validator bound to the query, not the document | Every assisted draft save failed with "Validation failed"; combined with no autosave, a planner could lose a fully specified proposal. |
| Q&A method cleared on save | The planner's Q&A selection was wiped on every save, which also made the wireless-mic recommendations unreachable. |

**Correctness**
- Schedule times anchored to the venue zone, end to end (storage, pickers,
  draft evidence). A 9:15 AM Chicago keynote uploaded from UTC+6 previously
  reached vendors as "3:00 AM UTC".
- Evaluation weightings withheld until confirmed (see `DECISIONS.md`).
- Expiry no longer closes unsubmitted drafts as `rejected`.

**Intake and recovery**
- Attendance is now in the opening question set; it had ranked below venue
  state (auto-filled from the city answer) and fell outside the eight-question
  cap, so it was never asked.
- Draft edits autosave, with an unsaved-changes warning on unload.
- A blocked room step names the room and missing fields, then opens and scrolls
  to it, instead of returning silently.
- Skipping a question leaves a note with a link to the page that owns the field.
- Readiness and investment reports are restored on load rather than re-run.
- Sidebar checkmarks reflect real per-step completion.
- `asksForRoomScheduleHelp` matches "room schedule" on its own.

**Deliberately not changed**
- **Auto-titling a proposal from the first message.** The backend treats
  "Untitled proposal" as empty, which is what keeps "What is this event called?"
  in the question set; filling it from free text would suppress that question
  and lock in a guess.
- **Batching the assistant's server-action requests.** A dev-mode pattern not
  confirmed to affect production builds.
- **Backfilling `evaluationMatrixConfirmed` on existing proposals.** Product
  decision (2026-07-29): old data is being deleted, so only new proposals matter.
  Every pre-existing proposal therefore reads as unconfirmed.

---

## 9. Conversation provider recovery (2026-09-13)

- A self-contained one-message event brief now closes into proposal-context
  extraction based on requirement signals rather than a fixed character count.
  Concise requirements qualify, filler does not, and one-value corrections stay
  open for batching so conflicts can be detected safely.
- Temporary live-chat provider failures retain the durable job's retry budget.
  When that budget is exhausted, the assistant placeholder completes with an
  honest service-unavailable message instead of becoming the generic red
  failure turn. It does not claim that fields were saved or extracted.
- `CONVERSATION_EXTRACTION_ENABLED` was already active in `.env.local`; the
  observed extraction failure was provider-side HTTP 429
  `credit_balance_exhausted` (`insufficient_quota`), not a disabled feature.
  Extraction will resume without another code change after provider credit is
  restored.
- Verification: conversation suites 51/51, TypeScript type-check, focused
  ESLint, and `git diff --check` passed. The affected local proposal was repaired
  in place and the browser confirmed the red failure was replaced by the new
  recovery copy.
- Proposal conversation writes retain the 60-per-IP/15-minute limit and now
  also enforce 60 writes per authenticated organization/user across IP changes.
  Message text is capped at 8,000 characters and stored through parameterized
  PostgreSQL statements.
- The room-specifications/template guidance now appears immediately after the
  “How many event rooms are required?” question is answered or skipped, rather
  than waiting for every guided question to be resolved.
