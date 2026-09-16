import { withPostgresTransaction } from "../../../config/postgres";
import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";

/* Is live AI usable *right now*? `/ai/pilot-status` answers a different
   question — what the environment is configured to allow — and is admin-only.
   A planner's composer needs the operational answer, which includes the
   provider refusing every call (exhausted billing quota, a revoked key, an
   outage) while the configuration still says "enabled". */

export type AiUnavailableReason =
  | "PILOT_DISABLED"
  | "KILL_SWITCH"
  | "CREDENTIAL_MISSING"
  | "PROVIDER_UNAVAILABLE";

export type AiAvailability = {
  available: boolean;
  reason: AiUnavailableReason | null;
  since: string | null;
  checkedAt: string;
};

/* Content problems (malformed output, bad citations) say nothing about the
   provider's health — one unparseable document must never halt the product.
   Only codes meaning "the call itself could not be served" count. */
const PROVIDER_FAILURE_CODES = new Set([
  "LIVE_AI_PROVIDER_TEMPORARY",
  "LIVE_AI_PROVIDER_FAILED",
  "LIVE_AI_CREDENTIAL_UNAVAILABLE",
  "LIVE_AI_EMPTY_OUTPUT",
  /* An exhausted account is the outage this circuit exists for: it fails every
     call, indefinitely, until somebody pays. Omitting it would leave the
     composer cheerfully accepting sends throughout. */
  "LIVE_AI_QUOTA_EXHAUSTED",
]);

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const availabilitySettings = () => ({
  /* Two consecutive provider failures, not one: a single 500 is noise. */
  failureThreshold: Math.max(1, Math.floor(positiveNumber(process.env.AI_AVAILABILITY_FAILURE_THRESHOLD, 2))),
  /* THE DEADLOCK GUARD. Blocking the composer stops new attempts, so the
     ledger would freeze on its last failure and the product would stay halted
     for ever. Treating failures older than the cooldown as stale reopens the
     circuit, lets one real attempt through, and re-closes it if that fails. */
  cooldownMs: positiveNumber(process.env.AI_AVAILABILITY_COOLDOWN_MINUTES, 15) * 60_000,
  cacheTtlMs: positiveNumber(process.env.AI_AVAILABILITY_CACHE_SECONDS, 30) * 1_000,
});

export const configuredReason = (): AiUnavailableReason | null => {
  if (!aiRuntimeAuthorized() || process.env.LIVE_AI_PILOT_ENABLED !== "true" || process.env.LIVE_AI_PROVIDER !== "openai")
    return "PILOT_DISABLED";
  if (process.env.LIVE_AI_KILL_SWITCH === "true" || process.env.LIVE_AI_KILL_SWITCH_EXTRACTSTRUCTURED === "true")
    return "KILL_SWITCH";
  if (!process.env.OPENAI_API_KEY) return "CREDENTIAL_MISSING";
  return null;
};

type LedgerRow = { state: string; error_code: string | null; updated_at: Date | string };

/* Exported for tests: the decision is pure, the query is not. */
export const evaluateLedger = (
  rows: LedgerRow[],
  now: number,
  settings = availabilitySettings(),
): { failing: boolean; since: string | null } => {
  const leading: LedgerRow[] = [];
  for (const row of rows) {
    if (row.state === "succeeded") break;
    if (row.state !== "failed" || !PROVIDER_FAILURE_CODES.has(String(row.error_code))) break;
    leading.push(row);
  }
  if (leading.length < settings.failureThreshold) return { failing: false, since: null };
  const newest = new Date(leading[0].updated_at).getTime();
  if (!Number.isFinite(newest) || now - newest > settings.cooldownMs) return { failing: false, since: null };
  return { failing: true, since: new Date(leading[leading.length - 1].updated_at).toISOString() };
};

const cache = new Map<string, { value: AiAvailability; expiresAt: number }>();
export const clearAvailabilityCache = () => cache.clear();

export const aiProviderAvailability = async (input: {
  organizationMongoId: string;
}): Promise<AiAvailability> => {
  const settings = availabilitySettings();
  const now = Date.now();
  const configured = configuredReason();
  if (configured)
    return { available: false, reason: configured, since: null, checkedAt: new Date(now).toISOString() };

  const cached = cache.get(input.organizationMongoId);
  if (cached && cached.expiresAt > now) return cached.value;

  /* The composer polls this. A ledger read must never be the reason a planner
     cannot type, so an unreadable database degrades to "available" and lets
     the real call produce the real error. */
  let verdict: { failing: boolean; since: string | null };
  try {
    verdict = await withPostgresTransaction(async (c) => {
      await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [input.organizationMongoId]);
      const org = await c.query<{ id: string }>(
        "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
        [input.organizationMongoId],
      );
      if (!org.rows[0]) return { failing: false, since: null };
      await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
      const rows = await c.query<LedgerRow>(
        `SELECT state,error_code,updated_at FROM rfpilot.ai_provider_attempts
          WHERE organization_id=$1 AND state IN ('succeeded','failed')
          ORDER BY updated_at DESC LIMIT $2`,
        [org.rows[0].id, Math.max(settings.failureThreshold, 10)],
      );
      return evaluateLedger(rows.rows, now, settings);
    });
  } catch {
    verdict = { failing: false, since: null };
  }

  const value: AiAvailability = {
    available: !verdict.failing,
    reason: verdict.failing ? "PROVIDER_UNAVAILABLE" : null,
    since: verdict.since,
    checkedAt: new Date(now).toISOString(),
  };
  cache.set(input.organizationMongoId, { value, expiresAt: now + settings.cacheTtlMs });
  return value;
};
