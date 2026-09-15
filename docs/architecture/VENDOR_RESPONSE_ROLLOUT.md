# Structured vendor response production operation

The structured vendor workspace is the production default. New proposals are
treated as `structured_v1`; production explicitly sets
`VENDOR_STRUCTURED_RESPONSES_ENABLED=true`.

The legacy public `POST /api/vendor-responses` and `/check` routes are retired.
All emailed vendor links use the workspace bootstrap, draft, categorized upload,
and finalization APIs. The global switch and explicit per-proposal legacy marker
remain emergency fail-closed controls; they make the structured workspace
unavailable and never restore the retired form.

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

Set `responseFormat` to `legacy_unstructured` only to stop submissions for one
proposal during an incident. This changes only the proposal marker. Existing
drafts, questionnaires, immutable versions, documents, and planner response
projections are retained, so re-enabling resumes the structured state.

## Production cutover purge

`scripts/purgeVendorResponses.ts` inventories or permanently deletes all
vendor-response projections, submissions, versions, drafts, confirmation
delivery records, response notifications, and current private response objects.
It also tombstones registered PostgreSQL document sources and marks every proposal
`structured_v1`. Questionnaire publications and invitation grants are retained
so existing links open the new workspace.

The GitHub Actions workflow `Purge production vendor responses` is the only
supported production entry point. Run `dry-run` first. Apply requires the exact
confirmation `DELETE_ALL_VENDOR_RESPONSES` and records sanitized counts without
logging response text, contact data, filenames, URLs, or grant values.

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
