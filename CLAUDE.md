# CLAUDE.md — dxg-rfp-tool-backend

Express + TypeScript API, durable workers, and the governed AI layer for RFPilot.
This repo is one of three (with `dxg-rfp-tool-dashboard` and `dxg-rfp-tool-admin`),
usually checked out side by side under a shared workspace folder whose
`CONTEXT-MAP.md` routes across them. This file must stand on its own in a fresh clone.

## Read first

1. `docs/README.md` — documentation index and reading rules
2. `docs/PROJECT_STATE.md` — current status, commitments, gaps (authoritative for status)
3. `docs/ARCHITECTURE.md` — system boundaries
4. `docs/AI_LAYER.md` for AI work; `docs/DECISIONS.md` entries touching the area you change

`docs/archive/` is historical evidence. Never infer current flags, authorization or status from it.

## Commands

```bash
npm run dev              # API (nodemon)
npm run dev:worker       # durable job worker (reloads; plain worker scripts do not)
npm run dev:dispatcher   # outbox -> Redis dispatcher
npm test                 # node:test over tests/*.test.js (NOT Jest)
npm run integration:up && npm run test:integration && npm run integration:down
npm run ci               # contracts:check -> lint -> type-check -> migration:check -> test -> build
npm run contracts:generate  # after editing contracts/; commit the regenerated output
```

AI features need all three processes running. A partial restart gives misleading results.

## Layout and gotchas

- New domain code goes in `src/modules/<domain>/`. Top-level `controller/`, `routes/`,
  `middleware/` and `utils/` are legacy and still live; do not assume code has moved.
- Shared contracts: `contracts/` (source) -> `contracts/generated/`. The dashboard has a
  generated copy and its CI runs `contracts:check`, so a contract change needs a regenerate there too.
- PostgreSQL migrations: `migrations/postgres/NNN_name.up.sql` + `.down.sql`, strictly ordered.
- `npm run lint` lints an explicit file list in `package.json`. A new top-level
  controller, route or script is not linted until you add it there.
- `.env.local` overrides `.env` (`config/env.ts`, `override: true`). Check both before
  concluding a flag is off.
- AI is deny-by-default: `AI_ENVIRONMENT` plus per-capability flags and kill switches.
  AI never publishes; conflicts go to human review.

## Project skills

`/ticket ORG-xxx` (implement a ticket end to end), `/contract-change` (schema + both generated
copies), `/migration <name>` (numbered SQL with RLS, proven on the integration DB). See `.claude/skills/`.

## Rules

- Never commit `.env*` files (except `.env.example`), provider keys, real proposal content,
  or the DXG pricing workbook.
- Every tenant-scoped Postgres access goes through RLS. The integration suite's
  cross-tenant tests must stay green.
- Ownership or trust-boundary changes need a `docs/DECISIONS.md` entry. Status or priority
  changes need a `docs/PROJECT_STATE.md` update.
