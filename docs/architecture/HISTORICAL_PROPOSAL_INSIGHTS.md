# Historical proposal insights

Phase 8 adds a deterministic, read-only comparison between the current
proposal and one to five historical proposals explicitly selected by the
signed-in user.

## Data flow

1. The browser lists the signed-in user's active proposals through the existing
   owner-scoped proposal list.
2. The user explicitly selects references and requests a comparison.
3. The backend validates the request, the current proposal, and every reference
   against the active organization, owner, and archive state.
4. PostgreSQL proposal references are checked again inside the report
   transaction.
5. A pure comparison function evaluates structural presence only.
6. The persisted report contains section statuses, bounded suggestions, opaque
   reference labels, versions, and provenance. It contains no raw proposal
   content.
7. Reading a stored report revalidates every linked proposal. Archived,
   deleted, moved, or inaccessible references make the report unavailable.

## Privacy boundary

The comparison excludes client names, event names, contacts, email, phone,
private notes, uploaded content, confidential identifiers, exact values, and
exact pricing. Historical structure is always labelled as a selected reference,
never as a current-proposal fact. Reports do not become assistant memory.

## Mutation boundary

The feature does not generate candidate field paths, copy values, change the
proposal, publish, send, or invoke a provider. Users must decide whether an
idea applies and manually update the current proposal. Structured review and
explicit application remain a separate later phase.

## Controls

`HISTORICAL_INSIGHTS_ENABLED=true` is required in an AI-authorized environment.
The endpoints also require authentication, `proposal:read`, per-route rate
limits, owner checks, tenant RLS, and an active reference on every request.
