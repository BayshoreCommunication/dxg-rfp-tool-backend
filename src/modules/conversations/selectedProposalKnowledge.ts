import {
  activeProposalWorkflowContent,
  LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
  proposalWorkflowSectionEnabled,
} from "../proposals/domain/workflowSections";

export const SELECTED_PROPOSAL_KNOWLEDGE_VERSION =
  "selected-proposal-knowledge.v2";
export const MAX_SELECTED_PROPOSAL_KNOWLEDGE_CHARACTERS = 24_000;

const ALL_INCLUDED_SECTIONS = [
  "event",
  "venueSchedule",
  "roomByRoom",
  "production",
  "hybridVirtual",
  "contentCreative",
  "videoRecordingStep",
  "venue",
  "budget",
] as const;

const INCLUDED_SECTIONS = ALL_INCLUDED_SECTIONS.filter(
  (section) =>
    section !== LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY ||
    proposalWorkflowSectionEnabled("video_recording"),
);

const BLOCKED_KEYS = new Set([
  "_id",
  "id",
  "userid",
  "organizationid",
  "proposalsettings",
  "contact",
  "contacts",
  "contactfirstname",
  "contactlastname",
  "contacttitle",
  "contactorganization",
  "organizationlegalname",
  "contactemail",
  "contactphone",
  "contactphoneext",
  "contactphonetype",
  "additionalcontacts",
  "preferredcontactmethod",
  "besttimetoreach",
  "anythingelse",
  "notes",
  "note",
  "privatenotes",
  "internalnotes",
  "uploads",
  "attachments",
  "files",
  "candidateapplicationids",
]);

const normalizedKey = (value: string): string =>
  value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");

const blockedKey = (value: string): boolean => {
  const normalized = normalizedKey(value);
  return (
    BLOCKED_KEYS.has(normalized) ||
    normalized.endsWith("contactname") ||
    normalized.endsWith("contactemail") ||
    normalized.endsWith("contactphone") ||
    normalized.includes("private") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.endsWith("objectkey") ||
    normalized.endsWith("storagekey") ||
    normalized.endsWith("sourceid")
  );
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

type Budget = { remaining: number };

const sanitize = (
  value: unknown,
  budget: Budget,
  depth = 0,
): unknown => {
  if (budget.remaining <= 0 || depth > 5) return undefined;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return undefined;
    const bounded = normalized.slice(0, Math.min(800, budget.remaining));
    budget.remaining -= bounded.length;
    return bounded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || budget.remaining < 16) return undefined;
    budget.remaining -= 16;
    return value;
  }
  if (typeof value === "boolean") {
    if (budget.remaining < 5) return undefined;
    budget.remaining -= 5;
    return value;
  }
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (budget.remaining < iso.length) return undefined;
    budget.remaining -= iso.length;
    return iso;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, 20)) {
      if (budget.remaining < 2) break;
      budget.remaining -= 2;
      const sanitized = sanitize(item, budget, depth + 1);
      if (sanitized !== undefined) items.push(sanitized);
    }
    return items.length > 0 ? items : undefined;
  }
  if (!record(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (blockedKey(key) || key.length > 120) continue;
    const keyCost = key.length + 4;
    if (budget.remaining < keyCost) break;
    budget.remaining -= keyCost;
    const sanitized = sanitize(item, budget, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

export type SelectedProposalKnowledge = {
  schemaVersion: typeof SELECTED_PROPOSAL_KNOWLEDGE_VERSION;
  selection: "explicit_owner_authorized";
  proposalVersion: number;
  lifecycle: {
    status: string;
    draft: boolean;
  };
  sections: Record<string, unknown>;
  privacy: {
    excluded: [
      "contacts",
      "uploads_and_attachments",
      "private_or_internal_notes",
      "storage_and_source_identifiers",
    ];
  };
};

export const buildSelectedProposalKnowledge = (
  proposal: Record<string, unknown>,
): SelectedProposalKnowledge => {
  const activeProposal = activeProposalWorkflowContent(proposal);
  const budget = {
    remaining: MAX_SELECTED_PROPOSAL_KNOWLEDGE_CHARACTERS,
  };
  const sections: Record<string, unknown> = {};
  for (const section of INCLUDED_SECTIONS) {
    const sanitized = sanitize(activeProposal[section], budget);
    if (sanitized !== undefined) sections[section] = sanitized;
  }
  const version = Number(activeProposal.version);
  return {
    schemaVersion: SELECTED_PROPOSAL_KNOWLEDGE_VERSION,
    selection: "explicit_owner_authorized",
    proposalVersion:
      Number.isInteger(version) && version > 0 ? version : 1,
    lifecycle: {
      status:
        typeof activeProposal.status === "string"
          ? activeProposal.status.slice(0, 40)
          : "unknown",
      draft: activeProposal.isDraft === true,
    },
    sections,
    privacy: {
      excluded: [
        "contacts",
        "uploads_and_attachments",
        "private_or_internal_notes",
        "storage_and_source_identifiers",
      ],
    },
  };
};
