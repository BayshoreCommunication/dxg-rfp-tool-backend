# Security sessions, authorization, and public access

Access tokens use the configurable `ACCESS_TOKEN_EXPIRE_MINUTES` lifetime and
are bound to a server-side refresh-session family. The current access-token
setting is `10080` minutes (7 days). Refresh tokens use the configurable
`REFRESH_TOKEN_EXPIRE_DAYS` lifetime, currently 30 days for both absolute and
idle expiry. They are 256-bit opaque values; MongoDB stores only SHA-256 hashes.
Rotation consumes the prior record atomically and does not extend the original
30-day family deadline. Reuse, expiry, logout, password reset, membership loss,
account blocking, or organization deactivation fails closed.

The Next.js applications are BFFs. Backend access and refresh tokens are held
only in each encrypted Auth.js JWT cookie and decoded by
`lib/server/backendSession.ts`. The browser-visible session contains identity
presentation fields only. `BFF_SHARED_SECRET` authorizes server-to-server
delivery of refresh material; it must be identical in the frontend, admin, and
backend secret stores and must never use a `NEXT_PUBLIC_` name. Protected BFF
requests use the centralized backend client, which proactively refreshes,
coalesces concurrent refreshes, and retries one 401 exactly once.

`POST /api/auth/logout-session` revokes by the refresh credential, so logout
does not depend on a still-valid access token. Notification WebSockets use a
30-second, purpose- and audience-restricted ticket from
`POST /api/notifications/socket-ticket`; access and refresh tokens are never
placed in the browser WebSocket URL.

Organization roles are reloaded from `OrganizationMembership` on every protected request. `rolesVersion` invalidates stale access tokens. Central action policy lives in `src/modules/identity/domain/authorizationPolicy.ts`; route guards deny actions not granted by the current membership.

Public proposal and vendor access uses an opaque `PublicAccessGrant`, scoped to organization, proposal, and purpose. Only its hash is stored. Expiry, revocation, and optional use limits are enforced atomically. Set `PUBLIC_GRANTS_ENFORCED=true` only after the frontend share/vendor URL rollout has been verified; authenticated owner requests bypass the public-grant guard.

Required production configuration includes `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `OTP_PEPPER`, `BFF_SHARED_SECRET`, and `PUBLIC_GRANTS_ENFORCED`. Production release remains separately approval-gated.
