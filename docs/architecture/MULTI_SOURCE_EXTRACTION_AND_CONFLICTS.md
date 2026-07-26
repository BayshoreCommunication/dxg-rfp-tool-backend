# Slice 3D — Multi-source Extraction and Conflicts

Slice 3D extends the governed proposal-source path to two through five ready, explicitly non-confidential sources. A durable run stores an immutable ordered source set. The worker revalidates every source against tenant, owner, proposal, readiness, deletion, and classification policy before reading any bytes.

OpenAI receives bounded fragments with opaque evidence aliases and returns cited candidates. RFPilot deterministically groups candidates by canonical path and emits a blocking `CROSS_SOURCE_CONFLICT` issue when a field has multiple distinct normalized values. Conflicting candidates remain pending for human review; no value is selected automatically.

PostgreSQL remains authoritative for run/source/evidence/conflict metadata. Redis messages contain run references only. MongoDB is unchanged unless a user later completes the existing explicit, version-checked review and application flow. No proposal is published automatically.

Limits: maximum five sources, maximum 100 total evidence fragments, existing provider token ceilings, rate limits, usage monitoring, and kill switches. Confidential/restricted sources, knowledge-corpus mixing, pricing interpretation, and automatic conflict resolution remain excluded.
