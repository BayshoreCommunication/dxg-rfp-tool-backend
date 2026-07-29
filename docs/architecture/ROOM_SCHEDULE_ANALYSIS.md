# Room and Schedule Analysis

## Boundary

`room-schedule-analysis.v1` is a pure deterministic analysis over the
authenticated proposal's room specifications. It is generated and stored with
the existing owner- and organization-scoped proposal readiness report. It does
not invoke a model, assign people or inventory, calculate prices, modify the
proposal, or expose room data to the general Assistant.

## Analysis

For each room, the engine evaluates the canonical legacy inputs currently
available to the guided form:

- room function, layout, attendance, and show window;
- load-in and rehearsal ordering;
- requested room equipment and quantities; and
- requested show-crew roles and quantities.

It returns stable, versioned findings for:

- room-level and schedule-input gaps;
- reversed load-in, rehearsal, and show windows;
- overlapping rooms that need distinct crew for the same role;
- overlapping physical-resource demand that cannot be satisfied by one shared
  item; and
- non-overlapping matching requirements that may be candidates for reuse.

Reuse is never asserted from time alone. The minimum comparison gap is 90
minutes, and every opportunity remains conditional on transport, teardown,
reset, testing, technical, and venue constraints. It is also labeled for
duplicate-rental review without claiming that a vendor quote contains a
duplicate.

## Pricing boundary

The report includes one room-subtotal envelope per room and one shared-services
subtotal envelope. In this phase their state is `pricing_not_evaluated`, with
null amount and currency. The deterministic budget phase is the only component
allowed to populate those values from approved pricing authority.

## Persistence and compatibility

Migration `036_room_schedule_analysis` adds a JSON-object column to
`guidance_reports` and advances the report engine default to
`proposal-analysis.v3`. Existing reports remain readable with an empty room
analysis. New room/schedule findings are also mapped into the existing findings
list so existing severity grouping and form-step navigation continue to work.
