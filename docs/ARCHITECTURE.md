# RFPilot Architecture

> Purpose: current system map and source-of-truth boundaries. Last updated: 2026-08-04. Owner: engineering.

## System

```text
Planner dashboard ─┐
Admin application ─┼─ HTTPS ─> Express API ─> MongoDB (proposal content)
Vendor/public flow ┘                 │       ├> PostgreSQL + pgvector (AI domain)
                                     │       ├> private S3 (quarantine/sources)
                                     └> outbox -> Redis -> durable worker
                                                        └> ClamAV / OpenAI
```

The backend is a transitional modular monolith. The API creates authoritative records and outbox events; the dispatcher publishes reference-only messages; the durable worker resolves content from authoritative stores and performs scans, extraction, drafting, indexing, guidance, and vendor analysis.

## Repository responsibilities

- `dxg-rfp-tool-backend`: REST API, WebSocket/SSE support, legacy jobs, durable AI jobs, persistence, provider gateway, audit and usage reporting.
- `dxg-rfp-tool-dashboard`: planner authentication, proposal workflow, conversational assistant, review, guidance, publication controls.
- `dxg-rfp-tool-admin`: knowledge, pricing, user, and operational administration. Its backend bearer token stays server-side.

## Sources of truth

| Concern | Authority | Rule |
|---|---|---|
| Proposal content and lifecycle | MongoDB | AI does not become proposal authority. Writes use validation and version checks. |
| AI runs, evidence, reviews, knowledge, pricing, audit, outbox | PostgreSQL | Tenant RLS and immutable/reconstructable records apply. |
| Job transport and shared rate limits | Redis | References only; never proposal or document content. |
| Uploaded source bytes | Private S3-compatible storage | Quarantine, malware scan, retention, no public ACL. |
| Session/user identity | Existing application identity plus external IDs | Resource IDs are never authorization. |

## Primary proposal flow

1. A planner creates or opens a proposal and enters `/proposals/{id}/assistant`.
2. Typed messages and attachments enter the conversation. Attachments pass private upload and fail-closed malware scanning.
3. Eligible files and closed typed-conversation segments feed the same cited structured extraction. A detailed single-turn brief closes immediately; shorter chat can be closed explicitly with “Use what I’ve told you.”
4. Valid, high-confidence, single candidates may fill empty draft fields. Conflicts, existing values, low confidence, and invalid values require review.
5. Guided questions close high-impact gaps. Cited drafting, readiness guidance, and deterministic investment guidance follow.
6. A human reviews and publishes. The AI never publishes.

## Security and reliability boundaries

- All AI capabilities are deny-by-default through `AI_ENVIRONMENT`, per-capability flags, and kill switches.
- Source text is treated as data, not instruction. Structured output and citations are validated.
- Jobs, messages, applications, and provider attempts use idempotency controls.
- PostgreSQL is authoritative for durable work; Redis loss is recoverable from jobs/outbox.
- Private/quarantined storage, tenant isolation, malware scanning, citation validation, and human publication control are non-removable controls.

## Detailed references

- [AI layer](AI_LAYER.md)
- [Database](DATABASE.md)
- [Architecture component records](architecture/README.md)
- [Production topology](runbooks/PRODUCTION.md)
- [Dashboard boundaries](../../dxg-rfp-tool-dashboard/docs/architecture/README.md)
