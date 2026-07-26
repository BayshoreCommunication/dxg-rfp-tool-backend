# RFPilot Backend Modular Source

New Milestone 1 code is introduced here while legacy top-level routes remain compatible.

Each business module follows inward dependencies:

```text
http/workers -> application -> domain
infrastructure -> application/domain ports
```

- `domain/` contains entities, value objects, policies, and ports without Express, MongoDB, PostgreSQL, Redis, storage, or AI SDK dependencies.
- `application/` contains use cases, authorization decisions, orchestration, and transaction boundaries.
- `infrastructure/` contains persistence and external-service adapters.
- `http/` contains versioned routes, validated transport contracts, and error/status mapping.
- `workers/` contains durable job consumers that call application use cases.

Legacy code is migrated behind adapters one authorized slice at a time. New code must not import from `controller/`, `modal/`, or other legacy implementation directories.
