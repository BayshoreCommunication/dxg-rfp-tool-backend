# RFPilot AI Intelligence Layer

## Canonical Proposal Contract v1 — Field Reconciliation and Design

**Status:** Slice 1A design baseline  
**Decision:** Current `AddNewProposal` data is the compatibility baseline; canonical v1 introduces typed normalization without breaking existing proposals  
**Last updated:** July 15, 2026

---

# 1. Why a canonical contract is required

The proposal shape currently exists independently in the frontend wizard, an older frontend type file, the public proposal template, backend TypeScript, MongoDB/Mongoose, controller payload handling, and the AI extraction prompt. These definitions have diverged.

AI-assisted drafting cannot be reliable while a provider, API, form, database, and renderer disagree about field names and nesting. Canonical v1 therefore becomes the versioned contract for validated proposal data, while compatibility adapters preserve existing records and routes.

# 2. Sources inspected

| Source | Current role | Finding |
|---|---|---|
| `components/proposals/AddNewProposal.tsx` | Active wizard state/payload | Most complete current field model; many numbers/dates represented as strings |
| Proposal step components | Detailed section types/defaults | Venue schedule, creative, video, room, venue, budget, upload, and contact fields |
| `types/proposal.ts` | Older shared-looking type | Materially obsolete: singular room, old field names/nesting, missing new sections |
| `ProposalRfpTemplate.tsx` | Rendering contract | Permissive optional records hide contract drift |
| `modal/proposalsModel.ts` | Mongo persistence | Event/contact partially typed; most sections are `Schema.Types.Mixed` |
| `controller/proposalsController.ts` | API behavior | Accepts broadly shaped payloads; controller uses multiple `any` values |
| `controller/extractController.ts` | AI extraction | Prompt contains a parallel schema and several nesting mismatches |

# 3. Confirmed drift and risks

| Area | Conflicting representations | Risk |
|---|---|---|
| Proposal status | Frontend has two values; backend has five plus several booleans | Contradictory lifecycle state |
| Event type | Wizard nests `{eventType,eventTypeOther}`; extraction prompt describes sibling fields | Extraction merge can silently drop values |
| Rooms | Active wizard uses an array with nested equipment objects; old type uses one flat room | Data loss and unsafe casts |
| Production | Wizard derives/sends a production projection while room records also carry crew fields | Conflicting authority |
| Venue | Active venue technical model differs completely from old shared type | Renderer/API incompatibility |
| Dates/times | Date-only, time-only, ISO datetime, and free text coexist | Sorting, time-zone, and validation errors |
| Counts/money/dimensions | Predominantly strings | Invalid arithmetic and pricing inputs |
| Uploads | Strings represent files/URLs with no stable source identity | Missing provenance, privacy, and lifecycle controls |
| Settings | `proposalSettings` and live `proposalSetting` snapshots differ | Presentation configuration confusion |
| Persistence | Most proposal sections are `Mixed` | No database-level shape protection |
| Public rendering | Broad optional `Record<string, unknown>` | Restricted or malformed fields can leak/render silently |
| Extraction | Raw JSON is parsed without canonical runtime validation | Prompt output can corrupt state or smuggle unexpected keys |

# 4. Canonical v1 boundaries

Canonical v1 separates four concerns that are currently mixed:

1. **Proposal content** — event, schedule, rooms, hybrid, creative, recording, venue, budget preferences, contacts, and approved source references.
2. **Resource metadata** — ID, organization, owner, lifecycle status, version, timestamps, archive/favorite/copy state.
3. **Presentation snapshot** — branding, language, currency-display, signature, and public-download settings frozen for publication.
4. **AI workflow records** — source documents, extraction candidates, citations, confidence, conflicts, recommendations, decisions, and AI-run metadata. These are not embedded as unvalidated proposal content.

# 5. Canonical root shape

| Property | Type | Purpose |
|---|---|---|
| `schemaVersion` | literal `proposal.v1` | Contract/migration discriminator |
| `id` | opaque string | API resource ID; never authorization by itself |
| `organizationId` | opaque string | Tenant ownership |
| `ownerUserId` | opaque string | Creating/owning user |
| `version` | positive integer | Optimistic concurrency and stale-AI detection |
| `lifecycle` | object | Single lifecycle state plus flags that are not state duplicates |
| `content` | object | Validated proposal sections |
| `presentation` | object | Publication/display snapshot |
| `createdAt`, `updatedAt` | RFC 3339 timestamps | Audit/concurrency metadata |

## Lifecycle

Use one authoritative status enum:

`draft | submitted | in_review | approved | rejected | published | archived`

