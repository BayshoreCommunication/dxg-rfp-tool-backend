# DXG Approval Pack — Slice 3B Controlled Live-AI Pilot

## What this slice will deliver

Slice 3B will make the first real-model calls through RFPilot’s provider-neutral gateway in the isolated test environment.

The pilot supports:

- cited requirement extraction; and
- cited, read-only proposal draft generation.

It adds provider credentials isolation, data-classification policy, budget controls, rate/concurrency limits, validation, evaluation, durable recovery, content-free telemetry and emergency kill switches.

## Recommended safe starting point

- OpenAI as the initial provider, using `gpt-5.4-mini` through an immutable allowlisted release.
- Synthetic fixtures only for initial execution.
- No arbitrary prompts.
- No confidential, restricted, personal, pricing or contract data.
- No DXG knowledge retrieval.
- No generated-prose application or proposal mutation.
- No automatic publication.
- Maximum two provider attempts with no automatic provider fallback.
- Human review of every visible result.
- Non-confidential DXG fixtures remain disabled until specifically approved.

## Recorded implementation decisions

DXG authorized implementation without further client approval gates on July 21, 2026. OpenAI `gpt-5.4-mini` is selected, the credential is already present in the backend worker environment, and cited extraction plus cited read-only drafting are the only live capabilities. No commercial spend ceiling currently applies; technical ceilings and operational controls remain enforced.

The selected pilot model is `gpt-5.4-mini`. DXG has imposed no commercial spend ceiling for the pilot. Usage will be metered and visible, while each run remains technically bounded to 32,000 input tokens and 4,000 output tokens, with existing concurrency/rate limits and emergency kill switches.

## What DXG will be able to test

1. Run fixed synthetic extraction and drafting fixtures through the selected real model.
2. Compare deterministic and live candidates with citations, validation and cost metadata.
3. Confirm prohibited classifications fail before provider invocation.
4. Confirm another user/tenant cannot access a run.
5. Confirm stale/submitted proposals fail safely.
6. Confirm timeout, throttling, malformed output, worker recovery and budget exhaustion behavior.
7. Activate the kill switch and confirm no new provider calls occur.
8. Confirm MongoDB proposal content and version remain unchanged.

## Authorization statement

> DXG authorizes accelerated Slice 3B isolated test-environment implementation using **OpenAI `gpt-5.4-mini`**. Cited structured extraction and cited read-only proposal drafting are the only live capabilities. No commercial monthly or daily spend ceiling is imposed; usage remains metered, every run is limited to 32,000 input and 4,000 output tokens, and concurrency/rate limits and emergency kill switches remain enforced. PostgreSQL remains authoritative for AI results and usage metadata; Redis/BullMQ carries reference-only jobs; MongoDB remains authoritative and unchanged by live-generated prose. Automatic proposal mutation or publication, production provisioning, Anthropic Claude activation, and unapproved provider/model fallback remain disabled.

## Future Claude support

Claude may be added later through a separate Anthropic adapter. It must have its own secret, provider/model release, privacy review, budget controls, contract tests and gold evaluation. OpenAI failures must not automatically route content to Claude.

## Implementation sequence

Implementation proceeds through additive migration, provider adapter, worker-only secret injection, data policy, budget and kill-switch controls, synthetic evaluation suite, read-only comparison UI, failure/recovery evidence and authenticated manual testing.

Detailed design: [Controlled Live-AI Provider Pilot](../architecture/LIVE_AI_PROVIDER_PILOT.md).
