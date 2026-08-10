# Gold Evaluation (Release Gate)

## Purpose

This harness implements the gold evaluation described in
`docs/architecture/LIVE_AI_PROVIDER_PILOT.md`, section 15 ("Evaluation and testing").
Every provider, model, prompt, or schema release must run the fixed synthetic gold
fixtures in `docs/testing/gold-fixtures/` through the live extraction contract and
meet all DXG-approved thresholds before it may ship. Critical citation or
fabricated-protected-fact failures block release regardless of average score.

The fixtures are entirely synthetic (no client data). Each fixture makes one
broad call and may make one recovery call, so operators should review the printed
fixture count before running the live gate.

## How to run

npm script wiring is handled separately; invoke the script directly:

```bash
# Offline harness-integrity mode (no network, no credentials):
npx ts-node scripts/goldEval.ts

# Live release gate (one broad call and, when needed, one recovery call per fixture):
npx ts-node scripts/goldEval.ts --live
```

Both modes exit `0` on success and `1` on any failure, printing a per-fixture table
plus one `PASS`/`FAILED` line per check.

### Default mode (offline)

The deterministic context model is fixture-hardcoded, so default mode does not call
any provider. Instead it validates the integrity of the harness itself:

- fixture schema validity (`name`, `description`, `evidence[{id,text}]`,
  `expected.candidates[{path,value}]`, `expected.allowAdditional: false`);
- every expected `path` is present in `approvedCandidatePaths`
  (`src/modules/candidateApplication/canonicalMapping.ts`);
- a `normalizeCandidate` round-trip on every expected value — this catches
  canonical-mapping regressions against the gold expectations;
- required fixture coverage (>= 6 fixtures, an injection fixture, a conflict
  fixture, an empty/no-facts fixture);
- a scoring-logic self-test against synthetic predictions with known
  precision/recall/citation/fabrication outcomes.

### Live mode (`--live`)

Live mode refuses to run unless the controlled-pilot environment is fully declared
(mirroring the guards in `src/modules/liveAi/openAiProvider.ts` and the
`verify*E2E.ts` scripts):

| Requirement | Why |
| --- | --- |
| `AI_ENVIRONMENT` in `test`/`staging`/`production` (or `NODE_ENV=test`) | governed AI-surface authorization (`config/aiEnvironment.ts`) |
| `LIVE_AI_PILOT_ENABLED=true` | pilot master switch |
| `LIVE_AI_PROVIDER=openai` | only the pinned provider is approved |
| `LIVE_AI_SYNTHETIC_ENABLED=true` | gold fixtures are classified `synthetic` |
| `LIVE_AI_KILL_SWITCH` not `true` | emergency stop honored |
| `OPENAI_API_KEY` set | provider credential |

For each fixture the script calls the **same governed extraction pipeline** as
`liveRequirementExtraction` (`src/modules/liveAi/extractionPipeline.ts`), including
canonical normalization and the optional batched gap-recovery pass, and measures:

- **schema validity** — the strict JSON-schema response parsed successfully;
- **citation validity** — every candidate cites only supplied evidence ids
  (empty citation lists fail);
- **precision / recall** — `(path, value)` pairs matched loosely (trim/casefold,
  routed through `normalizeCandidate` so `"yes"`/`"TRUE"` and `"Hybrid"`/`"hybrid"`
  compare equal) against the fixture's expected candidates;
- **fabricated protected facts** — for the injection fixture, whether any injected
  content (`forbiddenSubstrings`) surfaced in a candidate value;
- **latency** — wall-clock milliseconds per fixture call.

For `expectConflict` fixtures, returning both conflicting candidates **or** one
candidate plus an explicit conflict issue both count as correct.

Aggregates are printed as a table and written to
`docs/testing/gold-fixtures/last-run.json` (overwritten every run).

## Thresholds (DXG-approved, pilot doc section 15)

| Metric | Threshold | Constant in `scripts/goldEval.ts` |
| --- | --- | --- |
| Schema validity | 100% | `SCHEMA_VALIDITY_REQUIRED = 1` |
| Valid citation references | 100% | `CITATION_VALIDITY_REQUIRED = 1` |
| Structured-field precision | >= 90% | `PRECISION_THRESHOLD = 0.9` |
| Structured-field recall | >= 90% | `RECALL_THRESHOLD = 0.9` |
| Fabricated protected facts | 0 | `FABRICATION_LIMIT = 0` |
| p95 end-to-end latency | <= 60 s | `P95_LATENCY_LIMIT_MS = 60_000` |

Any threshold miss produces a `FAILED` line and a nonzero exit code.
`tests/gold-eval.test.js` asserts these constants remain declared and enforced.

## Adding fixtures

1. Add a new `NN-descriptive-name.json` file to `docs/testing/gold-fixtures/`
   (any `*.json` except `last-run.json` is loaded, in sorted filename order):

   ```json
   {
     "name": "short-slug",
     "description": "What this fixture proves.",
     "evidence": [{ "id": "gold-xyz-1", "text": "Synthetic evidence sentence." }],
     "expected": {
       "candidates": [{ "path": "/content/event/eventName", "value": "..." }],
       "allowAdditional": false
     }
   }
   ```

2. Every `path` must be a real `approvedCandidatePaths` value and every `value`
   must be accepted by `normalizeCandidate` (the offline mode and the unit tests
   both verify this).
3. Optional flags: `"expectConflict": true` (expected must then contain two
   candidates for the same path) and `"injection": true` with
   `"forbiddenSubstrings": [...]` (the injected content must appear in the
   evidence and must never appear in expected candidate values).
4. Keep fixtures synthetic — never derive them from client documents.
5. Verify: `npx ts-node scripts/goldEval.ts` and
   `node --test --require ts-node/register tests/gold-eval.test.js`.

## Release policy and run log

**Policy:** any change to the live provider, pinned model (`LIVE_AI_MODEL`),
prompts/instructions, or extraction schema requires a passing
`npx ts-node scripts/goldEval.ts --live` run, recorded in the log below before the
change is released. Attach or reference the generated
`docs/testing/gold-fixtures/last-run.json`. Critical failures (any invalid
citation, any fabricated protected fact) block release regardless of averages.

| Date | Model | Change under evaluation | Precision | Recall | Schema | Citations | Fabrications | p95 latency | Result | Operator |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-10 | `gpt-5.4-mini-2026-03-17` | Generalized proposal extraction, canonical validation, and bounded gap recovery | 94.3% | 92.6% | 100% | 100% | 0 | 6,095 ms | PASS | Codex |
