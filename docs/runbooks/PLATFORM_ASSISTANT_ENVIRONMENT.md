# Platform Assistant Environment Setup

> Senior developer handoff. Keep every secret in the deployment platform's
> encrypted secret store. Never commit a populated `.env` or `.env.local`.

## Backend

The Assistant uses MongoDB identity and organization context, PostgreSQL
conversation storage, Redis operational limits, and the OpenAI Responses API.
Add the following to the backend service environment:

```dotenv
# Existing application/auth values
NODE_ENV=production
AI_ENVIRONMENT=production
FRONTEND_URL=https://dashboard.example.com
BACKEND_URL=https://api.example.com
MONGODB_URL=<production-mongodb-url>
JWT_SECRET=<existing-production-jwt-secret>
JWT_ISSUER=rfpilot
JWT_AUDIENCE=rfpilot-users
OTP_PEPPER=<existing-production-otp-pepper>
BFF_SHARED_SECRET=<same-32+-character-value-as-dashboard>
PUBLIC_GRANTS_ENFORCED=true

# PostgreSQL persistence
POSTGRES_FOUNDATION_ENABLED=true
POSTGRES_URL=<runtime-postgresql-url>
POSTGRES_MIGRATION_URL=<migration-role-postgresql-url>
POSTGRES_SSL=true

# Distributed rate and concurrency limits
REDIS_URL=<private-redis-or-rediss-url>

# Provider secrets — backend only
OPENAI_API_KEY=<openai-project-api-key>
AI_SAFETY_IDENTIFIER_SECRET=<new-random-secret-of-at-least-32-characters>
AI_ANALYTICS_PSEUDONYM_KEY=<different-random-secret-of-at-least-32-characters>

# Approved Assistant release
AI_ASSISTANT_ENABLED=true
AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS=<approved-24-character-org-id[,another-id]>
AI_ASSISTANT_KILL_SWITCH=false
AI_ASSISTANT_MODEL=gpt-5.4-mini-2026-03-17
AI_ASSISTANT_REASONING_EFFORT=none
AI_ASSISTANT_TEXT_VERBOSITY=low
AI_ASSISTANT_ANALYTICS_ENABLED=false

# Irreversible cleanup stays independently disabled during launch
AI_RETENTION_PURGE_ENABLED=false
AI_RETENTION_POLICY_APPROVED=false
AI_RETENTION_PRODUCTION_EXECUTION_APPROVED=false

# Provider gate
LIVE_AI_PILOT_ENABLED=true
LIVE_AI_PROVIDER=openai
LIVE_AI_MODEL=gpt-5.4-mini-2026-03-17
LIVE_AI_KILL_SWITCH=false
```

Keep the bounded defaults in `.env.example` for token ceilings, timeouts,
retry, rate limits, and active streams unless the release record explicitly
approves a change.

`AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS` is a server-only comma-separated
allowlist. Production fails closed when it is empty or malformed. Do not use
`*` for a limited rollout, and never expose this value through a
`NEXT_PUBLIC_` variable.

Generate independent secrets, for example:

```bash
openssl rand -hex 32
```

Do not reuse `JWT_SECRET`, `BFF_SHARED_SECRET`,
`AI_SAFETY_IDENTIFIER_SECRET`, or `AI_ANALYTICS_PSEUDONYM_KEY` for one
another.

## Dashboard

Add the following to the customer dashboard service environment:

```dotenv
BACKEND_URL=https://api.example.com
NEXT_PUBLIC_BACKEND_URL=https://api.example.com
NEXT_PUBLIC_FRONTEND_URL=https://dashboard.example.com
NEXTAUTH_URL=https://dashboard.example.com
AUTH_SECRET=<dashboard-auth-secret-of-at-least-32-characters>
BFF_SHARED_SECRET=<exact-same-value-as-backend>
NEXT_PUBLIC_AI_ASSISTANT_ENABLED=true

# Required only when Google sign-in is enabled
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
```

`NEXT_PUBLIC_AI_ASSISTANT_ENABLED` controls whether the build can expose the
launcher. The authenticated backend `/api/v1/assistant/access` response still
decides whether the current organization sees it.

Never add `OPENAI_API_KEY`, `AI_SAFETY_IDENTIFIER_SECRET`,
`AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS`, PostgreSQL, Redis, MongoDB, or JWT
secrets to the dashboard environment as `NEXT_PUBLIC_` values.

## Admin

The Assistant launcher is a customer-dashboard capability. The admin
application needs no new Assistant environment variable for this release.

## Database and permission activation

From the backend release artifact, using the production migration role:

```bash
npm run migrate:postgres -- status
npm run migrate:postgres -- up
npm run migrate:postgres -- status
```

The last status must show migrations `026_platform_assistant` through
`036_assistant_retention_privacy` as `applied`. Do not run `rollback` as part
of an operational Assistant rollback; use the kill switch.

The signed-in user must receive `assistant:use` through the existing role and
permission system. Verify both:

1. an approved organization/user receives `{ "data": { "enabled": true } }`
   from `GET /api/v1/assistant/access`;
2. an out-of-cohort organization receives `enabled: false` and no dashboard
   launcher.

## Safe launch order

1. Deploy the backend and dashboard with both Assistant feature flags off and
   the backend kill switch on.
2. Apply and verify migrations `026_platform_assistant` through
   `036_assistant_retention_privacy`.
3. Add the exact approved organization IDs and confirm `assistant:use`.
4. Enable the backend feature while the kill switch remains on; verify a new
   message fails safely and history remains readable.
5. Set `AI_ASSISTANT_KILL_SWITCH=false`, complete one staging response, and
   inspect the provider-attempt/audit evidence.
6. Build or redeploy the dashboard with
   `NEXT_PUBLIC_AI_ASSISTANT_ENABLED=true`.
7. Run the staged smoke tests in
   [Platform Assistant rollout](./PLATFORM_ASSISTANT_ROLLOUT.md).

Before any internal or limited pilot, complete the release record and verdict
in [AI Assistant controlled pilot](./AI_ASSISTANT_PILOT_RELEASE.md).

If a credential has ever been printed, copied into a ticket/chat, or stored in
source control, rotate it before launch.
