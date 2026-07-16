# Security sessions, authorization, and public access

Slice 1B uses 15-minute JWT access tokens bound to a server-side refresh-session family. Refresh tokens are 256-bit opaque values; MongoDB stores only SHA-256 hashes. Rotation consumes the prior record atomically. Reuse, expiry, logout, membership loss, account blocking, or organization deactivation fails closed.

The Next.js application is the BFF. Backend access and refresh tokens are held only in the encrypted Auth.js JWT cookie and decoded by `lib/server/backendSession.ts`. The browser-visible session contains identity presentation fields only. `BFF_SHARED_SECRET` authorizes server-to-server delivery of refresh material; it must be identical in the frontend and backend secret stores and must never use a `NEXT_PUBLIC_` name.

Organization roles are reloaded from `OrganizationMembership` on every protected request. `rolesVersion` invalidates stale access tokens. Central action policy lives in `src/modules/identity/domain/authorizationPolicy.ts`; route guards deny actions not granted by the current membership.

Public proposal and vendor access uses an opaque `PublicAccessGrant`, scoped to organization, proposal, and purpose. Only its hash is stored. Expiry, revocation, and optional use limits are enforced atomically. Set `PUBLIC_GRANTS_ENFORCED=true` only after the frontend share/vendor URL rollout has been verified; authenticated owner requests bypass the public-grant guard.

Required production configuration includes `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `OTP_PEPPER`, `BFF_SHARED_SECRET`, and `PUBLIC_GRANTS_ENFORCED`. Production release remains separately approval-gated.
