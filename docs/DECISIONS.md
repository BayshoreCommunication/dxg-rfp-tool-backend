# Architectural Decisions

> Purpose: concise register of accepted, durable decisions. Last updated: 2026-07-22. Owner: engineering/product.

| Decision | Rationale / consequence |
|---|---|
| MongoDB remains proposal-content authority. | Avoids a destructive product migration; PostgreSQL references proposals and owns the AI domain. |
| PostgreSQL owns durable AI state; Redis is transport only. | RLS, auditability, recovery, and reference-only queue messages. |
| Canonical `proposal.v1` contract with generated types. | One validated shape across API, AI, UI, and tests while legacy adapters preserve compatibility. |
| Canonical migration uses immutable snapshots, not in-place rewrites. | Dry-run, review, idempotency, and rollback without touching legacy records. |
| AI provider access uses a governed port and pinned model snapshot. | Provider replacement, deterministic release evidence, budget controls, and no hidden legacy endpoint. |
| Extracted field candidates never auto-apply. | Every candidate remains read-only until the owner reviews individual current/proposed values and explicitly confirms application. |
| Publication is always human-controlled. | AI assistance must not become autonomous procurement action. |
| Investment guidance is deterministic and may refuse. | No fabricated numbers; disclose baseline provenance and unsupported categories. |
| Knowledge uses approved immutable releases. | Retrieval eligibility is tenant-scoped and excludes revoked/superseded content. |
| Client source content is untrusted data. | Prompt injection controls, strict schemas, citation allowlists, and minimized provider payloads. |

Historical ADRs and decision registers are preserved in `archive/2026-07/pre-consolidation-root/`.
