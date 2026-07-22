# RFPilot AI Intelligence Layer

## Milestone 0 Decision and Evidence Register

**Purpose:** Record the evidence and approvals required before implementation begins.  
**Current gate status:** Approved by client direction on July 15, 2026  
**Authorized milestone:** Milestone 1 — Platform, Security, and Delivery Foundation; Slice 1A in progress  
**Last updated:** July 15, 2026

**Approval meeting:** [Phase 0 Approval Workshop Pack](./RFPilot_AI_Phase_0_Approval_Workshop_Pack.md)  
**Formal gate:** [Milestone 1 Implementation Authorization Record](./RFPilot_AI_Milestone_1_Authorization_Record.md)  
**Execution control:** [Approval-Gated Milestone Execution Playbook](./RFPilot_AI_Milestone_Execution_Playbook.md)

> Engineering implementation must not begin until every mandatory gate item is either approved or documented as an accepted risk by an authorized DXG and Bayshore representative.

---

# 1. Status definitions

| Status | Meaning |
|---|---|
| Not started | No evidence or decision has been supplied |
| In review | Evidence is available and being reviewed |
| Approved | Authorized decision-maker has accepted the item |
| Approved with conditions | Work may proceed subject to recorded conditions |
| Blocked | Required information or authority is unavailable |
| Rejected | Proposed decision is not accepted and must be revised |
| Not applicable | Authorized reviewer confirms the item does not apply |

---

# 2. Required decision owners

| Responsibility | Named owner | Backup owner | Status |
|---|---|---|---|
| DXG executive sponsor | To be assigned | To be assigned | Not started |
| DXG product owner | To be assigned | To be assigned | Not started |
| DXG founder/production expert | To be confirmed | To be assigned | Not started |
| DXG knowledge approver | To be assigned | To be assigned | Not started |
| DXG pricing approver | To be assigned | To be assigned | Not started |
| DXG security/privacy approver | To be assigned | To be assigned | Not started |
| Bayshore technical lead | To be assigned | To be assigned | Not started |
| Bayshore AI lead | To be assigned | To be assigned | Not started |
| Bayshore backend lead | To be assigned | To be assigned | Not started |
| Bayshore frontend/UX lead | To be assigned | To be assigned | Not started |
| Bayshore delivery owner | To be assigned | To be assigned | Not started |

---

# 3. Requirements and scope decisions

| ID | Decision required | Proposed decision | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-001 | Approve the four workstreams | Knowledge foundation, Proposal Creation, Investment Guidance, Vendor Analysis | DXG sponsor/product owner | Approved requirements document | Not started |
| DEC-002 | Confirm project objective | Reduce planner effort and move producer work from full review to flagged review | DXG sponsor/founder | Written objective and baseline plan | Not started |
| DEC-003 | Confirm out-of-scope items | Marketing site, vendor AI writing, automated award, unrelated CRM work | DXG sponsor/product owner | Signed scope statement | Not started |
| DEC-004 | Confirm planner workflow | AI draft followed by exception review; manual editing remains available | DXG product owner | Workflow approval/demo | Not started |
| DEC-005 | Confirm AI authority boundary | AI assists; deterministic services and humans control pricing, publication, and final decisions | DXG sponsor/founder | Written policy | Not started |
| DEC-006 | Confirm change-control process | Material scope changes require written impact and approval | DXG and Bayshore delivery owners | Change-control template | Not started |

---

# 4. Knowledge and pricing decisions

| ID | Decision required | Options or proposed direction | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-010 | Historical data permitted for use | Identify contracts, quotes, spreadsheets, and exports legally usable by RFPilot | DXG sponsor/privacy approver | Data inventory and usage authorization | Not started |
| DEC-011 | Planner-visible provenance | Show safe aggregate provenance; keep vendor/contract detail DXG-only | DXG product/privacy approver | Visibility matrix | Not started |
| DEC-012 | Rule publication roles | Editor and approver separated where possible | DXG knowledge approver | Role assignment | Not started |
| DEC-013 | Pricing publication roles | Editor and approver separated where possible | DXG pricing approver | Role assignment | Not started |
| DEC-014 | Initial pricing taxonomy | Equipment, labor, services, ancillary factors, market, unit, date, currency | DXG founder/pricing approver | Approved taxonomy | Not started |
| DEC-015 | Price normalization policy | Define inflation, market, currency, negotiated discount, outlier handling | DXG founder/pricing approver | Approved methodology | Not started |
| DEC-016 | Knowledge effective dates | Rules and observations are effective-dated and versioned | DXG knowledge/pricing approvers | Governance policy | Not started |
| DEC-017 | Existing UI suggestions | Classify each as approved rule, provisional rule, copy-only help, or remove | DXG founder/product owner | Suggestion inventory | Not started |

---

# 5. Product behavior decisions

