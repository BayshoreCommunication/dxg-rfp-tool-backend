# Structured vendor response rollout

The structured vendor workspace is deny-by-default and requires both gates:

1. `VENDOR_STRUCTURED_RESPONSES_ENABLED=true` enables the backend capability.
2. `proposalSettings.vendorResponseFormat` must equal `structured_v1` for the
   individual proposal.

Unmarked proposals resolve to `legacy_unstructured`. The public workspace DTO
always returns the effective `capabilities.responseFormat` and a safe reason.
When either gate is off, no questionnaire is published and all structured draft
endpoints reject writes. The legacy `POST /api/vendor-responses` path remains
available.

## Per-proposal operation

An authorized planner can publish and opt in with
`POST /api/vendor-responses/questionnaires/publish`, or explicitly set either
format through `PATCH /api/vendor-responses/questionnaires/capability`:

```json
{
  "proposalId": "<proposal-id>",
  "responseFormat": "structured_v1"
}
```

Set `responseFormat` to `legacy_unstructured` to roll back that proposal. This
changes only the proposal marker. Existing drafts, questionnaires, immutable
versions, documents, and planner response projections are retained, so
re-enabling resumes the structured state.

## Marker backfill

Run the dry-run first:

```sh
npm run backfill:vendor-response-format-markers
```

Apply after reviewing the counts:

```sh
npm run backfill:vendor-response-format-markers -- --apply
```

The script writes only missing proposal and questionnaire format markers. It
does not inspect or modify answer, draft, submission, document, contact, or
grant data.

## Telemetry boundary

Vendor rollout events contain pseudonymous organization/proposal/submission/
draft identifiers plus enums and counts. The central allowlist drops answer
text, reference contact data, filenames, grants, document URLs, and unknown
fields before logs or metrics are emitted.
