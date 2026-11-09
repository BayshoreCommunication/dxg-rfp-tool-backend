# Local stack

Every service the backend needs, in Docker, with test accounts. It never reads `.env` or
`.env.local`, so it cannot touch a shared or production database.

| Service | Address |
|---|---|
| MongoDB (replica set) | `localhost:47017`, database `rfpilot_local` |
| PostgreSQL 16 + pgvector | `127.0.0.1:45432`, database `rfpilot_local` |
| Redis | `127.0.0.1:46379` |
| Mailpit (catches all email) | inbox at http://127.0.0.1:48025 |
| API / dashboard / admin | http://localhost:8100, :3100, :3101 |

## Use it

Needs a working Docker Desktop (4.30 or newer) and `npm install` in all three repos.

```bash
npm run stack:up      # start services, apply migrations, grant the app role, seed (idempotent)
npm run stack:dev     # run API, worker, dispatcher, dashboard and admin against it
npm run stack:down    # stop services, keep data
npm run stack:reset   # delete all data and start fresh
```

## Accounts

Password for every account: `Rfpilot-local-1`.

| App | Email | Role |
|---|---|---|
| Dashboard | `owner.northwind@example.com` | Owner, Northwind Events |
| Dashboard | `admin.northwind@example.com` | Admin, Northwind Events |
| Dashboard | `manager.northwind@example.com` | Team Manager, team "Corporate Events" |
| Dashboard | `planner.northwind@example.com` | Planner, team "Corporate Events" |
| Dashboard | `viewer.northwind@example.com` | Viewer, Northwind Events |
| Dashboard | `owner.contoso@example.com` | Owner, Contoso Live (second tenant) |
| Dashboard | `planner.contoso@example.com` | Planner, Contoso Live |
| Admin app | `superadmin@example.com` | super_admin |

Northwind has three RFPs (two drafts by the Planner, one published by the Owner) and Contoso
has one draft. Anything from Contoso showing up for a Northwind account is a tenant leak.

## How it is wired

- `stack.env` is the backend's whole environment, loaded through `RFPILOT_ENV_FILE`
  (`config/env.ts` then skips `.env` and `.env.local`). Its secrets are local placeholders.
- The API connects to Postgres as `rfpilot_app`, a plain role bound by row-level security.
  `npm run stack:seed` creates it and re-grants it after migrations.
- `run-stack.sh` passes the dashboard and admin their settings as environment variables, which
  Next.js prefers over their `.env.local` files. The dashboard builds into `.next-stack`.
- `scripts/seedLocalStack.ts` refuses to run unless every connection string points at these
  loopback ports.
- AI is off. To try an AI feature, copy `stack.env` to `deploy/local/stack.private.env` (gitignored), set `AI_ENVIRONMENT`
  and that feature's flags, and run `RFPILOT_ENV_FILE=<copy> npm run stack:dev`. Never commit a provider key.

## Not included yet

- S3 storage, so logo, attachment and vendor-document uploads fail.
- ClamAV and document ingestion.
- Vendor invitations and responses in the seed data. Publish an RFP and invite a vendor
  through the app; the invitation email lands in Mailpit.
