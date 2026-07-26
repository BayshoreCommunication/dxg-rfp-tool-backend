# RFPilot AI Intelligence Layer

## Milestone 1 — Slice 1D Private Document Ingestion Status

**Authorization:** Test-environment implementation approved July 19, 2026  
**Verification date:** July 19, 2026  
**Production:** Not provisioned or changed  
**AI/provider processing:** Disabled and not implemented
**Backend commits:** `54c45cf`, `85c79dd` on `ai-agent`

## Delivered

- Private S3-compatible quarantine-storage adapter with short-lived constrained signed PUT uploads and no public ACL.
- Server-generated organization/source object keys; customer filenames are display metadata only.
- PDF, DOCX, XLSX, CSV, and TXT allowlist with 50 MB default limit.
- Exact object-size verification, content-signature validation, SHA-256 checksum, and organization-scoped duplicate reference.
- Replaceable malware-scanner port and ClamAV INSTREAM adapter.
- Fail-closed lifecycle: only a clean scan reaches `ready`; infection becomes `blocked`; outages/errors become retryable `scan_failed`.
- PostgreSQL source, object, and scan-result tables with forced tenant RLS and database-enforced lifecycle transitions.
- Organization/proposal-scoped metadata, audit events, idempotent upload creation/completion, rate-limited scan requests, and retention/legal-hold-aware deletion.
- Versioned `/api/v1` upload, completion, scan, status, list, and deletion endpoints.
- Architecture/configuration/operations runbook.

## Verification evidence

| Check | Result |
|---|---|
| Migration `003` clean apply | Passed |
| Migration rollback/reapply | Passed |
| Non-superuser forced RLS | Owning tenant saw 1 fixture; second tenant saw 0 |
| Upload policy and size validation | Passed |
| Extension/content spoof detection | Passed |
| SHA-256 integrity workflow | Passed |
| Clean scan lifecycle | `uploaded → scanning → ready` passed |
| Infection fail-closed behavior | `blocked` passed |
| Scanner outage behavior | `scan_failed`, never `ready`, passed |
| Deletion ordering | Private object deletion precedes final metadata state; passed |
| Production dependency audit | 0 known vulnerabilities |
| Backend composite CI | Contracts, lint, type-check, migration checks, 157 tests, and production build passed locally |
| Private MinIO bucket policy | Anonymous access disabled; unsigned object reads returned HTTP 403 |
| Real signed-upload/storage E2E | Clean PDF uploaded, verified, scanned `ready`, deleted, and metadata reached `deleted` |
| Real ClamAV EICAR E2E | Approved TXT fixture uploaded privately and reached `blocked` |
| Real scanner outage/retry E2E | Unreachable scanner produced `scan_failed`; restored scanner retry reached `ready` |
| Remote clean-runner CI | Backend CI runs for `54c45cf` and final `85c79dd` passed |

## Feature state

- Migration `003` is applied to the isolated local PostgreSQL test database.
- `DOCUMENT_INGESTION_ENABLED` remains false by default.
- No production storage, scanner, PostgreSQL, or AI provider was changed.
- The existing legacy public upload utility remains isolated and is not used by Slice 1D.
- The isolated PostgreSQL, MinIO, and ClamAV containers were stopped after verification. PostgreSQL test data is retained; MinIO/ClamAV were test-only services.

## Remaining acceptance evidence

- Run authenticated browser/API route E2E after the feature flag is enabled in a shared test deployment. The application/storage/scanner lifecycle has passed through the composed use case against real isolated services.
- Add end-user upload/status UI in the separately scheduled frontend compatibility increment unless DXG requests it in Slice 1D acceptance.
- DXG acceptance was recorded; Slice 1E approval-pack preparation is authorized, while Slice 1E implementation remains separately gated.

## Acceptance readiness

DXG accepted the Slice 1D implementation and test-environment evidence on July 19, 2026, and authorized preparation of the Slice 1E durable-job increment. Shared-test deployment route/browser E2E remains a deployment gate, not a production authorization. Slice 1E implementation remains separately approval-gated.

## Configuration gate

Do not enable the feature until the values documented in `docs/architecture/PRIVATE_DOCUMENT_INGESTION.md` are configured and validated. Do not place secrets or signed URLs in tickets, chat, logs, or source control.
