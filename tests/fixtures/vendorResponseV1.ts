import type { VendorResponseQuestionnaireV1 } from "../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseV1 } from "../../contracts/generated/vendor-response-v1";

const checksum = "a".repeat(64);
const acknowledgementChecksum = "b".repeat(64);

export const buildQuestionnaireRooms = (
  count: number,
  streamingRoomIds: ReadonlySet<string> = new Set(["room-1"]),
): VendorResponseQuestionnaireV1["rooms"] =>
  Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const roomId = `room-${ordinal}`;
    return {
      roomId,
      name: `Room ${ordinal}`,
      location: `Level ${ordinal}`,
      setup: "General session",
      scheduleSummary: "09:00-17:00",
      estimatedAttendees: 100 + ordinal,
      streamingApplicable: streamingRoomIds.has(roomId),
      specs: [
        {
          specId: `spec-${ordinal}-display`,
          category: "video",
          label: "Display system",
          requirementText: "Provide the specified display system.",
          sourcePath: `rooms.${roomId}.display`,
          allowedResponses: ["comply", "substitute", "exception"],
          noteMaxLength: 500,
        },
      ],
    };
  });

export const buildVendorResponseQuestionnaire = (
  roomCount = 2,
  streamingRoomIds: ReadonlySet<string> = new Set(["room-1"]),
): VendorResponseQuestionnaireV1 => ({
  schemaVersion: "vendor-response-questionnaire.v1",
  questionnaireId: "questionnaire-1",
  questionnaireVersion: 1,
  questionnaireChecksum: checksum,
  proposalId: "proposal-1",
  proposalVersion: 3,
  status: "published",
  context: {
    proposalTitle: "Annual leadership event",
    eventFormat: streamingRoomIds.size > 0 ? "hybrid" : "in_person",
    venueName: "Example Convention Center",
    venueLocation: "Chicago, IL",
    eventStartDate: "2027-02-01",
    eventEndDate: "2027-02-03",
    proposalDueDate: "2026-12-01",
    plannerOrganizationName: "Example Planner",
    currency: "USD",
    decimalPrecision: 2,
  },
  identity: {
    vendorNameRequired: true,
    submittedByRequired: true,
    emailRequired: true,
  },
  sections: [
    { sectionId: "compliance", title: "Compliance", order: 1, enabled: true, required: true, condition: "always", evaluationMappings: ["compliance"] },
    { sectionId: "company_profile", title: "Company profile", order: 2, enabled: true, required: true, condition: "always", evaluationMappings: ["experience"] },
    { sectionId: "rooms", title: "Rooms", order: 3, enabled: true, required: true, condition: "always", evaluationMappings: ["technical"] },
    { sectionId: "crew", title: "Crew", order: 4, enabled: true, required: true, condition: "always", evaluationMappings: ["staffing"] },
    { sectionId: "travel", title: "Travel", order: 5, enabled: true, required: true, condition: "travel_flagged", evaluationMappings: ["travel"] },
    { sectionId: "pricing", title: "Pricing", order: 6, enabled: true, required: true, condition: "always", evaluationMappings: ["price"] },
    { sectionId: "alternates", title: "Alternates", order: 7, enabled: true, required: false, condition: "always", evaluationMappings: [] },
    { sectionId: "references", title: "References", order: 8, enabled: true, required: true, condition: "always", evaluationMappings: ["references"] },
    { sectionId: "documents", title: "Documents", order: 9, enabled: true, required: true, condition: "always", evaluationMappings: ["policies"] },
    { sectionId: "value_adds", title: "Value adds", order: 10, enabled: true, required: false, condition: "always", evaluationMappings: [] },
    { sectionId: "review", title: "Review", order: 11, enabled: true, required: true, condition: "always", evaluationMappings: [] },
  ],
  acknowledgements: [
    {
      acknowledgementId: "ack-terms",
      label: "Terms",
      text: "I acknowledge the proposal terms.",
      textChecksum: acknowledgementChecksum,
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
      ],
    },
    deiPolicyRequired: true,
    sustainabilityPolicyRequired: false,
  },
  rooms: buildQuestionnaireRooms(roomCount, streamingRoomIds),
  hybrid: {
    platformPlanRequired: true,
    platformPlanMaxWords: 300,
    roomPlanMaxWords: 200,
    externalUrlsAllowed: false,
  },
  crew: {
    roles: [
      { id: "technical-director", label: "Technical director" },
      { id: "av-technician", label: "AV technician" },
    ],
    requiredRoleIds: ["technical-director"],
    bioMaxWords: 200,
    headshotAllowed: true,
    headshotRequired: false,
  },
  pricing: {
    currency: "USD",
    decimalPrecision: 2,
    equipmentCategories: [
      { id: "video", label: "Video" },
      { id: "audio", label: "Audio" },
    ],
    feeLines: [
      { feeId: "service-fee", label: "Service fee", kind: "fee", required: true },
      { feeId: "sales-tax", label: "Sales tax", kind: "tax", required: true },
    ],
    travelSubtotalRequired: true,
    discountRequired: true,
    assumptionsAllowed: true,
  },
  alternates: { enabled: true, minimumCount: 0, maximumCount: 10 },
  references: { enabled: true, minimumCount: 1, maximumCount: 3, maxAgeMonths: 36, maxVisualsPerReference: 3 },
  documents: {
    categories: [
      {
        purposeId: "dei-policy",
        label: "DEI policy",
        required: true,
        minimumFiles: 1,
        maximumFiles: 2,
        maximumFileBytes: 10_000_000,
        allowedMimeTypes: ["application/pdf"],
      },
    ],
    globalMaximumFiles: 20,
  },
  valueAdds: { enabled: true, required: false, maxWords: 200 },
  publishedAt: "2026-09-14T12:00:00.000Z",
});

