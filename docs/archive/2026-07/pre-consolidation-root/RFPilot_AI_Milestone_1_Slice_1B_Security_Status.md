# RFPilot AI Intelligence Layer

## Milestone 1 — Slice 1B Security Increment Status

**Authorization:** DXG approval recorded July 16, 2026  
**Environment:** Updated and E2E-verified test environment  
**Production release:** Not performed

## Delivered

- 15-minute, issuer/audience-bound access tokens and rotating 7-day-idle/30-day-absolute refresh sessions.
- Hashed refresh tokens, replay-family revocation, current/all-device logout, and session listing/revocation.
- Hashed OTP challenges with expiry and failed-attempt tracking.
- Seven-role organization memberships, live membership rehydration, version invalidation, and centralized action policies.
- Server-only Next.js BFF token handling; browser-visible sessions no longer include backend bearer or refresh tokens.
- Opaque hashed proposal-view and vendor-submit grants with tenant/resource/purpose scope, expiry, use limits, and revocation.
- Append-only security audit persistence and sensitive-metadata filtering.
- Additive, dry-run-first membership migration applied to all five existing test users.

## Verification evidence

- Backend composite CI: lint, strict type-check, migration checks, 147 automated tests, and production build.
- Frontend composite CI: contract check, lint, strict type-check, 186 automated tests, and Next.js production build.
- Test-database smoke test passed session creation, rotation, revocation, tenant-scoped proposal grant issuance, one-time consumption/exhaustion, and revocation in `dxg_rfp_tool_db`.
- No raw refresh token, OTP code, or public grant token is persisted.
- Browser E2E confirmation on July 16, 2026: credential sign-in and complete sign-out both passed after server-side Auth.js cookie clearing and backend-session revocation were unified.
- User-confirmed E2E completion on July 16, 2026 covers silent refresh, emailed proposal access, vendor submission, missing/invalid grant denial, and cross-proposal isolation. The test environment was then verified with `ACCESS_TOKEN_EXPIRE_MINUTES=15` and `PUBLIC_GRANTS_ENFORCED=true`.

## Rollout controls and remaining work

- Email-generated proposal and vendor URLs carry distinct grants, and public-grant enforcement is enabled in the test environment.
- Frontend device-management UI and manually-created share-link UI are product enhancements; they do not block the verified session and email-link security foundation. Production configuration and clean-runner release evidence remain separate release controls.
- Production configuration/secrets and deployment require a separate release approval.
