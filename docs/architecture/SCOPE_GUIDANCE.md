# Deterministic Scope Guidance

## Boundary

Scope guidance is a deterministic extension of the versioned proposal-analysis
report. It evaluates only the authenticated, owner-scoped proposal snapshot
already loaded by the guidance module. It does not call an AI provider, infer
prices, modify proposal fields, publish, send, or reserve equipment.

The general Platform AI Assistant does not receive these private findings.
They remain in the proposal workspace and use the existing `proposal:read`
authorization boundary.

## Versioned rule registry

`scope-guidance.v1` exposes an immutable registry. Every rule declares:

- a stable rule ID and version;
- its category and default severity;
- applicability conditions and required inputs;
- affected proposal fields;
- an authoritative internal source label; and
- a pure evaluator that returns evidence-backed findings.

The registry covers missing dependencies, quantity mismatches, possible
duplication, and items that require explicit confirmation. Current checks
include display surfaces, camera/operator capacity, recording delivery,
streaming connectivity and ownership, audience Q&A, playback control, video
lighting, wireless-channel capacity, rigging, venue-provided equipment, and
labor/access constraints.

## Findings and uncertainty

Each finding preserves the proposal-analysis stable ID, explanation, next
step, evidence, proposal version, and analysis version. Scope-specific
metadata adds:

- `scopeCategory`;
- `scopeSeverity`; and
- an optional bounded confirmation `question`.

The engine labels uncertainty instead of guessing. Venue, labor, capacity, or
ownership inputs that are not authoritative become confirmation questions.
Inapplicable rules emit no speculative finding.

Granular scope severity maps to the existing proposal-analysis priority for
backward compatibility. The dashboard additionally shows the original scope
severity so users can distinguish a confirmed blocker from a review or venue
confirmation.

## Testing

`tests/scope-guidance.test.js` verifies registry reviewability, stable rule
metadata, room dependencies, camera/operator mismatches, delivery and hybrid
requirements, venue duplication, wireless/rigging/labor confirmations, and
the no-speculation boundary.
