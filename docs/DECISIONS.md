# Architectural Decisions

> Purpose: concise register of accepted, durable decisions. Last updated: 2026-08-10. Owner: engineering/product.

| Decision | Rationale / consequence |
|---|---|
| MongoDB remains proposal-content authority. | Avoids a destructive product migration; PostgreSQL references proposals and owns the AI domain. |
| The PostgreSQL identity projection is created at sign-in, not at signup (2026-08-10). | Nothing projected MongoDB accounts into `rfpilot.users`, so every new signup authenticated and then got 503 `ASSISTANT_ACTOR_NOT_READY` from the assistant, drafts, guidance and every other AI surface. Projecting in `beginAuthenticatedSession` covers all five auth entry points with one hook and also repairs accounts created earlier, on their next sign-in. The projection returns failures as outcomes instead of throwing, because an unavailable data foundation must degrade to "AI is off for now" rather than "you cannot sign in"; the AI modules already fail closed. It never reactivates a suspended organization or removed user, so revoked access cannot restore itself by signing in. `npm run backfill:identity-projections` repairs the existing population without waiting for sign-ins. |
| PostgreSQL owns durable AI state; Redis is transport only. | RLS, auditability, recovery, and reference-only queue messages. |
| Canonical `proposal.v1` contract with generated types. | One validated shape across API, AI, UI, and tests while legacy adapters preserve compatibility. |
| Canonical migration uses immutable snapshots, not in-place rewrites. | Dry-run, review, idempotency, and rollback without touching legacy records. |
| AI provider access uses a governed port and pinned model snapshot. | Provider replacement, deterministic release evidence, budget controls, and no hidden legacy endpoint. |
| Extracted field candidates never auto-apply. | Every candidate remains read-only until the owner reviews individual current/proposed values and explicitly confirms application. The client-side auto-apply hook was removed; the backend's `automatic` path still exists behind `AUTO_APPLY_MIN_CONFIDENCE` but is uncalled. |
| Room recommendations are the one unattended application path. | Deterministic room suggestions fill **empty** allowlisted room fields without prior approval, so the planner adjusts values in the form instead of approving each. Bounded by: filled fields never overwritten, allowlisted paths only, crew appends only, version CAS plus per-room identity checks, and an audit row per application. Pending explicit DXG confirmation — see `architecture/ROOM_RECOMMENDATIONS.md`. |
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