| ID | Decision required | Proposed direction | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-020 | Estimate completeness threshold | Required fields vary by event format and production profile | DXG founder/product owner | Completeness matrix | Not started |
| DEC-021 | Estimate presentation | Event total plus equipment, labor, room/category, and ancillary lines | DXG product owner | Approved wireframe/output example | Not started |
| DEC-022 | Unsupported pricing behavior | Show unsupported/venue-dependent status and a question; never guess | DXG sponsor/founder | Written critical-quality policy | Not started |
| DEC-023 | Recommendation actions | Accept, modify, dismiss, defer, undo | DXG product owner | Workflow approval | Not started |
| DEC-024 | Mandatory recommendations | Default advisory; critical publish blocks only by approved policy | DXG founder/product owner | Severity/action matrix | Not started |
| DEC-025 | Publish with unresolved risks | Decide block, override, or acknowledge by severity | DXG sponsor/product owner | Publish policy | Not started |
| DEC-026 | Producer escalation | Define severity/confidence/rule categories that require review | DXG founder | Escalation matrix | Not started |
| DEC-027 | Proposal intake methods | Upload and manual required; approve pasted notes and prior-proposal reuse for first release | DXG product owner | Phase 2 scope approval | Not started |
| DEC-028 | Vendor-analysis outcome | Comparison and questions only; no automatic award recommendation | DXG sponsor/product owner | Written policy | Not started |

---

# 6. Architecture and infrastructure decisions

| ID | Decision required | Recommendation | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-030 | Application architecture | Modular monolith plus independent background workers | DXG/Bayshore technical approvers | Architecture review | Not started |
| DEC-031 | Existing proposal database | Retain MongoDB during staged migration | Technical approvers | ADR-001 | Not started |
| DEC-032 | AI domain database | Add managed PostgreSQL for knowledge, pricing, provenance, workflows, audit | Technical/budget approvers | ADR and cost estimate | Not started |
| DEC-033 | Queue and cache | Add managed Redis and BullMQ | Technical/budget approvers | ADR and cost estimate | Not started |
| DEC-034 | Retrieval store | Use PostgreSQL full-text plus `pgvector` initially | Technical approvers | Retrieval benchmark/ADR | Not started |
| DEC-035 | Object storage | Private DigitalOcean Spaces or approved S3-compatible storage | Technical/security approvers | Storage configuration design | Not started |
| DEC-036 | Worker hosting | Persistent container environment, separate from Vercel Functions | Technical/budget approvers | Deployment design | Not started |
| DEC-037 | API hosting | Approve managed containers or hardened multi-instance DigitalOcean architecture | Technical/budget approvers | Deployment/cost comparison | Not started |
| DEC-038 | API versioning | New `/api/v1` with compatibility adapters | Technical approvers | API migration plan | Not started |

---

# 7. AI provider and quality decisions

**Decision evidence:** [RFPilot AI Provider Benchmark and Acceptance Protocol](./RFPilot_AI_Provider_Benchmark_and_Acceptance_Protocol.md). The protocol is drafted; provider execution and approval remain outstanding.

| ID | Decision required | Proposed direction | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-040 | Baseline provider | Benchmark Anthropic Claude and OpenAI using identical DXG assets | DXG sponsor/AI lead | Benchmark report | Not started |
| DEC-041 | Provider privacy | No training; approved retention and regional terms | DXG privacy/security approver | Provider terms review | Not started |
| DEC-042 | Provider fallback | Only approved providers and data classifications; no silent unapproved fallback | Security/AI approvers | Provider policy | Not started |
| DEC-043 | Extraction acceptance | Approve precision, recall, citation, conflict, and schema thresholds | DXG founder/AI lead | Evaluation rubric | Not started |
| DEC-044 | Guidance acceptance | Directional accuracy, ancillary recall, and zero unsupported-number defects | DXG founder | Evaluation rubric | Not started |
| DEC-045 | Analysis acceptance | Material-finding precision/recall, citation accuracy, escalation calibration, zero fabricated findings | DXG founder | Evaluation rubric | Not started |
| DEC-046 | Reproducibility | Materially equivalent structured findings; prose may vary within approved limits | DXG founder/product owner | Consistency policy | Not started |
| DEC-047 | AI budget | Set per-job and monthly organization/provider limits | DXG budget/product owner | Cost model | Not started |
| DEC-048 | AI latency targets | Approve expected and maximum times per operation | DXG product owner | SLO document | Not started |

---

# 8. Security, privacy, and operations decisions

| ID | Decision required | Proposed direction | Required approver | Evidence | Status |
|---|---|---|---|---|---|
| DEC-050 | Data classification | Public, customer confidential, vendor confidential, DXG proprietary, security-sensitive | DXG security/privacy approver | Classification policy | Not started |
| DEC-051 | Retention | Define source, fragment, AI-run, export, audit, and backup retention | DXG security/legal approver | Retention schedule | Not started |
| DEC-052 | Data residency | Confirm permitted hosting regions | DXG legal/security approver | Written requirement | Not started |
| DEC-053 | Authentication | Short access tokens and rotating refresh sessions | Technical/security approvers | Identity ADR | Not started |
| DEC-054 | Public access | Scoped, expiring, revocable share and vendor tokens | Product/security approvers | Public-access policy | Not started |
| DEC-055 | Recovery targets | Proposed RPO 15 minutes and RTO 4 hours | DXG sponsor/technical approver | DR requirements | Not started |
| DEC-056 | Audit retention/access | Define retention and auditor roles | DXG security/legal approver | Audit policy | Not started |
| DEC-057 | Security testing | External penetration test before general availability | DXG sponsor/security approver | Security plan and budget | Not started |
| DEC-058 | Incident ownership | Name DXG and Bayshore security/operations contacts | Delivery/security owners | Escalation matrix | Not started |

