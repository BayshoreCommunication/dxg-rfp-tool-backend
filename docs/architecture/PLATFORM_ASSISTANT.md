# Platform AI Assistant

> Current implementation record. Last updated: 2026-07-27. Owner: AI engineering.

## Purpose and boundary

The Platform AI Assistant is a read-only guidance capability for RFPilot
navigation, onboarding, proposal workflows, and event-planning concepts. It is
separate from the proposal-specific assistant and cannot edit, publish, send,
archive, or delete product data on a user's behalf.

The bounded module lives under `src/modules/platformAssistant/`. Its
application and domain layers depend on ports for persistence, approved
knowledge, generation, attempt accounting, and operational limits. Express
routes and OpenAI/PostgreSQL/Redis implementations remain adapters.

## Request flow

1. The authenticated `/api/v1/assistant` route requires `assistant:use`.
2. `AI_ENVIRONMENT`, `AI_ASSISTANT_ENABLED`, and
   `AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` are checked before organization
   access proceeds. Production access fails closed without an explicit cohort.
3. `GET /api/v1/assistant/access` exposes only the current organization's
   launcher eligibility; provider and history data are not returned.
4. Thread and message access is scoped to both organization and owning user.
5. The Assistant kill switch blocks new messages while preserving allowed
   organizations' read-only history access.
6. A user message and pending assistant placeholder are persisted
   idempotently.
7. The prompt builder combines bounded conversation history, versioned
   platform facts, and eligible approved `operating_guidance`.
8. Approved knowledge is labelled as untrusted evidence. It cannot supply
   instructions, permissions, tools, or links outside the supplied evidence
   contract.
9. The OpenAI adapter uses `store: false`, strict structured output, bounded
   tokens, an HMAC-derived safety identifier, and an attempt row committed
   before every possibly billable call.
10. The controller emits only versioned product SSE events:
   `message.accepted`, `response.started`, `response.delta`,
   `response.completed`, and `response.failed`.
11. Provider output is completed only after response kind, citation IDs, and
   links validate against supplied evidence.

The browser never receives provider credentials, prompts, provider-native
events, or unrestricted conversation history.

## Persistence and isolation

Migration `026_platform_assistant` owns:

- `assistant_threads`;
- `assistant_messages`;
- organization RLS policies and forced RLS;
- owner-oriented and idempotency indexes;
- message lifecycle, content, citation, and token constraints;
- a composite organization/thread foreign key;
- `platform_assistant` provider-attempt support.

PostgreSQL is authoritative for conversation history. Repository predicates
add same-organization owner checks on top of RLS, so another user in the same
organization cannot read or mutate a personal thread.

## Knowledge extension

`PlatformAssistantKnowledgeSource` is the expansion boundary. The current
PostgreSQL adapter accepts only eligible approved `operating_guidance` from an
active embedding-model release. Eligibility includes organization, approved
batch, policy purpose, environment, activation window, expiry, classification,
and source type.

New sources must be added behind this port and must preserve:

- stable evidence and citation IDs;
- explicit eligibility rules;
- bounded excerpts and result counts;
- untrusted-evidence labelling;
- output citation/link validation;
- graceful degradation to versioned platform facts.

## Streaming and retry rules

- User-message and assistant-response idempotency keys are separate.
- A network retry before acceptance reuses both keys.
- An explicit response retry reuses the user key and rotates the response key.
- Provider retry is allowed only before the first visible delta.
- Closing the owning POST stream aborts the provider request.
- Partial output becomes `ASSISTANT_STREAM_INTERRUPTED`.
- Assistant message terminal states are immutable.
- Token-by-token database writes are prohibited.

## Operational controls

The capability is deny-by-default. Relevant controls are documented in
`.env.example`:

- environment authorization, feature flag, and kill switch;
- production organization allowlist, with an explicitly approved `*` sentinel
  reserved for all-organization rollout;
- approved model, reasoning effort, verbosity, and token ceilings;
- per-user and per-organization rate limits;
- per-user and per-organization active-stream limits;
- lease, timeout, heartbeat, and provider-attempt limits.

Redis provides atomic rate and concurrency enforcement with hashed identities.
A transient Redis outage falls back to a bounded per-instance limiter.

The approved runtime model remains `gpt-5.4-mini-2026-03-17` unless
`AI_ASSISTANT_MODEL` is explicitly promoted through the release process. Model
evaluation never mutates runtime configuration.

## Frontend boundary

The dashboard exposes a compact non-modal helper from the sidebar footer.
The authenticated layout combines its public build flag with the backend
organization-access result before rendering the launcher. Typed server actions
own durable reads and mutations. A same-origin BFF route owns streamed POST
requests and attaches backend authentication server-side. The feature-local
reducer owns only optimistic, streaming, retry, scroll, sheet, and draft state.

See the dashboard's `docs/architecture/README.md` and
`docs/user-guides/AI_ASSISTANT.md`.

## Release and recovery

Use [Platform Assistant rollout](../runbooks/PLATFORM_ASSISTANT_ROLLOUT.md) for
release records, smoke tests, kill-switch verification, rollback, monitoring,
and the staged-rollout gates. Use
[Platform Assistant environment setup](../runbooks/PLATFORM_ASSISTANT_ENVIRONMENT.md)
for deployment variables and migration activation.
