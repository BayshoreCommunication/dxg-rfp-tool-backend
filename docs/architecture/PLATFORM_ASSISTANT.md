# Platform AI Assistant

> Current implementation record. Last updated: 2026-07-27. Owner: AI engineering.

## Purpose and boundary

The Platform AI Assistant is a read-only guidance capability for RFPilot
navigation, onboarding, proposal workflows, and event-planning concepts. It is
separate from the proposal-specific assistant and cannot edit, publish, send,
archive, or delete product data on a user's behalf.

### Safe workflow handoffs

The general assistant does not receive private proposal content. A
proposal-specific intent produces clarification guidance while the dashboard
offers an owner-scoped proposal selector through a same-origin BFF. That BFF
returns only an opaque proposal ID, bounded display label, and whether the
submitted proposal is eligible for the email workflow. The client constructs
destinations from a fixed allowlist; provider-generated URLs never control
structured actions.

The dedicated proposal assistant route revalidates the proposal through the
authenticated, owner-scoped proposal read before rendering. Editor, email, and
vendor-response destinations retain their existing authenticated guards.
Optionally carried question text uses expiring `sessionStorage`, is consumed
once, and populates an unsent draft only.

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
6. A deterministic-first, versioned intent router classifies obvious requests
   locally. UI context and completed assistant-message intent metadata preserve
   field help and short follow-ups without a second model call.
7. A user message and pending assistant placeholder are persisted
   idempotently. The assistant row stores only bounded intent metadata, never a
   duplicate of the raw prompt.
8. Intent constrains platform facts and whether approved operating guidance is
   retrieved. Unrelated evidence is removed before prompt construction.
9. The prompt builder combines bounded conversation history, versioned
   platform facts, an optional bounded product-generated UI context, and
   eligible approved `operating_guidance`. Normal
   follow-ups select facts from the immediate prior user turn; context-only
   follow-ups walk backward only to the nearest standalone platform topic;
   explicit summaries and “links/pages mentioned” requests use the bounded
   full user history.
10. Approved knowledge is labelled as untrusted evidence. It cannot supply
   instructions, permissions, tools, or links outside the supplied evidence
   contract.
11. The OpenAI adapter uses `store: false`, strict structured output, bounded
   tokens, an HMAC-derived safety identifier, and an attempt row committed
   before every possibly billable call.
12. The controller emits only versioned product SSE events:
   `message.accepted`, `response.started`, `response.delta`,
   `response.completed`, and `response.failed`.
13. Provider output is completed only after response kind, citation IDs, and
   links validate. Links must resolve to the code-reviewed internal platform
   map; when an approved route is safely reused from conversation history, its
   trusted route fact is attached to the completed message automatically.
14. If structured provider output is invalid, the failed provider attempt
    remains ledgered and the application reconciles the visible draft to a
    grounded deterministic completion. Genuine transport failures after a
    delta remain interrupted and retryable.

The browser never receives provider credentials, prompts, provider-native
events, or unrestricted conversation history.

### Bounded UI context

Message requests may include `assistant-ui-context.v1`. The server accepts
only:

- a route category, never a raw URL;
- an approved workflow and ten-section form identifier;
- a canonical field key that exists in the authoritative field registry;
- an event-format enum;
- a short opaque room identifier.

Unknown field keys are removed and marked unknown so the Assistant asks for
clarification. Invalid route, workflow, section, format, or room values reject
the request. Extra object properties are ignored. The context contains no
proposal values and grants no proposal access; it only selects relevant
read-only guidance.

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

Migration `027_platform_assistant_intent` adds the selected intent, router
version, source, and confidence to assistant messages. A database constraint
requires all four values together, and the organization-scoped index supports
privacy-safe quality aggregation without storing raw conversation data in
analytics.

Migration `032_assistant_feedback` adds bounded response-kind,
prompt/knowledge-version, and latency metadata to assistant messages and a
tenant-scoped feedback record for completed assistant responses. Feedback is
updateable and idempotent per user and message. It snapshots only controlled
metadata and cited source identifiers—never the prompt, response, provider
payload, or hidden reasoning. Feedback is an evaluation signal only: it
cannot automatically publish or change prompts, knowledge, rules, or prices.

### Deterministic-first intent routing

`intentRouter.ts` owns the initial versioned taxonomy. High-confidence
greetings, navigation, proposal workflow, field help, proposal-specific,
equipment, budget, historical-reference, action, and unsupported requests are
classified without a provider call. Short follow-ups inherit only a completed
assistant turn's prior intent; otherwise they remain `ambiguous`.

The selected intent is product metadata, not an instruction. It:

- limits trusted platform evidence to approved ID prefixes;
- skips operating-guidance retrieval when the intent does not need it;
- is included in the private provider payload and provider metadata;
- is reclassified from bounded history before final persistence;
- does not grant proposal access or enable any mutation.

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

Platform map v4 records the current guided proposal intake separately from the
optional five-phase proposal-assistant workflow. It covers the displayed intake
sections, the proposal pre-send checklist, and safe user-operated next steps
for read-only action refusals.

### Authoritative form guidance

`proposalFormGuidance.ts` derives its field inventory from the canonical
`proposal.v1` JSON schema instead of maintaining an independent list of field
paths. The registry:

- maps every user-facing canonical leaf to one of the ten verified form
  sections;
- keeps explicit, documented exclusions for generated or non-visible fields;
- exposes a stable canonical field key, type, required/optional/conditional
  status, visibility conditions, dependencies, purpose, entry guidance,
  example, common mistakes, follow-up questions, sources, owner, version, and
  review date;
- converts only a small number of relevant field records into bounded trusted
  evidence for the existing retrieval path;
- returns no evidence for unknown field keys;
- pins the reviewed canonical leaf-path digest in tests, so a schema field
  addition, removal, or rename requires an explicit guidance review.

The registry is read-only. It does not load a proposal or authorize any field
mutation.

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
