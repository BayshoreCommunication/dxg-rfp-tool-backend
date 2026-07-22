# ADR-001 — Canonical Proposal Contract Ownership

**Status:** Accepted and implemented as the Slice 1A contract foundation; migration remains in progress  
**Date:** July 15, 2026  
**Decision owners:** Client authorization in workspace thread; Bayshore technical implementation

## Context

RFPilot has divergent proposal definitions in the active frontend wizard, older frontend types, public renderer, backend model/controllers, and AI extraction prompt. Most persisted sections are untyped MongoDB `Mixed` values. AI-assisted workflows require one validated, versioned representation with explicit compatibility behavior.

## Decision

1. Adopt `proposal.v1` as a JSON-Schema-based canonical contract.
2. Generate TypeScript types rather than maintaining independent handwritten proposal interfaces.
3. Separate proposal content, resource/lifecycle metadata, presentation snapshot, and AI workflow evidence.
4. Normalize dates, counts, money, dimensions, booleans, identifiers, and source references into typed values.
5. Treat AI extraction as cited candidate patches requiring validation and human/application-service acceptance.
6. Preserve current proposals and routes using deterministic legacy adapters during staged migration.
7. Publish a separate allowlisted public projection.
8. Reject unknown properties at external and AI trust boundaries.

The detailed field reconciliation is recorded in [Canonical Proposal Contract v1 Analysis](./RFPilot_AI_Canonical_Proposal_Contract_v1_Analysis.md).

## Options considered

### Continue using frontend TypeScript types

Low initial effort, but they are unavailable as runtime validation, already duplicated, and include UI-oriented strings. Rejected.

### Use the Mongoose model as the contract

Keeps persistence central, but most sections are `Mixed`, persistence concerns leak into API/AI/UI, and frontend generation remains weak. Rejected.

### Introduce GraphQL as the canonical schema immediately

Provides typed queries but adds a large transport/runtime change before domain reconciliation and does not by itself solve JSON/AI validation. Deferred.

### JSON Schema with generated types and compatibility adapters

Supports API runtime validation, AI structured output, fixtures, documentation, and cross-language tooling while allowing incremental migration. Selected.

## Consequences

### Positive

- One versioned definition for API, AI, UI, tests, and public projections.
- Runtime rejection of malformed or unexpected content.
- Explicit migrations and safer AI application.
- Typed values support deterministic guidance and pricing.

### Costs and risks

- Initial field reconciliation and compatibility mapping are substantial.
- Existing records may contain ambiguous/invalid strings requiring migration warnings.
- Contract distribution across two repositories needs a checksum/release mechanism until a shared package is established.
- Public and internal projections must be maintained deliberately.

## Implementation controls

- No destructive legacy migration in Slice 1A.
- Contract and adapters land behind compatibility tests.
- Schema/version changes require ADR review and synchronized documentation.
- The existing proposal workflow remains functional until its canonical path passes regression and acceptance tests.
