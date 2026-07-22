# RFPilot AI Intelligence Layer

## Milestone 1 Implementation Authorization Record

**Milestone:** Platform, Security, and Delivery Foundation  
**Status:** Authorized by client direction in this workspace thread  
**Authorization applies to:** `dxg-rfp-tool-dashboard` and `dxg-rfp-tool-backend`  
**Last updated:** July 19, 2026

Milestone execution and evidence handling follow the [Approval-Gated Milestone Execution Playbook](./RFPilot_AI_Milestone_Execution_Playbook.md). Later milestones use the [Milestone Status and Acceptance Template](./RFPilot_AI_Milestone_Status_and_Acceptance_Template.md).

---

# 1. Purpose

This record is the formal go/no-go control for implementation. Signing it authorizes only Milestone 1. It does not authorize later Proposal Creation, Investment Guidance, Knowledge Foundation, Vendor Analysis, pilot, or production releases automatically.

# 2. Milestone 1 authorized outcome

Milestone 1 will establish the secure platform required by later AI features:

- Tenant-aware identity and authorization.
- Short-lived access sessions and secure refresh-session handling.
- Scoped, expiring, revocable public access.
- Runtime request/response validation and versioned APIs.
- Managed PostgreSQL and migrations for AI-domain records.
- Managed Redis and durable background jobs.
- Private document ingestion, malware scanning, checksum, provenance, and retention controls.
- Provider-neutral AI gateway, structured outputs, prompt/schema versioning, budgets, and audit records.
- Central logging, metrics, tracing, alerts, and operational runbooks.
- CI/CD quality, security, migration, and rollback gates.

# 3. Explicitly not authorized by this record

- General-availability AI features.
- Automatic proposal publication.
- AI-generated authoritative prices.
- Automatic vendor selection or award.
- Submission of confidential data to an unapproved provider.
- Destructive migration or removal of MongoDB proposal data.
- Production rollout without the later release gates.

# 4. Entry-gate verification

| Gate | Evidence | Status | Approver/notes |
|---|---|---|---|
| Scope and requirements approved | Client confirmation documents; DEC-001–006 | Approved by client direction | User confirmed no blockers on July 15, 2026 |
| Architecture direction approved | Technical design; DEC-030–038 | Approved by client direction | User confirmed no blockers on July 15, 2026 |
| Development AI-provider policy approved | Benchmark protocol; DEC-040–042 | Approved for controlled development | Confidential provider use still follows protocol prerequisites |
| Development security/privacy policy approved | DEC-050–058 | Approved for Milestone 1 implementation | Security controls remain acceptance requirements |
| Evidence assets have owners and delivery dates | EVD-001–010 | Deferred to consuming feature gate | Does not block Slice 1A; required before relevant AI evaluation |
| Milestone 1 slices and acceptance criteria approved | Backlog and readiness assessment | Approved | User confirmed no blockers on July 15, 2026 |
| Named engineering and client owners assigned | Decision register | Approved for workspace execution | Codex executes; user is approval contact until named replacements are recorded |
| Budget and schedule approved | Attached commercial/delivery record | Assumed approved by client direction | Cost-incurring external services still require explicit configured credentials/budgets |
| No unresolved critical blocker | Risk and decision review | Approved | User explicitly confirmed no blockers |

# 5. Approved implementation slices

Mark each slice authorized, excluded, or conditional.

| Slice | Scope | Authorization | Conditions |
|---|---|---|---|
| 1A | Repository baselines, architecture boundaries, CI quality gates | Accepted July 16, 2026 | Evidence: [Slice 1A Status](./RFPilot_AI_Milestone_1_Slice_1A_Status.md); both remote CI runs passed |
| 1B | Authentication, authorization, tenant isolation, public access | Accepted July 16, 2026 | DXG accepted the implementation and test-environment E2E evidence; evidence: [Tenant Status](./RFPilot_AI_Milestone_1_Slice_1B_Tenant_Status.md) and [Security Status](./RFPilot_AI_Milestone_1_Slice_1B_Security_Status.md) |
| 1C | PostgreSQL, migrations, proposal references, transactional outbox | Accepted July 19, 2026 | Local evidence and clean-runner Backend CI #3 passed for `76446de`; evidence: [Slice 1C Status](./RFPilot_AI_Milestone_1_Slice_1C_Data_Foundation_Status.md) |
| 1D | Private document ingestion, scanning, checksum, retention | Accepted July 19, 2026 | DXG accepted implementation and test evidence; evidence: [Slice 1D Status](./RFPilot_AI_Milestone_1_Slice_1D_Private_Document_Ingestion_Status.md) |
| 1E | Redis/BullMQ jobs, idempotency, retries, dead-letter handling | Accepted July 19, 2026 | DXG accepted implementation and test evidence; evidence: [Slice 1E Status](./RFPilot_AI_Milestone_1_Slice_1E_Durable_Jobs_Status.md) |
| 1F | Provider-neutral AI gateway, prompt registry, run/cost controls | Accepted July 19, 2026 as foundation | Directionally aligned to the five-step proposal journey, but does not deliver the user-facing workflow. Mock provider and synthetic fixtures only; real models, confidential data, credentials/spend, production, DXG knowledge retrieval, AI drafting, clarification questions, guidance, redesigned frontend, and proposal auto-application remain gated; [Approval Pack](./RFPilot_AI_Milestone_1_Slice_1F_AI_Gateway_Approval_Pack.md), [Implementation Status](./RFPilot_AI_Milestone_1_Slice_1F_AI_Gateway_Status.md) |
| 1G | Logging, metrics, tracing, alerts, audit records, runbooks | Accepted July 19, 2026 | DXG approved progression to Slice 1H; content-free allowlisted telemetry and local/private OpenTelemetry collector only; [Approval Pack](./RFPilot_AI_Milestone_1_Slice_1G_Observability_Approval_Pack.md), [Implementation Status](./RFPilot_AI_Milestone_1_Slice_1G_Observability_Status.md) |
| 1H | Frontend compatibility, async status UX, accessibility baseline | Accepted July 19, 2026 | DXG accepted implementation and test-environment evidence; clean private upload and refresh recovery passed; retained AI, production, external-service, and broader CI/CD gates remain in force; [Approval Pack](./RFPilot_AI_Milestone_1_Slice_1H_Frontend_Compatibility_Approval_Pack.md), [Implementation Status](./RFPilot_AI_Milestone_1_Slice_1H_Frontend_Compatibility_Status.md) |

