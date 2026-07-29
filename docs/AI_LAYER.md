# AI Layer

> Purpose: current governed AI capabilities and invariants. Last updated: 2026-07-22. Owner: AI engineering.

## Current status

The M1–M6 audit roadmap is implemented behind deny-by-default flags. The pinned provider snapshot is `gpt-5.4-mini-2026-03-17`. Live operations pass through the provider gateway, record usage and validation evidence, and retain human control at conflict review and publication.

## Capability map

| Capability | Inputs | Output/control boundary |
|---|---|---|
| Proposal extraction | Clean eligible files | Cited candidates restricted to 112 canonical scalar paths; invalid/conflicting values do not apply. |
| Conversation | Messages, pasted notes, attachments | Durable message/SSE workspace; typed-message extraction remains unbuilt. |
| Draft generation | Proposal fields plus eligible knowledge | Cited sections with scoped regeneration and review state. |
| Knowledge retrieval | Approved active fragments | Tenant-scoped lexical/vector results from a release registry. |
| Guidance | Canonical proposal facts | Deterministic completeness and rule findings. |
| Room recommendations | Confirmed room/event facts plus approved knowledge fixtures | Deterministic, classified, review-gated suggestions; explicit selective application to a tiny allowlisted room-field set with version and room-identity checks. See [architecture/ROOM_RECOMMENDATIONS.md](architecture/ROOM_RECOMMENDATIONS.md). |
| Investment guidance | Approved pricing corpus and factors | Deterministic estimate or explicit refusal; never invent a number. |
| Vendor analysis | Clean vendor response sources | Cited findings and escalation flags; comparison/export remain gaps. |

## Pricing model

The proprietary baseline v3 workbook contains 433 items, 22 regional factors, 13 modifiers, and 13 confidence rules. It is imported by operator-supplied path and is never committed. Package templates select representative approved records, then apply regional, multi-day, union, in-house, and service-charge factors. The worked Chicago example reproduced within 0.56%. All current records are baseline-tier, so estimates must disclose that they are not calibrated to DXG actuals.

## Non-negotiable invariants

- Never fabricate pricing or a protected fact.
- Validate structured output and citations against supplied evidence IDs.
- Treat source content as untrusted data and ignore embedded instructions.
- Keep tenant isolation and proposal ownership checks at every read/write boundary.
- Auto-apply only validated, high-confidence, single candidates into empty draft fields; use optimistic version checks.
- Require human action for conflicts and publication.
- Record provider attempts before calls to close duplicate-charge windows.
- Build structured-output schemas only from keywords strict mode accepts. A
  rejected keyword fails the whole request, and because every call site softens
  provider errors into a fallback, the feature silently stops using the model
  instead of erroring. `uniqueItems` disabled live conversation replies
  entirely; `tests/live-ai-schema-keywords.test.js` guards the list.
- Present stored values in the form the reader expects before they become
  evidence. Schedule fields are UTC instants, so the drafting model printed the
  UTC clock face and labelled it with the event's zone until draft evidence
  carried the venue reading.

## Open gaps

Array/room extraction, weighted completeness, invalid-operation UI, vendor attempt-ledger coverage, bid comparison, report export, and a written OpenAI-versus-Anthropic comparison remain open. Typed chat extraction shipped behind `CONVERSATION_EXTRACTION_ENABLED` (2026-07-29). Room recommendations partially offset the room gap with a review-first deterministic capability (crew application, production knowledge retrieval, and any AI enrichment stage remain deferred). See [ROADMAP.md](ROADMAP.md).

## Detailed references

Use `architecture/` for implementation mechanics and `testing/GOLD_EVALUATION.md` for the release gate. Original slice status labels in those records are historical and do not override this document or [PROJECT_STATE.md](PROJECT_STATE.md).
