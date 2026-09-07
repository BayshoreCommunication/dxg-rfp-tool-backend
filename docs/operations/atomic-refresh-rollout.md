# Atomic refresh rotation rollout

This release changes refresh-token storage from one active document per token
to one active document per session. Current and consumed credential hashes stay
on that document; raw credentials and operation keys are never persisted.
The absolute refresh deadline and configured access-token lifetime do not change.

## Required reader-first deployment

1. Deploy compatibility reader `ed651f41def4c9b893bbf2c4f0b7254bc3908280`
   to every API instance. It recognizes `consumedTokenHashes`, treats historical
   matches as consumed, and includes the expected token hash in its consume CAS.
   It makes no in-place rotations itself.
2. Wait for the AWS deployment and smoke checks to finish. Confirm the old API
   tasks have drained. Do not overlap the atomic-writer release with this step.
3. Deploy the atomic writer, retaining the compatibility reader as the supported
   rollback target. Keep the existing 100/200 healthy rollout policy.
4. Wait for all API tasks to settle before deploying the dashboard operation-key
   sender. Unkeyed clients continue to rotate normally, with strict replay
   detection; only a validated BFF can use the 30-second idempotent handoff.

## Rollback boundary

Do not roll back below the compatibility-reader commit after an in-place
rotation has happened. Older versions search only the current `tokenHash` and
cannot find historical credentials for logout/replay revocation. Roll back to
the reader commit (safe, but without concurrent-refresh recovery), or roll
forward with a fix. Do not delete history arrays or invalidate all sessions as
a deployment shortcut. This is an application compatibility floor, not a
database migration or a token-lifetime change.

## Verification

- `npm run ci`
- `INTEGRATION=1 node --test --require ts-node/register tests-integration/auth-session-rotation.test.ts tests-integration/auth-reader-compatibility.test.ts`
- `scripts/verifyAuthRefreshE2E.ts` against a disposable `rfpilot_auth_e2e*`
  database and a local test API: actual expiry, four parallel HTTP refreshes,
  one successor, preserved proposal input, historical-token logout, no orphan
  signup session. Never point that script at production; it drops its test DB.
- Run `auth-reader-compatibility.test.ts` on the reader commit too: a future
  in-place row must still be revoked by both historical logout and replay.

Replay recovery requires the immediate previous hash, matching operation-key
hash, unchanged active successor, active membership and unexpired deadlines.
The window starts at the winning server-side CAS and never slides on retries.
Up to five seconds of negative server clock skew is tolerated; the forward
cutoff remains 30 seconds. A delayed response after another rotation remains
fail-closed. At 10,000 rotations the session is revoked and login is required;
history is never silently truncated to evade the storage bound.
