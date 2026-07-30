import { aiRuntimeAuthorized } from "../../../../config/aiEnvironment";

export class LegacyExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
  ) {
    super(message);
  }
}

/**
 * POST /api/extract-proposal predates the governed AI surface and was the one
 * live provider path with no runtime authorization, no feature flag, and no
 * kill switch — so it kept calling OpenAI in every environment, could not be
 * stopped during an incident, and appeared nowhere in the capability map that
 * docs/AI_LAYER.md presents as covering all AI.
 *
 * It now fails closed under the same controls as the governed surface. It is
 * still not equivalent to that surface — see the limitations recorded on
 * assertLegacyExtractionReady — so it should be retired once governed
 * extraction covers arrays and rooms.
 */
const enabled = (): boolean =>
  aiRuntimeAuthorized() && process.env.LEGACY_EXTRACTION_ENABLED === "true";

export const LEGACY_EXTRACTION_MODEL = process.env.LEGACY_EXTRACTION_MODEL || "gpt-4o";

/**
 * Known gaps versus the governed path, deliberately not closed here:
 * - uploads are held in memory and go straight to the provider with no ClamAV
 *   scan, unlike the private-source boundary;
 * - no ai_provider_attempts row, so spend is invisible to the usage report;
 * - output is Ajv-validated but carries no citations or confidence, so nothing
 *   downstream can trace a value back to the document.
 */
export const assertLegacyExtractionReady = (): void => {
  if (!enabled())
    throw new LegacyExtractionError(
      "LEGACY_EXTRACTION_DISABLED",
      "Document extraction is disabled in this environment.",
    );
  if (
    process.env.LIVE_AI_KILL_SWITCH === "true" ||
    process.env.LIVE_AI_KILL_SWITCH_LEGACYEXTRACTION === "true"
  )
    throw new LegacyExtractionError(
      "LIVE_AI_KILLED",
      "Live AI is stopped by an emergency kill switch.",
    );
  if (!process.env.OPENAI_API_KEY)
    throw new LegacyExtractionError(
      "LIVE_AI_CREDENTIAL_UNAVAILABLE",
      "The live provider credential is unavailable.",
    );
};