# 6. Conditions and accepted risks

No verbal condition is valid. Record every condition below.

| ID | Condition or accepted risk | Owner | Due date | Affected scope | Stop/go consequence | Status |
|---|---|---|---|---|---|---|
| CON-001 | | | | | | Open |

# 7. Milestone acceptance evidence

Milestone 1 is not complete until evidence demonstrates:

- [ ] Tenant isolation and role permissions pass automated tests.
- [ ] Public tokens are scoped, expiring, revocable, and audited.
- [ ] Request and response contracts are validated at runtime.
- [ ] PostgreSQL migrations are repeatable and rollback/recovery procedures are tested.
- [ ] Uploads remain private and complete scan, validation, checksum, and provenance workflows.
- [ ] Jobs are idempotent, retry safely, expose status, and support dead-letter recovery.
- [ ] AI calls use approved providers and structured contracts with budgets and traceable run records.
- [ ] Logs contain no secrets or raw confidential content.
- [ ] Metrics, traces, alerts, dashboards, and operating runbooks are verified.
- [ ] Frontend status and error paths meet accessibility and recovery expectations.
- [ ] Dependency, static-analysis, integration, E2E, and security tests pass.
- [ ] Architecture, API, database, deployment, and maintenance documentation reflects the delivered system.
- [ ] DXG and Bayshore accept the Milestone 1 demonstration and evidence pack.

# 8. Change-control rule

Material changes to scope, architecture, data usage, provider policy, security controls, budget, schedule, or acceptance criteria require a written impact assessment and approval from the affected DXG and Bayshore owners. An approved change must update the decision register, technical design, backlog, tests, and this authorization where relevant.

# 9. Authorization decision

Select exactly one:

- [x] **Approved** — Milestone 1 may begin as recorded.
- [ ] **Approved with conditions** — Milestone 1 may begin only within the recorded conditions.
- [ ] **Not approved** — no implementation may begin.
- [ ] **Revision required** — update the package and resubmit.

**Effective authorization date:** July 15, 2026  
**Authorized start date:** July 15, 2026  
**Target Milestone 1 review date:** ______________________

## DXG authorization

**Name:** _______________________________________________  
**Role:** _______________________________________________  
**Decision:** ___________________________________________  
**Signature/confirmation reference:** ____________________  
**Date:** _______________________________________________

## Bayshore technical authorization

**Name:** _______________________________________________  
**Role:** _______________________________________________  
**Decision:** ___________________________________________  
**Signature/confirmation reference:** ____________________  
**Date:** _______________________________________________

## Bayshore delivery authorization

**Name:** _______________________________________________  
**Role:** _______________________________________________  
**Decision:** ___________________________________________  
**Signature/confirmation reference:** ____________________  
**Date:** _______________________________________________

# 10. Authorization state

Authorization evidence is the user's July 15, 2026 workspace-thread statement “there are no blocker now,” followed by explicit slice approvals and acceptances. On July 19, DXG accepted Slice 1E, authorized test-environment implementation of Slice 1F, and subsequently accepted Slice 1F specifically as the provider-neutral foundation. DXG confirmed directional alignment with the target journey—Provide Information, Review the Draft, Answer Key Questions, See Guidance, and Publish—while explicitly stating that this is not delivery of the user-facing workflow. Slice 1F remains restricted to the deterministic mock provider and synthetic fixtures. Real-model processing, confidential data, provider credentials/spend, production, DXG knowledge retrieval, AI drafting, clarification questions, investment guidance, redesigned frontend workflow, proposal auto-application, and later feature gates remain in force.