---

# 9. Required evidence and client-provided assets

| ID | Required item | Minimum acceptable evidence | Owner | Due date | Status |
|---|---|---|---|---|---|
| EVD-001 | Real completed RFP | Immutable copy with usage authorization | DXG | To be set | Not started |
| EVD-002 | Associated vendor responses | All responses for the selected RFP | DXG | To be set | Not started |
| EVD-003 | Actual event cost | Final invoice/contract or approved summary | DXG | To be set | Not started |
| EVD-004 | Founder analysis | Written material findings and expected vendor questions | DXG founder | To be set | Not started |
| EVD-005 | Historical pricing sample | Representative PDFs and spreadsheets across relevant categories | DXG | To be set | Not started |
| EVD-006 | Expert rule examples | At least 10 rules with examples/exceptions | DXG founder | To be set | Not started |
| EVD-007 | Current infrastructure inventory | Hosting, databases, domains, storage, CI/CD, monitoring, backups | Bayshore/DXG technical | To be set | Not started |
| EVD-008 | Expected volume | Users, proposals/month, documents, responses, concurrency | DXG product owner | To be set | Not started |
| EVD-009 | Legal/privacy constraints | NDA, MSA, customer/vendor restrictions, residency | DXG legal/security | To be set | Not started |
| EVD-010 | Current production access | Approved read-only access for discovery and verification | DXG/Bayshore technical | To be set | Not started |

---

# 10. Baseline measurements

| Metric | Measurement method | Baseline | Target | Owner | Status |
|---|---|---:|---:|---|---|
| Planner time to complete test RFP | Observed task session | Not measured | To be approved | Product/UX | Not started |
| Producer time to review RFP | Timed founder/producer review | Not measured | To be approved | DXG founder | Not started |
| Producer time to analyze all responses | Timed manual analysis | Not measured | To be approved | DXG founder | Not started |
| Material findings in gold case | Founder annotated list | Not measured | Acceptance baseline | AI evaluation | Not started |
| Actual final event cost | Approved cost source | Not supplied | Reference | DXG pricing owner | Not started |
| Current extraction quality | Existing endpoint on gold source | Not measured | Improvement baseline | AI lead | Not started |
| Current AI cost/latency | Existing extraction telemetry/test | Not measured | Budget/SLO baseline | AI/operations | Not started |

---

# 11. Formal authorization gate for Milestone 1

Milestone 1 may begin only when the following are true:

- [ ] DEC-001 through DEC-006 are Approved or Approved with Conditions.
- [ ] DEC-030 through DEC-038 are Approved or have a documented alternative.
- [ ] DEC-040 through DEC-042 have enough approval to configure development providers safely.
- [ ] DEC-050 through DEC-058 are approved at least for development/staging scope.
- [ ] EVD-001 through EVD-010 have owners and committed delivery dates.
- [ ] Milestone 1 staffing, budget, and schedule are approved.
- [ ] The technical design and implementation backlog reflect every approved change.
- [ ] No critical legal, security, infrastructure, or data-use blocker remains unresolved.

## Authorization statement

> DXG and Bayshore authorize Milestone 1 — Platform, Security, and Delivery Foundation. This authorization does not approve later AI feature milestones automatically. Each later milestone remains subject to its entry and exit gates.

**DXG approver:** _______________________________________  
**Role:** _______________________________________________  
**Decision:** Approved / Approved with Conditions / Not Approved  
**Conditions:** __________________________________________  
**Date:** _______________________________________________

**Bayshore technical approver:** __________________________  
**Role:** _______________________________________________  
**Decision:** Approved / Approved with Conditions / Not Approved  
**Conditions:** __________________________________________  
**Date:** _______________________________________________

---

# 12. Program synchronization checklist

When a decision changes, update all affected artifacts:

- [ ] `RFPilot_AI_Client_Requirements_Confirmation.md`
- [ ] `RFPilot_AI_Intelligence_Layer_Technical_Design.md`
- [ ] `RFPilot_AI_Implementation_Backlog.md`
- [ ] `RFPilot_AI_Phase_0_Approval_Workshop_Pack.md`
- [ ] `RFPilot_AI_Milestone_1_Authorization_Record.md`
- [ ] `RFPilot_AI_Milestone_Execution_Playbook.md`
- [ ] `RFPilot_AI_Milestone_Status_and_Acceptance_Template.md`
- [ ] API/OpenAPI specification when created
- [ ] Database schema and migration plan when created
- [ ] Threat model and data-flow inventory when created
- [ ] Evaluation rubric and gold-case expectations when created
- [ ] Delivery estimate, schedule, and risk register

The decision register is the approval record; the technical design remains the architecture source of truth; the implementation backlog remains the execution source of truth.
