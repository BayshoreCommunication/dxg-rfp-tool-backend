---
name: contract-change
description: Change a shared RFPilot contract (JSON schema under backend contracts/) and keep the backend and dashboard copies, generated types and consumers in sync. Use when a field is added, renamed or removed in proposal.v1 or vendor-response.v1 schemas, or when contracts:check fails.
argument-hint: <what changes, e.g. "add venue.capacity to proposal.v1">
---

# /contract-change $ARGUMENTS

Backend `contracts/` is the source of truth. The dashboard keeps a copy of the schema files and
its own generated output; both CI pipelines run `contracts:check`. Admin has no contracts.

## 1. Decide if it is breaking

Removing or renaming a field, tightening a type, adding a `required` entry or narrowing an enum is
breaking. Stored MongoDB documents and canonical snapshots already exist in that shape, so a
breaking change needs either a legacy adapter (`contracts/proposal/v1/legacyAdapter.ts`) or a new
version directory (`v2`) plus a migration script, and a `docs/DECISIONS.md` entry. Stop and ask
before a breaking change unless the request already says how to handle existing data.
Adding an optional field is non-breaking.

## 2. Edit the source

- Edit the schema in `contracts/<proposal|vendor-response>/v1/*.schema.json`.
- A **new** schema file must be added to the `contracts` list in `scripts/generateContracts.mjs`
  in **both** repos (the two scripts are identical; keep them that way).
- Update hand-written validators or fixtures beside the schema if they mirror the field.
- Never edit `contracts/generated/` by hand (a hook blocks it).

## 3. Regenerate in both repos

```bash
npm run contracts:generate && npm run contracts:check          # backend
cp contracts/<dir>/v1/<changed>.schema.json ../dxg-rfp-tool-dashboard/contracts/<dir>/v1/
cd ../dxg-rfp-tool-dashboard && npm run contracts:generate && npm run contracts:check
```

Copy only the schema JSON files you changed (and `proposal-form-ui.v1.json` if it changed).
`legacyAdapter.ts` intentionally differs between the repos and the dashboard has extra tests
there: port a change to it by hand, do not copy the file.

## 4. Update consumers

Search both repos for the field and the generated type name, then fix:
backend controllers, `src/modules/*`, AI extraction prompts and output validators that emit the
contract, and dashboard forms, server actions and display components. If the field appears in the
API, update `docs/API.md`.

## 5. Verify and report

- `npm run ci` in the backend and the dashboard.
- Commit the schema, the generated output and the consumer changes together in each repo
  (two commits, one per repo, same message).
- Report the change, whether it is breaking, both repos' check results, and any stored-data impact.
