# Conversational Proposal Workspace (M2)

**Status:** Implemented behind `CONVERSATIONS_ENABLED` + `AI_ENVIRONMENT` authorization
**Depends on:** proposal context (Slice 2D/3C), draft generation (2F), candidate application (2E), private document ingestion (1D), durable jobs (1E)

## Design

The chat is a front door over the existing governed run types, not a new AI
engine. Extraction and drafting turns are backed by `proposal_context` or
`proposal_draft` runs, so citations, schema validation, human review, version
CAS, and MongoDB authority are inherited rather than reimplemented. Plain chat
uses a durable `conversation_chat` job with a persisted assistant placeholder;
messages and pasted notes are stored as data and no arbitrary-prompt endpoint
exists.

## Entities (migration 017, all RLS-forced)

- `conversations` — one per proposal (`UNIQUE(proposal_reference_id)`), owner-scoped.
- `conversation_messages` — ordinal-ordered turns; `UNIQUE(conversation_id,ordinal)`;
  idempotency via partial unique index on `(conversation_id,idempotency_key)`;
  assistant turns reference `run_type`/`run_id`/`job_id` and start `pending`.
- `conversation_message_attachments` — links messages to `document_sources`.
- `clarification_questions` — extraction issues promoted to a lifecycle
  (`open → answered | dismissed | superseded`); answered questions link the
  answering message. Questions from superseded runs are marked `superseded`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/proposals/:id/conversation` | Conversation + messages + questions (materializes finished runs on read) |
| POST | `/api/v1/proposals/:id/conversation/messages` | Idempotent message; `chat` returns `202` with a durable job/placeholder, while extraction/drafting creates the corresponding governed run |
| PATCH | `/api/v1/proposals/:id/conversation/questions/:qid` | Answer or dismiss a clarification question |
| GET | `/api/v1/proposals/:id/conversation/events` | Legacy backend SSE status stream; the production dashboard uses bounded conversation reads instead of proxying this through Vercel |
| POST | `/api/v1/proposals/:id/notes` | Pasted notes stored as a private `.txt` source through the standard quarantine/scan boundary |

All routes require authentication + `proposal:read`/`proposal:write` action
authorization and rate limits. Run creation reuses the existing repository
idempotency, so a retried request cannot double-create runs or messages.

## Recovery model

The API commits the user message, pending assistant placeholder, `ai_jobs` row,
and outbox event in one PostgreSQL transaction before any provider call. Redis
is delivery only. The worker reloads authoritative state, records the provider
attempt under the pre-existing generation/job ID, retries temporary failures,
and settles the same placeholder. `read`/`snapshot` also materialize terminal
run/job failures, so refresh or worker restart never loses progress. The
production dashboard uses 1s/2s/5s bounded polling while work is pending and a
10s idle interval; visibility changes trigger an immediate refresh.

## Boundaries preserved

- No proposal mutation: field application still flows through candidate review (2E).
- No automatic publication.
- Notes and uploads share one classification-gated source pipeline; only
  explicitly `non_confidential`, malware-scanned sources reach the live model.
