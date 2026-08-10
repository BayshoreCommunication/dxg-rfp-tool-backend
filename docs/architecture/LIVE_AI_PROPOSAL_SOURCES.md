# Slice 3C — Governed Live AI on Proposal Sources

> Current implementation note (2026-08-10): the canonical AI-layer controls
> remain unchanged, but source extraction has since expanded to up to five
> eligible uploads per run. Evidence is selected fairly across sources, and the
> provider executes one broad extraction plus at most one ledgered, batched gap
> recovery. See `docs/AI_LAYER.md` for current truth; the slice scope below is
> retained as historical authorization evidence.

**Status:** Authorized for isolated-test implementation
**Depends on:** Accepted private ingestion, durable jobs, proposal context, five-step workflow, and Slice 3B

Slice 3C permits an authenticated proposal owner to select one malware-scanned, explicitly `non_confidential` uploaded proposal source for cited OpenAI requirement extraction. The worker resolves source bytes from private storage, verifies tenant/proposal ownership, readiness, classification and checksum, parses bounded fragments, and sends only minimized opaque-ID evidence to `gpt-5.4-mini`.

Queue messages remain reference-only. PostgreSQL stores immutable run, evidence, validation and usage metadata. MongoDB remains authoritative and is unchanged unless the planner later uses the existing explicit structured-candidate review/application workflow. Generated prose is never applied or published.

## Eligibility

- test environment and Slice 3C feature flag enabled;
- source belongs to the authenticated owner's proposal;
- source is `ready`, clean-scanned, retained, and not deleted;
- classification is exactly `non_confidential`;
- supported PDF, DOCX, XLSX, CSV, or TXT parser;
- parsed evidence remains within fragment, byte and token ceilings; and
- live-provider policy and kill switch allow `extractStructured`.

Unknown, internal, confidential, restricted, personal, pricing, or contract content fails before provider invocation. Filenames, object keys, proposal IDs, tenant IDs and user IDs are not sent to OpenAI.

## API and UI

- Upload session accepts the explicit classification `non_confidential`; all other proposal uploads retain the safer `confidential` default.
- `POST /api/v1/proposals/:id/live-source-context-jobs` accepts `{ sourceId }` with an idempotency key.
- Existing owner-scoped context-run reads return cited candidates, source coordinates, checksums and provider usage.
- The dashboard lists only ready non-confidential sources in the live extraction selector.

## Excluded

Confidential/restricted processing, multi-source synthesis, DXG knowledge retrieval, pricing/contract extraction, AI-generated questions, generated-prose application, automatic candidate application, publication, and production rollout remain excluded.
