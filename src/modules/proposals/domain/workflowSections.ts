/**
 * Availability for guided proposal-intake sections.
 *
 * Keep the retired standalone recording step's identifiers and storage roots
 * so old clients/data remain compatible; flipping one value reactivates the
 * core workflow consumers that use this policy.
 */
export const PROPOSAL_WORKFLOW_SECTION_AVAILABILITY = Object.freeze({
  event_overview: true,
  venue_schedule: true,
  room_specifications: true,
  hybrid_virtual: true,
  content_creative: true,
  video_recording: false,
  venue_technical: true,
  investment_evaluation: true,
  uploads_covendors: true,
  contact_submit: true,
} as const);

export type ProposalWorkflowSectionId =
  keyof typeof PROPOSAL_WORKFLOW_SECTION_AVAILABILITY;

export const proposalWorkflowSectionEnabled = (
  sectionId: ProposalWorkflowSectionId,
): boolean => PROPOSAL_WORKFLOW_SECTION_AVAILABILITY[sectionId];

export const LEGACY_STANDALONE_VIDEO_RECORDING_ROOT =
  "/content/videoRecordingStep";
export const CANONICAL_STANDALONE_VIDEO_RECORDING_ROOT =
  "/content/videoRecording";
export const LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY =
  "videoRecordingStep";

const isAtOrBelow = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export const isRetiredLegacyProposalWorkflowPath = (path: string): boolean =>
  !proposalWorkflowSectionEnabled("video_recording") &&
  isAtOrBelow(path, LEGACY_STANDALONE_VIDEO_RECORDING_ROOT);

export const isRetiredCanonicalProposalWorkflowPath = (
  path: string,
): boolean =>
  !proposalWorkflowSectionEnabled("video_recording") &&
  isAtOrBelow(path, CANONICAL_STANDALONE_VIDEO_RECORDING_ROOT);

export const isRetiredProposalWorkflowPath = (path: string): boolean =>
  isRetiredLegacyProposalWorkflowPath(path) ||
  isRetiredCanonicalProposalWorkflowPath(path);

/**
 * Returns the proposal shape that active workflow consumers may inspect.
 *
 * The stored object is never mutated. The retired section remains available
 * to authenticated persistence/contract adapters for lossless round-trips,
 * while drafts, assistants, pricing, analysis and public presentation can use
 * this projection without accidentally reviving its data.
 */
export const activeProposalWorkflowContent = <
  T extends Record<string, unknown>,
>(proposal: T): T => {
  if (
    proposalWorkflowSectionEnabled("video_recording")
  ) {
    return proposal;
  }
  const retiredKeys = Object.keys(proposal).filter(
    (key) =>
      key === LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY ||
      key.startsWith(`${LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY}.`),
  );
  if (!retiredKeys.length) return proposal;
  const active = { ...proposal };
  for (const key of retiredKeys) delete active[key];
  return active;
};

/**
 * Stable content used by derived-artifact freshness and idempotency checks.
 * Mongo bookkeeping can change when dormant compatibility data is touched;
 * neither that bookkeeping nor the dormant root is active workflow input.
 */
export const activeProposalWorkflowFingerprintContent = <
  T extends Record<string, unknown>,
>(proposal: T): Record<string, unknown> => {
  const active = { ...activeProposalWorkflowContent(proposal) };
  for (const key of [
    "_id",
    "id",
    "__v",
    "userId",
    "organizationId",
    "version",
    "candidateApplicationIds",
    "proposalSetting",
    "createdAt",
    "updatedAt",
    "isFavorite",
    "viewsCount",
  ]) delete active[key];
  return active;
};
