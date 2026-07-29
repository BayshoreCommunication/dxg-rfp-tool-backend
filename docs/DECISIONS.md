# Architectural Decisions

> Purpose: concise register of accepted, durable decisions. Last updated: 2026-07-29. Owner: engineering/product.

| Decision | Rationale / consequence |
|---|---|
| MongoDB remains proposal-content authority. | Avoids a destructive product migration; PostgreSQL references proposals and owns the AI domain. |
| PostgreSQL owns durable AI state; Redis is transport only. | RLS, auditability, recovery, and reference-only queue messages. |
| Canonical `proposal.v1` contract with generated types. | One validated shape across API, AI, UI, and tests while legacy adapters preserve compatibility. |
| Canonical migration uses immutable snapshots, not in-place rewrites. | Dry-run, review, idempotency, and rollback without touching legacy records. |
| AI provider access uses a governed port and pinned model snapshot. | Provider replacement, deterministic release evidence, budget controls, and no hidden legacy endpoint. |
| Safe empty-field candidates may auto-apply. | Reduces planner effort; requires confidence ≥0.8, one candidate, validation, empty target, and version safety. This policy change still needs explicit DXG confirmation. |
| Publication is always human-controlled. | AI assistance must not become autonomous procurement action. |
| Investment guidance is deterministic and may refuse. | No fabricated numbers; disclose baseline provenance and unsupported categories. |
| Knowledge uses approved immutable releases. | Retrieval eligibility is tenant-scoped and excludes revoked/superseded content. |
| Client source content is untrusted data. | Prompt injection controls, strict schemas, citation allowlists, and minimized provider payloads. |
| Evaluation weightings reach vendors only once the planner confirms them (2026-07-29). | The matrix ships pre-populated and vendors are scored on it, so an untouched default set must not be published or cited as the client's criteria. `budget.evaluationMatrixConfirmed` gates both the RFP table and draft evidence; editing any weight counts as confirming. |
| Schedule times are venue wall-clock, anchored to the event's time zone (2026-07-29). | Building instants in the browser's zone stored the wrong moment for any planner working outside the venue zone, and the RFP quoted vendors those times. Storage, the pickers, and draft evidence all resolve against the event zone; an unknown zone keeps machine-local behaviour. |
| Structured-output schemas use only keywords strict mode accepts (2026-07-29). | `uniqueItems` in the conversation reply schema failed every request with a 400, and because provider errors fall back silently the feature looked implemented while no planner ever received a model reply. Enforce bounds after parsing, and keep `tests/live-ai-schema-keywords.test.js` green. |
| Draft edits autosave; published proposals do not (2026-07-29). | The wizard held every step in memory with one save on the last page, so a refresh discarded hours of work. Background writes are confined to unsubmitted drafts so they can never alter what vendors already see; `Update RFP` stays explicit. |
| Expiry is a published-proposal lifecycle (2026-07-29). | `isActive` defaults to true, so an unsubmitted draft was warned about and then closed as `rejected` a week after creation. The sweep now excludes `status: "unsubmitted"`. |

Historical ADRs and decision registers are preserved in `archive/2026-07/pre-consolidation-root/`.
