# Slice 2F Manual Test Guide

## Start services

Restart the backend, current durable worker, dispatcher, and dashboard. A pre-Slice-2F worker cannot route the new draft job type.

```bash
npm run dev:proposal-context
npm run worker:source-security
npm run worker:dispatcher
```

## Test

1. Open the owned unsubmitted draft used for Slice 2E.
2. Find **AI proposal draft (test)**.
3. Select **Generate draft**.
4. Wait for `succeeded`.
5. Review section headings, paragraph text, evidence paths, and information gaps.
6. Refresh and confirm the latest draft is restored.
7. Confirm proposal form values, version, lifecycle, and publication state did not change.

Expected: cited read-only sections, explicit gaps, no apply/publish controls, and no MongoDB proposal mutation.
