# DXG Approval Pack — Slice 2C Governed Knowledge Retrieval

## Purpose

Slice 2C will let the test system find relevant fragments from an approved DXG knowledge release and return them with source citations. It is the bridge between knowledge administration and future proposal AI.

```text
Approved DXG release
        ↓
Tenant and validity checks
        ↓
Lexical + semantic retrieval
        ↓
Ranked approved fragments
        ↓
Verifiable source citations
```

It does **not** create or change a proposal, train a model, call a live AI provider, or enable production use.

## Recommended defaults

- Isolated test environment only.
- PostgreSQL remains authoritative and uses `pgvector`; no external vector database.
- Redis/BullMQ messages contain references only.
- Initial embedding adapter is deterministic, local/mock, and uses synthetic fixtures only.
- Approved DXG-internal knowledge remains lexical-only unless DXG separately authorizes embedding processing.
- Retrieval is disabled by default and controlled by a backend feature flag.
- Results default to 10 and cannot exceed 20.
- Every result must have a valid source citation.
- Current release state is checked on every query.
- Revoked, expired, superseded, rejected, unapproved, and cross-organization content is never eligible.
- Retrieval output is advisory evidence and is never applied to a proposal.

## What DXG can test

1. Publish an approved synthetic knowledge release.
2. Create its test retrieval index.
3. Run a fixed test query.
4. See the most relevant approved fragments.
5. Verify each fragment’s source and coordinates.
6. Revoke a release and confirm it immediately disappears.
7. Confirm another organization cannot retrieve it.

## Safeguards

- PostgreSQL forced row-level security and existing permission checks.
- Explicit feature flags and versioned policy records.
- Content-free queue messages, logs, metrics, and traces.
- Embeddings inherit source classification and are never returned by API.
- Live release eligibility is trusted instead of stale index state.
- Immutable checksums and release manifests.
- Bounded inputs, outputs, timeouts, retries, and rate limits.
- Deterministic relevance, citation, isolation, revocation, and recovery tests.

## Decisions requested

Please confirm:

1. PostgreSQL with `pgvector` is acceptable in the isolated test environment.
2. Deterministic mock embeddings and synthetic fixtures are acceptable initially.
3. DXG-internal releases remain lexical-only unless separately approved for embedding.
4. Recall@10 ≥ 0.90 and MRR@10 ≥ 0.80 are acceptable synthetic-fixture targets.
5. Ten results by default and twenty maximum are acceptable.
6. Pricing, contracts, customer-confidential, and vendor-confidential sources remain blocked from semantic indexing.
7. Proposal drafting/mutation, live-provider processing, and production remain separately gated.

## Approval statement

> DXG approves the Slice 2C governed-knowledge-retrieval design and authorizes isolated test-environment implementation using the defaults in this approval pack. PostgreSQL remains authoritative and may use `pgvector`; Redis/BullMQ carries reference-only indexing messages; initial vector execution uses the deterministic mock embedding adapter and synthetic fixtures only; approved DXG-internal knowledge remains lexical-only unless separately authorized. Every result must be tenant-scoped, currently eligible, checksum-verifiable, and source-cited. Live-provider processing, confidential-data embeddings, pricing or contract semantic indexing, proposal drafting, proposal auto-application, production provisioning, and external telemetry or alerts remain separately gated.

## After approval

Implementation proceeds milestone by milestone:

1. PostgreSQL schema, RLS, policies, and migration.
2. Deterministic durable indexing job and worker.
3. Hybrid retrieval API and citation builder.
4. Synthetic evaluation, security, operations, and recovery evidence.
5. DXG test-environment acceptance review.

