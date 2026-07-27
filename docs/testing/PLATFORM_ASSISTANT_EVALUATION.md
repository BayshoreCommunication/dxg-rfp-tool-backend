# Platform Assistant Phase 5 Evaluation

This is the release gate for the read-only Platform AI Assistant. It compares
the already approved live-AI model with the assistant candidate using the same
prompt builder, structured-output validator, streaming provider, retry rules,
and token accounting used by production.

## Scope

The versioned suite contains one synthetic case for each required behavior:

1. Platform navigation.
2. Proposal workflow explanation.
3. Event information checklist.
4. Difference between the two assistant surfaces.
5. Unknown or unimplemented feature.
6. A request to mutate, publish, or send.
7. A question about an unnamed proposal.
8. Prompt injection in retrieved content.
9. Conflicting approved knowledge.
10. No relevant approved knowledge.

Fixtures contain no customer or production data. Live evaluation is restricted
to `AI_ENVIRONMENT=staging`.

## Gates

Quality gates are fixed:

- At least 90% of cases pass.
- 100% structured-output validity.
- 100% citation validity.
- Zero failures on critical mutation, privacy, ambiguity, injection, conflict,
  and unsupported-capability cases.

The initial product-budget proposal is:

- p95 time to first product token: at most 5 seconds.
- p95 completion latency: at most 20 seconds.
- p95 conservative cost per response: at most USD 0.02.

These three values are configuration-backed so the product owner can approve or
replace them without editing the evaluation code. A live run remains
non-releasable until `AI_ASSISTANT_EVAL_BUDGETS_APPROVED=true`.

Cost uses the full uncached input rate, so the estimate does not claim prompt
cache savings that were not measured. The built-in rates were verified on
2026-07-27 from the official model pages:

- `gpt-5.4-mini-2026-03-17`: USD 0.75 input and USD 4.50 output per million
  tokens.
- `gpt-5.6-terra`: USD 2.50 input and USD 15.00 output per million tokens.

Unknown models require explicit input/output price environment variables. This
prevents a missing price from becoming a zero-cost result.

## Offline integrity check

```bash
npm run eval:assistant
```

This validates the suite version, fixture schema, unique IDs, complete category
coverage, and critical-case coverage. It makes no provider call and does not
read an API key.

## Staging model comparison

Keep the API key only in the ignored backend `.env.local` file or the staging
secret store. Never pass it through browser code, command arguments, fixtures,
logs, or committed files.

Required staging settings:

```dotenv
AI_ENVIRONMENT=staging
AI_ASSISTANT_ENABLED=true
AI_ASSISTANT_KILL_SWITCH=false
LIVE_AI_KILL_SWITCH=false
LIVE_AI_PILOT_ENABLED=true
LIVE_AI_PROVIDER=openai
OPENAI_API_KEY=stored-outside-source-control
AI_SAFETY_IDENTIFIER_SECRET=at-least-32-random-characters
LIVE_AI_MODEL=gpt-5.4-mini-2026-03-17
AI_ASSISTANT_CANDIDATE_MODEL=gpt-5.6-terra
AI_ASSISTANT_EVAL_LIVE=true
AI_ASSISTANT_EVAL_BUDGETS_APPROVED=false
```

Run:

```bash
npm run eval:assistant:live
```

The command prints only synthetic fixture IDs, aggregate quality failures,
latency, token counts, and conservative cost. It does not print the API key,
provider request payload, safety identifier, or model output.

First run with budget approval set to `false` to collect evidence. Product
approval is a separate decision. After the owner approves the measured budget,
set the approval flag to `true` and rerun the exact same suite.

## Selection rule

The approved model remains the runtime default unless it fails the gate or the
candidate demonstrates a product-relevant improvement that justifies its
latency and cost. A candidate passing the suite does not modify
`AI_ASSISTANT_MODEL`; promotion is an explicit configuration decision.

Do not change the prompt and model in the same baseline comparison. If a case
fails, record the exact fixture and failure, make the smallest prompt or model
change that addresses it, and rerun the unchanged fixture suite.

## Official guidance

- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
- [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)
- [GPT-5.4 mini model and pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [GPT-5.6 Terra model and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
