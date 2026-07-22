# Slice 2E Test-Environment Evidence

**Date:** 2026-07-20  
**Environment:** Isolated test  
**Mutation boundary:** Individually selected fields on an owned draft only

## DXG acceptance

DXG formally accepted Slice 2E and its test-environment evidence on 2026-07-20. This acceptance closes Slice 2E while all separately gated capabilities remain unauthorized.

## Main controlled-application test

DXG completed the dashboard review and overwrite-confirmation flow. Authoritative records confirm:

```json
{
  "jobId": "019f7e9f-c44d-751a-af47-62eb86b5ecda",
  "jobStatus": "succeeded",
  "applicationId": "019f7e9f-c44d-751a-af47-5f0adcc16e69",
  "applicationStatus": "applied",
  "selectedCount": 2,
  "expectedProposalVersion": 3,
  "resultingProposalVersion": 4,
  "safeErrorCode": null
}
```

The proposal version incremented exactly once.

## Overwrite-protection evidence

An earlier attempt without all required application-time overwrite confirmations failed safely:

```json
{
  "jobStatus": "failed",
  "applicationStatus": "conflict",
  "safeErrorCode": "OVERWRITE_CONFIRMATION_REQUIRED",
  "resultingProposalVersion": null
}
```

No mutation was performed by the refused attempt. The dashboard now prevents this request before queuing and renders the safe reason if a server-side conflict occurs.

## Safety verification

```json
{
  "duplicateApplication": {
    "applicationId": "019f7e9f-c44d-751a-af47-5f0adcc16e69",
    "versionUnchanged": true
  },
  "staleVersion": {
    "applicationId": "019f7ea2-5f9d-749d-b123-8d5739fe70b1",
    "rejected": true,
    "versionUnchanged": true
  },
  "ownerIsolation": {
    "otherActorDenied": true
  },
  "lifecycle": {
    "status": "submitted",
    "rejected": true,
    "versionUnchanged": true
  },
  "providerCalls": 0
}
```

Verified controls:

- re-executing an applied application is idempotent;
- stale expected version is rejected before mutation;
- another active user cannot read the owner's application;
- a submitted proposal cannot receive candidate changes; and
- safety verification makes no AI-provider call.

## Remaining manual confirmation

DXG should confirm visually that accepted/edited fields changed and rejected/pending fields remained unchanged. Final regression results must also be recorded before formal acceptance.

## Regression gates

- Backend CI passed: contract drift check, zero-warning configured lint, TypeScript, migration commands, 203 tests, and production build.
- Dashboard tests passed: 17 suites and 199 tests.
- Backend and dashboard production builds passed during Slice 2E implementation.
