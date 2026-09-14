import { createHash } from "node:crypto";
import type { ProposalV1 } from "../../../../contracts/generated/proposal-v1";
import type {
  Section,
  VendorResponseQuestionnaireV1,
} from "../../../../contracts/generated/vendor-response-questionnaire-v1";

export const VENDOR_RESPONSE_QUESTIONNAIRE_PROJECTION_VERSION =
  "vendor-response-questionnaire-projection.v1";

export type VendorResponseQuestionnaireProjection = Omit<
  VendorResponseQuestionnaireV1,
  "questionnaireVersion" | "questionnaireChecksum" | "publishedAt"
>;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

export const stableQuestionnaireChecksum = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");

const bounded = (value: string, maximum: number): string =>
  value.length <= maximum ? value : value.slice(0, maximum);

const words = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());

const identifierPart = (value: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || stableQuestionnaireChecksum(value).slice(0, 16);
};

const hasValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasValue);
  return true;
};

const printableValue = (value: unknown): string => {
  if (value === true) return "Required";
  if (Array.isArray(value)) return value.map(printableValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => hasValue(child))
      .map(([key, child]) => `${words(key)}: ${printableValue(child)}`)
      .join("; ");
  }
  return String(value ?? "");
};

type Spec = VendorResponseQuestionnaireV1["rooms"][number]["specs"][number];

const roomSpecs = (room: ProposalV1["content"]["rooms"][number]): Spec[] => {
  const specifications: Spec[] = [];
  for (const [category, requirements] of Object.entries({
    audio: room.audio,
    video: room.video,
    lighting: room.lighting,
    production: room.production,
  })) {
    if (!requirements) continue;
    for (const [key, value] of Object.entries(requirements)) {
      if (!hasValue(value)) continue;
      const sourcePath = `/content/rooms/${room.id}/${category}/${key}`;
      const label = words(key);
      specifications.push({
        specId: `spec-${stableQuestionnaireChecksum(`${room.id}:${category}:${key}`).slice(0, 20)}`,
        category,
        label,
        requirementText: bounded(`${label}: ${printableValue(value)}`, 4000),
        sourcePath,
        allowedResponses: ["comply", "substitute", "exception"],
        noteMaxLength: 1000,
      });
    }
  }
  return specifications.slice(0, 500);
};

const section = (
  sectionId: Section["sectionId"],
  title: string,
  order: number,
  required: boolean,
  condition: Section["condition"] = "always",
  evaluationMappings: string[] = [],
): Section => ({
  sectionId,
  title,
  order,
  enabled: true,
  required,
  condition,
  evaluationMappings,
});

const sections = (): Section[] => [
  section("compliance", "Compliance", 1, true, "always", ["compliance"]),
  section("company_profile", "Company profile", 2, true, "always", ["experience"]),
  section("rooms", "Room responses", 3, true, "always", ["technical_approach"]),
  section("crew", "Crew", 4, true, "always", ["staffing"]),
  section("travel", "Travel and lodging", 5, true, "travel_flagged", ["travel"]),
  section("pricing", "Pricing", 6, true, "always", ["commercial"]),
  section("alternates", "Alternates", 7, false),
  section("references", "References", 8, true, "always", ["experience"]),
  section("documents", "Documents", 9, true, "always", ["compliance"]),
  section("value_adds", "Value adds", 10, false),
  section("review", "Review and submit", 11, true),
];

const crewRoles = (proposal: ProposalV1) => {
  const labels = new Set<string>(["Technical director", "AV technician"]);
  for (const room of proposal.content.rooms) {
    for (const role of room.production?.crewRoles ?? []) {
      if (role.trim()) labels.add(bounded(role.trim(), 120));
    }
  }
  return [...new Map(
    [...labels]
      .sort((left, right) => left.localeCompare(right))
      .map((label) => [
        `role-${identifierPart(label).slice(0, 100)}`,
        { id: `role-${identifierPart(label).slice(0, 100)}`, label },
      ]),
  ).values()];
};

