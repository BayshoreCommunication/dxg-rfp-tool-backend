# Conversational Proposal Workspace (M2)

**Status:** Implemented behind `CONVERSATIONS_ENABLED` + `AI_ENVIRONMENT` authorization
**Depends on:** proposal context (Slice 2D/3C), draft generation (2F), candidate application (2E), private document ingestion (1D), durable jobs (1E)

## Design

The chat is a front door over the existing governed run types, not a new AI
engine. Every assistant turn is backed by a `proposal_context` or
`proposal_draft` run, so citations, schema validation, human review, version
CAS, and MongoDB authority are inherited rather than reimplemented. Plain chat
messages and pasted notes are stored as data; no arbitrary-prompt endpoint
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
| POST | `/api/v1/proposals/:id/conversation/messages` | Idempotent message; intent `chat`/`extract_requirements`/`generate_draft` creates the corresponding governed run |
| PATCH | `/api/v1/proposals/:id/conversation/questions/:qid` | Answer or dismiss a clarification question |
| GET | `/api/v1/proposals/:id/conversation/events` | SSE status stream (update/reconnect events, 2s server-side poll, 5-min lease) |
| POST | `/api/v1/proposals/:id/notes` | Pasted notes stored as a private `.txt` source through the standard quarantine/scan boundary |

All routes require authentication + `proposal:read`/`proposal:write` action
authorization and rate limits. Run creation reuses the existing repository
idempotency, so a retried request cannot double-create runs or messages.

## Recovery model

Assistant messages are `pending` until their run reaches a terminal state;
`read`/`snapshot` materialize final content write-on-read, so refresh, worker
restart, or SSE disconnect never lose progress. Clients fall back from SSE to
backoff polling; both paths converge on the same persisted state.

## Boundaries preserved

- No proposal mutation: field application still flows through candidate review (2E).
- No automatic publication.
- Notes and uploads share one classification-gated source pipeline; only
  explicitly `non_confidential`, malware-scanned sources reach the live model.