`favorite`, `copyOfProposalId`, `publishedAt`, and `archivedAt` remain separate metadata. Remove `isDraft`, `isActive`, `isAccepted`, `isOpen`, and `isArchived` as competing authorities after compatibility migration. Legacy adapters derive old flags temporarily.

# 6. Content sections

Canonical content retains the active wizard's functional coverage:

- `event`
- `venueSchedule`
- `rooms[]`
- `hybridVirtual`
- `contentCreative`
- `videoRecording`
- `venueTechnical`
- `sourceReferences`
- `budgetPreferences`
- `contacts`

The legacy names `roomByRoom`, `videoRecordingStep`, `venue`, `uploads`, `budget`, and `contact` are mapped at the compatibility boundary.

# 7. Normalization rules

| Value | Canonical representation | Legacy compatibility |
|---|---|---|
| Unknown text | Omit optional property or use `null` where explicit unknown matters | Empty string maps to absent/null |
| Yes/no/unknown | `true`, `false`, or `null` | Map `YES/Yes`, `NO/No`, blank/Not Sure |
| Count | Non-negative integer or `null` | Parse numeric strings; reject invalid nonblank values |
| Money | `{amountMinor,currency}` or approved budget-band identifier | Preserve legacy display string separately during migration |
| Date | ISO `YYYY-MM-DD` | Validate existing date strings |
| Local time | `HH:mm` plus IANA `timeZone` at schedule level | Map display time-zone labels to IANA zones where known |
| Instant | RFC 3339 timestamp with offset | Convert only when date, time, and zone are known |
| Dimension | `{value,unit}` or structured width/height/pixel pitch | Parse numeric/unit strings when unambiguous |
| Email/URL | Format-validated normalized string | Invalid values become validation issues, not silent coercion |
| File/source | Stable source/document reference object | Legacy URL strings become provisional source references |
| Enum | Canonical machine value with display label in UI | Map current case/punctuation variants |

# 8. Extraction is a patch, not a proposal

AI extraction must return `ProposalExtractionPatchV1`, not an unrestricted proposal object. Every candidate contains:

- Canonical JSON Pointer path.
- Proposed typed value.
- Source document/version and page/fragment citation.
- Confidence score and extraction method.
- Conflict/ambiguity state.
- Validation result.
- Human decision: pending, accepted, modified, or rejected.

Only an explicit application service may apply accepted candidates to the current proposal version. Unknown keys, unsupported values, stale versions, or missing evidence are rejected before reaching proposal state.

# 9. Source and file references

Replace string arrays with references containing:

- `sourceId` and immutable `sourceVersionId`.
- Category such as brand guide, logo, venue document, NDA, reference, quote, or brief.
- Safe display name.
- Media type, checksum, scan status, and access classification supplied by the document service.
- Optional external URL after URL-policy validation.

Storage keys, provider URLs, credentials, and restricted provenance never appear in planner/public projections.

# 10. Compatibility mapping

## Read path

1. Detect `schemaVersion`; absence means legacy.
2. Convert legacy status flags into canonical lifecycle with deterministic precedence.
3. Map legacy section names/nesting into canonical sections.
4. Normalize values conservatively and record issues instead of guessing.
5. Return canonical API projection plus `migrationWarnings` for authorized internal users.

## Write path

1. Validate canonical v1 request.
2. Enforce authorization and optimistic `version`.
3. Persist canonical data in the approved staged model.
4. During transition, produce a deterministic legacy projection only for routes/readers that still require it.
5. Never let a legacy route bypass new authorization or validation.

# 11. Required contract artifacts

Slice 1A implementation must provide:

- JSON Schema 2020-12 for proposal resource, create/update commands, public projection, and extraction patch.
- Generated TypeScript types consumed by both repositories.
- Canonical/legacy mappers with fixtures for representative existing proposals.
- Runtime validation at API and AI boundaries.
- Contract checksum/version check preventing frontend/backend drift.
- Mongo compatibility mapping and staged migration plan.
- Public projection allowlist.
- Contract tests covering valid, invalid, unknown, legacy, and forward-version inputs.

# 12. Acceptance criteria

- The frontend, backend, AI extraction, fixtures, and public renderer use canonical contract artifacts or explicit compatibility projections.
- All active wizard fields have an intentional canonical mapping or documented exclusion.
- Unknown properties are rejected at trust boundaries.
- Dates, numbers, money, counts, dimensions, URLs, and emails are validated with typed semantics.
- Legacy proposal fixtures round-trip without silent material loss.
- AI candidates cannot directly overwrite proposal state.
- Public output is an explicit allowlist and contains no private workflow/source fields.
- Contract changes are versioned and backward compatibility is tested.

