# Development Guide

> Purpose: local setup and verification entry point. Last updated: 2026-07-22. Owner: engineering.

## Services

MongoDB, PostgreSQL 16 with pgvector, Redis, a private S3-compatible bucket, and optionally ClamAV are required for the complete AI workflow.

```bash
# backend: run all three for AI work
npm run dev
npm run dev:worker
npm run dev:dispatcher

# dashboard and admin, in their own repositories
npm run dev
```

Use the `dev:` worker variants locally so implementation changes reload. Production uses the plain PM2 scripts.

## Configuration

Start from the repository's single `.env.example`. AI is deny-by-default. Set `AI_ENVIRONMENT` and only the feature flags needed for the task. `.env.local` is an optional local override loaded after `.env`; do not create feature-specific environment files. Never commit runtime `.env` files, provider keys, real proposal content, or the DXG pricing workbook. See the backend `README.md` for base configuration and [runbooks/PRODUCTION.md](runbooks/PRODUCTION.md) for production keys.

## Verification

- Backend unit/quality gate: `npm run ci`.
- Real datastore integration: see [testing/INTEGRATION_SUITE.md](testing/INTEGRATION_SUITE.md).
- Provider release gate: see [testing/GOLD_EVALUATION.md](testing/GOLD_EVALUATION.md).
- Dashboard: `npm test`, `npx tsc --noEmit`, and `npm run lint`.
- UI workflow changes: drive the running application; unit tests have not caught every integration bug.

Do not use archived slice manual guides as current setup instructions.