export const projectProposalToVendorResponseQuestionnaire = (
  proposal: ProposalV1,
): VendorResponseQuestionnaireProjection => {
  const currency = proposal.content.budgetPreferences?.budget?.currency
    ?? proposal.presentation?.currency
    ?? "USD";
  const decimalPrecision = proposal.presentation?.decimalPrecision ?? 2;
  const acknowledgementText =
    "I confirm that this response is accurate, complete, and authorized for submission.";
  const roles = crewRoles(proposal);
  const technicalDirector = roles.find((role) => role.id === "role-technical-director");
  const venueLocation = [
    proposal.content.venueSchedule.city,
    proposal.content.venueSchedule.region,
  ].filter(Boolean).join(", ");
  const streamingApplicable = proposal.content.event.format !== "in_person";
  const coiRequired = Boolean(proposal.content.venueTechnical?.coiRequirements?.trim());

  return {
    schemaVersion: "vendor-response-questionnaire.v1",
    questionnaireId: `vendor-questionnaire-${proposal.id}`,
    proposalId: proposal.id,
    proposalVersion: proposal.version,
    status: "published",
    context: {
      proposalTitle: proposal.content.event.name,
      eventFormat: proposal.content.event.format,
      ...(proposal.content.venueSchedule.venueName
        ? { venueName: proposal.content.venueSchedule.venueName }
        : {}),
      ...(venueLocation ? { venueLocation } : {}),
      ...(proposal.content.event.startDate
        ? { eventStartDate: proposal.content.event.startDate }
        : {}),
      ...(proposal.content.event.endDate
        ? { eventEndDate: proposal.content.event.endDate }
        : {}),
      ...(proposal.content.budgetPreferences?.proposalDueDate
        ? { proposalDueDate: proposal.content.budgetPreferences.proposalDueDate }
        : {}),
      ...(proposal.content.contacts.primary.organizationDisplayName
        ? { plannerOrganizationName: proposal.content.contacts.primary.organizationDisplayName }
        : {}),
      currency,
      decimalPrecision,
    },
    identity: {
      vendorNameRequired: true,
      submittedByRequired: true,
      emailRequired: true,
    },
    sections: sections(),
    acknowledgements: [
      {
        acknowledgementId: "response-accuracy",
        label: "Response accuracy",
        text: acknowledgementText,
        textChecksum: stableQuestionnaireChecksum(acknowledgementText),
        required: true,
      },
    ],
    companyProfile: {
      legalNameRequired: true,
      headquartersRequired: true,
      yearsInBusinessEnabled: true,
      staffCountEnabled: true,
      largestComparableEventEnabled: true,
      clientMix: {
        enabled: true,
        required: true,
        categories: [
          { categoryId: "corporate", label: "Corporate" },
          { categoryId: "association", label: "Association" },
          { categoryId: "government", label: "Government" },
          { categoryId: "nonprofit", label: "Nonprofit" },
          { categoryId: "other", label: "Other" },
        ],
      },
      deiPolicyRequired: false,
      sustainabilityPolicyRequired: false,
    },
    rooms: proposal.content.rooms.slice(0, 200).map((room) => ({
      roomId: room.id,
      name: room.function,
      ...(room.location ? { location: room.location } : {}),
      ...(room.setup ? { setup: room.setup } : {}),
      ...([room.scheduleDate, room.showStartAt, room.showEndAt].some(Boolean)
        ? {
            scheduleSummary: [room.scheduleDate, room.showStartAt, room.showEndAt]
              .filter(Boolean)
              .join(" | "),
          }
        : {}),
      ...(room.estimatedAttendees !== undefined
        ? { estimatedAttendees: room.estimatedAttendees }
        : {}),
      streamingApplicable,
      specs: roomSpecs(room),
    })),
    hybrid: {
      platformPlanRequired: streamingApplicable,
      platformPlanMaxWords: 300,
      roomPlanMaxWords: 200,
      externalUrlsAllowed: false,
    },
    crew: {
      roles,
      requiredRoleIds: technicalDirector ? [technicalDirector.id] : [],
      bioMaxWords: 200,
      headshotAllowed: true,
      headshotRequired: false,
    },
    pricing: {
      currency,
      decimalPrecision,
      equipmentCategories: [
        { id: "audio", label: "Audio" },
        { id: "video", label: "Video" },
        { id: "lighting", label: "Lighting" },
        { id: "staging-scenic", label: "Staging and scenic" },
        { id: "networking", label: "Networking" },
        { id: "other", label: "Other" },
      ],
      feeLines: [
        { feeId: "service-fee", label: "Service fee", kind: "fee", required: false },
        { feeId: "sales-tax", label: "Sales tax", kind: "tax", required: false },
      ],
      travelSubtotalRequired: false,
      discountRequired: false,
      assumptionsAllowed: true,
    },
    alternates: { enabled: true, minimumCount: 0, maximumCount: 20 },
    references: {
      enabled: true,
      minimumCount: 1,
      maximumCount: 3,
      maxAgeMonths: 36,
      maxVisualsPerReference: 5,
    },
    documents: {
      categories: [
        {
          purposeId: "dei-policy",
          label: "DEI policy",
          required: false,
          minimumFiles: 0,
          maximumFiles: 3,
          maximumFileBytes: 10_000_000,
          allowedMimeTypes: ["application/pdf"],
        },
        {
          purposeId: "sustainability-policy",
          label: "Sustainability policy",
          required: false,
          minimumFiles: 0,
          maximumFiles: 3,
          maximumFileBytes: 10_000_000,
          allowedMimeTypes: ["application/pdf"],
        },
        {
          purposeId: "certificate-of-insurance",
          label: "Certificate of insurance",
          required: coiRequired,
          minimumFiles: coiRequired ? 1 : 0,
          maximumFiles: 3,
          maximumFileBytes: 10_000_000,
          allowedMimeTypes: ["application/pdf"],
        },
        {
          purposeId: "other-proposal-document",
          label: "Other proposal document",
          required: false,
          minimumFiles: 0,
          maximumFiles: 20,
          maximumFileBytes: 10_000_000,
          allowedMimeTypes: [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/jpeg",
            "image/png",
          ],
        },
      ],
      globalMaximumFiles: 20,
    },
    valueAdds: { enabled: true, required: false, maxWords: 300 },
  };
};

export const questionnaireProjectionChecksum = (
  projection: VendorResponseQuestionnaireProjection,
): string =>
  stableQuestionnaireChecksum({
    projectionVersion: VENDOR_RESPONSE_QUESTIONNAIRE_PROJECTION_VERSION,
    projection,
  });

export const publishQuestionnaireProjection = (
  projection: VendorResponseQuestionnaireProjection,
  questionnaireVersion: number,
  publishedAt: string,
): VendorResponseQuestionnaireV1 => {
  const withoutChecksum = {
    ...projection,
    questionnaireVersion,
    publishedAt,
  };
  return {
    ...withoutChecksum,
    questionnaireChecksum: stableQuestionnaireChecksum(withoutChecksum),
  };
};