export const buildEmptyVendorResponseQuestionnaire = (): VendorResponseQuestionnaireV1 => {
  const questionnaire = buildVendorResponseQuestionnaire(0, new Set());
  questionnaire.context.eventFormat = "in_person";
  return questionnaire;
};

export const buildEmptyVendorResponse = (
  questionnaire: VendorResponseQuestionnaireV1,
): VendorResponseV1 => ({
  schemaVersion: "vendor-response.v1",
  questionnaire: {
    questionnaireId: questionnaire.questionnaireId,
    questionnaireVersion: questionnaire.questionnaireVersion,
    questionnaireChecksum: questionnaire.questionnaireChecksum,
    proposalId: questionnaire.proposalId,
    proposalVersion: questionnaire.proposalVersion,
  },
  identity: { vendorName: "", submittedBy: "", email: "" },
  acknowledgements: [],
  companyProfile: { legalName: "", headquarters: "", largestComparableEvent: "", clientMix: [] },
  platformIntegrationPlan: "",
  rooms: [],
  crew: [],
  travel: { lodgingRequests: [] },
  pricing: {
    travelSubtotal: { amountMinor: 0, currency: questionnaire.pricing.currency },
    fees: [],
    discount: { amountMinor: 0, currency: questionnaire.pricing.currency },
    assumptionsExclusions: [],
  },
  alternates: [],
  references: [],
  documents: [],
  valueAdds: "",
});

export const buildCompleteVendorResponse = (
  questionnaire: VendorResponseQuestionnaireV1,
  withTravel = true,
): VendorResponseV1 => {
  const response = buildEmptyVendorResponse(questionnaire);
  response.identity = {
    vendorName: "Example AV",
    submittedBy: "Taylor Vendor",
    email: "taylor@example.com",
  };
  response.acknowledgements = questionnaire.acknowledgements.map((entry) => ({
    acknowledgementId: entry.acknowledgementId,
    accepted: true,
    acceptedAt: "2026-09-14T13:00:00.000Z",
    textChecksum: entry.textChecksum,
  }));
  response.companyProfile = {
    legalName: "Example AV LLC",
    headquarters: "Chicago, IL",
    yearsInBusiness: 12,
    staffCount: 85,
    largestComparableEvent: "A 2,000-person annual meeting",
    clientMix: questionnaire.companyProfile.clientMix.categories.map((entry) => ({
      categoryId: entry.categoryId,
      percent: 100 / questionnaire.companyProfile.clientMix.categories.length,
    })),
  };
  response.platformIntegrationPlan = questionnaire.rooms.some((room) => room.streamingApplicable)
    ? "We will coordinate platform signals, rehearsals, and monitoring."
    : "";
  response.rooms = questionnaire.rooms.map((room, index) => {
    const ordinal = index + 1;
    const laborLineId = `labor-${ordinal}`;
    const travel = withTravel && index === 0;
    return {
      roomId: room.roomId,
      specResponses: room.specs.map((spec) => ({ specId: spec.specId, status: "comply" as const, note: "" })),
      equipmentLines: [
        { equipmentLineId: `equipment-${ordinal}`, categoryId: "video", description: "Projection and switching package", quantity: 1 },
      ],
      categoryTotals: [
        { categoryId: "video", amount: { amountMinor: 10_000 + ordinal, currency: questionnaire.pricing.currency } },
      ],
      laborLines: [
        { laborLineId, roleId: "av-technician", days: 2, regularHours: 16, overtimeHours: 2, travel, notes: "" },
      ],
      laborSubtotal: { amountMinor: 5_000 + ordinal, currency: questionnaire.pricing.currency },
      ...(room.streamingApplicable
        ? {
            hybrid: {
              feedHandoff: "Program and clean feeds through redundant paths.",
              redundancy: "Primary and backup encoders with monitored failover.",
              virtualAudienceExperience: "Moderated Q&A and accessible playback.",
            },
          }
        : {}),
    };
  });
  response.crew = [
    {
      crewMemberId: "crew-1",
      name: "Alex Director",
      roleId: "technical-director",
      bio: "Technical director with twelve years of large-event experience.",
    },
  ];
  response.travel.lodgingRequests = withTravel && response.rooms[0]
    ? [
        {
          laborLineId: response.rooms[0].laborLines[0].laborLineId,
          roomId: response.rooms[0].roomId,
          clientProvidedRoom: true,
          checkIn: "2027-01-31",
          checkOut: "2027-02-03",
        },
      ]
    : [];
  response.pricing = {
    travelSubtotal: { amountMinor: withTravel ? 2_500 : 0, currency: questionnaire.pricing.currency },
    fees: questionnaire.pricing.feeLines.map((fee, index) => ({
      feeId: fee.feeId,
      amount: { amountMinor: index === 0 ? 1_000 : 500, currency: questionnaire.pricing.currency },
    })),
    discount: { amountMinor: 100, currency: questionnaire.pricing.currency },
    assumptionsExclusions: ["Power and rigging points are provided by the venue."],
  };
  response.references = [
    {
      referenceId: "reference-1",
      clientName: "Example Client",
      contact: { name: "Jordan Client", email: "jordan@example.com", phone: "+1 555 0100" },
      eventName: "Example Summit",
      attendance: 1800,
      servicesProvided: "Full audiovisual production",
      startDate: "2025-10-01",
      endDate: "2025-10-04",
      currentStatus: "Active client",
      comparable: true,
      visualDocumentIds: [],
    },
  ];
  response.documents = [
    { documentId: "document-dei-1", purposeId: "dei-policy", scopeType: "proposal" },
  ];
  return response;
};

export const cloneFixture = <T>(value: T): T => structuredClone(value);
