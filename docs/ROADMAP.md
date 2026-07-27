# Roadmap

> Purpose: prioritized remaining work. Last updated: 2026-07-22. Owner: product/engineering.

## Client closure

1. Write and approve the provider comparison; close the 2.5-point recall gap or document the accepted exception.
2. Run founder-reviewed acceptance with the SOW assets and vendor responses.
3. Resolve the pricing-factor and questionnaire questions in [CLIENT_SCOPE.md](CLIENT_SCOPE.md).
4. Obtain explicit confirmation of the empty-field auto-apply boundary.

## Product priorities

1. Extract structured facts from typed conversation.
2. Align assistant questions, workflow stepper, and a weighted RFP-relevant completeness score.
3. Support rooms and other array fields in extraction; display invalid extraction operations. (Deterministic review-first room recommendations shipped 2026-07-27 behind `ROOM_RECOMMENDATIONS_ENABLED`; next steps there are crew/array application, a production knowledge adapter, and workflow-facts integration — see `architecture/ROOM_RECOMMENDATIONS.md`.)
4. Promote investment report assumptions/confidence/scenarios from JSONB envelope to columns.
5. Add vendor-analysis attempt billing, bid comparison, and client-ready export.

## Verification and rollout

1. Add browser end-to-end, load, and production smoke suites.
2. Merge `ai-agent` to the default branches after acceptance.
3. Stand up staging using the production runbook and run controlled smoke tests.

Completed milestone checklists are historical and live under `archive/2026-07/`; they must not be used as an active backlog.
