import proposalSchema from "../../../contracts/proposal/v1/proposal.v1.schema.json";
import proposalFormUi from "../../../contracts/proposal/v1/proposal-form-ui.v1.json";
import {
  isRetiredCanonicalProposalWorkflowPath,
  proposalWorkflowSectionEnabled,
} from "../proposals/domain/workflowSections";
import type { AssistantPromptEvidence } from "./domain";

export const PROPOSAL_FORM_GUIDANCE_VERSION = "proposal-form-guidance.v4";
export const PROPOSAL_FORM_SCHEMA_VERSION = "proposal.v1";
export const PROPOSAL_FORM_GUIDANCE_OWNER = "Product Operations";
export const PROPOSAL_FORM_GUIDANCE_REVIEW_DATE = "2026-10-29";

export type ProposalFormRequirement = "required" | "optional" | "conditional";
export type ProposalFormFieldType =
  | "text"
  | "long_text"
  | "number"
  | "date"
  | "time"
  | "date_time"
  | "email"
  | "url"
  | "yes_no"
  | "select"
  | "radio"
  | "multi_select"
  | "money"
  | "measurement";

export type ProposalFormCondition = {
  fieldKey: string;
  operator: "equals" | "one_of" | "present";
  value?: string | readonly string[];
};

export type ProposalFormOption = {
  value: string;
  label: string;
};

export type ProposalFormOptionGroup = {
  label: string;
  options: readonly ProposalFormOption[];
};

export type ProposalFormSection = {
  id:
    | "event_overview"
    | "venue_schedule"
    | "room_specifications"
    | "hybrid_virtual"
    | "content_creative"
    | "video_recording"
    | "venue_technical"
    | "investment_evaluation"
    | "uploads_covendors"
    | "contact_submit";
  step: number;
  badge: string;
  label: string;
  description: string;
  canonicalRoots: readonly string[];
  component: string;
  visibility?: readonly ProposalFormCondition[];
};

export type ProposalFormFieldGuidance = {
  fieldKey: string;
  canonicalPath: string;
  sectionId: ProposalFormSection["id"];
  sectionLabel: string;
  label: string;
  fieldType: ProposalFormFieldType;
  requirement: ProposalFormRequirement;
  visibilityConditions: readonly ProposalFormCondition[];
  dependencies: readonly string[];
  purpose: string;
  entryGuidance: string;
  goodExample: string;
  commonMistakes: readonly string[];
  followUpQuestions: readonly string[];
  allowedOptions: readonly ProposalFormOption[];
  optionGroups: readonly ProposalFormOptionGroup[];
  minimumSelections?: number;
  maximumSelections?: number;
  approvedSourceIds: readonly string[];
  applicationSchemaVersion: typeof PROPOSAL_FORM_SCHEMA_VERSION;
  guidanceVersion: typeof PROPOSAL_FORM_GUIDANCE_VERSION;
  owner: typeof PROPOSAL_FORM_GUIDANCE_OWNER;
  reviewDate: typeof PROPOSAL_FORM_GUIDANCE_REVIEW_DATE;
};

type ProposalFormUiField = {
  label: string;
  requirement: ProposalFormRequirement;
  controlType: ProposalFormFieldType;
  helperText: string;
  example: string;
  minimumSelections?: number;
  maximumSelections?: number;
  options?: readonly ProposalFormOption[];
  optionGroups?: readonly ProposalFormOptionGroup[];
};

const proposalFormUiFields = proposalFormUi.fields as Record<
  string,
  ProposalFormUiField
>;

type JsonSchema = {
  $ref?: string;
  type?: string | readonly string[];
  format?: string;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: readonly string[];
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  minLength?: number;
  examples?: readonly unknown[];
  default?: unknown;
};

const schema = proposalSchema as unknown as JsonSchema & {
  $defs: Record<string, JsonSchema>;
};

export const ALL_PROPOSAL_FORM_SECTIONS: readonly ProposalFormSection[] =
  Object.freeze([
    {
      id: "event_overview",
      step: 1,
      badge: "1",
      label: "Event Overview",
      description: "Event identity, audience, format, objectives, and narrative.",
      canonicalRoots: ["/content/event"],
      component: "EventForm.tsx",
    },
    {
      id: "venue_schedule",
      step: 2,
      badge: "2",
      label: "Venue & Schedule",
      description: "Venue, union, time zone, room count, and master schedule.",
      canonicalRoots: ["/content/venueSchedule"],
      component: "VenueScheduleStep.tsx",
    },
    {
      id: "room_specifications",
      step: 3,
      badge: "2B",
      label: "Room Specifications",
      description: "Room-by-room schedule, AV, production, lighting, and crew.",
      canonicalRoots: ["/content/rooms"],
      component: "RoomAndProductionStep.tsx",
    },
    {
      id: "hybrid_virtual",
      step: 4,
      badge: "3",
      label: "Hybrid & Virtual",
      description: "Streaming, remote speakers, captions, and virtual audience.",
      canonicalRoots: ["/content/hybridVirtual"],
      component: "HybridVirtualStep.tsx",
      visibility: [
        {
          fieldKey: "/content/event/format",
          operator: "one_of",
          value: ["hybrid", "virtual"],
        },
      ],
    },
    {
      id: "content_creative",
      step: 5,
      badge: "4",
      label: "Content & Creative",
      description: "Creative services, content ownership, and brand direction.",
      canonicalRoots: ["/content/contentCreative"],
      component: "ContentCreativeStep.tsx",
    },
    {
      id: "video_recording",
      step: 6,
      badge: "5",
      label: "Video Recording",
      description: "Camera plan, recording workflow, and deliverables.",
      canonicalRoots: ["/content/videoRecording"],
      component: "VideoRecordingStep.tsx",
    },
    {
      id: "venue_technical",
      step: 7,
      badge: "6",
      label: "Venue & Technical",
      description: "Venue contacts, rigging, power, internet, insurance, and access.",
      canonicalRoots: ["/content/venueTechnical"],
      component: "VenueTechnicalRequirements.tsx",
    },
    {
      id: "investment_evaluation",
      step: 8,
      badge: "7",
      label: "Investment & Evaluation",
      description: "Budget, evaluation priorities, procurement dates, and bid preferences.",
      canonicalRoots: ["/content/budgetPreferences"],
      component: "BudgetProposalPreferences.tsx",
    },
    {
      id: "uploads_covendors",
      step: 9,
      badge: "8",
      label: "Uploads & Co-Vendors",
      description: "Reference materials, partner coordination, and confidentiality.",
      canonicalRoots: [
        "/content/sourceReferences",
        "/content/vendorCoordination",
        "/content/confidentiality",
      ],
      component: "UploadsReferenceMaterials.tsx",
    },
    {
      id: "contact_submit",
      step: 10,
      badge: "9",
      label: "Contact & Submit",
      description: "Primary contact, additional contacts, preferences, and final notes.",
      canonicalRoots: ["/content/contacts"],
      component: "ContactInfo.tsx",
    },
  ]);

export const PROPOSAL_FORM_SECTIONS: readonly ProposalFormSection[] =
  Object.freeze(
    ALL_PROPOSAL_FORM_SECTIONS.filter((section) =>
      proposalWorkflowSectionEnabled(section.id),
    ),
  );

const UI_EXCLUSIONS = new Map<string, string>([
  ["/content/rooms/*/id", "Generated room identity, not a user-entered field."],
  ["/content/sourceReferences/*/sourceId", "Generated source identity."],
  ["/content/sourceReferences/*/sourceVersionId", "Generated source-version identity."],
  ["/content/sourceReferences/*/category", "Derived from the upload slot."],
  ["/content/contacts/primary/fullName", "Derived from first and last name."],
  ["/content/contacts/additional/*/firstName", "The current UI collects one full-name value."],
  ["/content/contacts/additional/*/lastName", "The current UI collects one full-name value."],
  ["/content/contacts/additional/*/organizationDisplayName", "Not exposed for additional contacts."],
  ["/content/contacts/additional/*/organizationLegalName", "Not exposed for additional contacts."],
  ["/content/contacts/additional/*/phoneExtension", "Not exposed for additional contacts."],
  ["/content/contacts/additional/*/phoneType", "Not exposed for additional contacts."],
]);

export const PROPOSAL_FORM_UI_EXCLUSIONS: ReadonlyMap<string, string> =
  UI_EXCLUSIONS;

const proposalFormPathExcluded = (path: string): boolean =>
  UI_EXCLUSIONS.has(path) || isRetiredCanonicalProposalWorkflowPath(path);

const LABEL_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "/content/event/name": "Event Name",
  "/content/event/edition": "Edition / Year",
  "/content/event/attendeeCount": "Total In-Person Attendance",
  "/content/event/primaryAudiences/*": "Primary Audience",
  "/content/event/sacredConstraints": "Sacred Constraints",
  "/content/event/organizationBackground": "About the Organization",
  "/content/event/rfpTimelineNotes": "RFP Timeline",
  "/content/venueSchedule/unionVenue": "Is This a Union Venue?",
  "/content/venueSchedule/roomCount": "Number of Event Rooms",
  "/content/rooms/*/function": "Room / Function Name",
  "/content/rooms/*/estimatedAttendees": "Estimated Attendees in Room",
  "/content/rooms/*/audio/podiumMicRequired": "Podium Microphone Required",
  "/content/rooms/*/audio/wirelessMicCount": "Wireless Microphone Quantity",
  "/content/rooms/*/video/audienceQaMethod": "Audience Q&A Microphone Method",
  "/content/rooms/*/production/crewRoles/*": "Show Crew Roles",
  "/content/hybridVirtual/platformIntegrationWithAv": "Platform Integration with AV",
  "/content/hybridVirtual/remoteSpeakers/required": "Remote Speakers",
  "/content/hybridVirtual/closedCaptions/required": "Closed Captions",
  "/content/contentCreative/servicesRequired": "Creative / Content Services Needed",
  "/content/videoRecording/required": "Video Recording Required",
  "/content/videoRecording/imagRequired": "IMAG Required",
  "/content/venueTechnical/avContact/name": "Venue AV Contact Name",
  "/content/venueTechnical/coiRequirements": "Certificate of Insurance Requirements",
  "/content/budgetPreferences/budgetBand": "Estimated AV Budget",
  "/content/budgetPreferences/proposalDueDate": "Proposal Submission Due Date",
  "/content/contacts/primary/organizationDisplayName": "Organization Display Name",
  "/content/contacts/primary/organizationLegalName": "Organization Legal Name",
  "/content/contacts/additionalNotes": "Anything Else We Should Know?",
});

const PURPOSE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "/content/event/sacredConstraints":
    "Records non-negotiable requirements that the proposal and production plan must protect.",
  "/content/event/objectives":
    "Defines the outcomes the event and the resulting production plan should support.",
  "/content/venueSchedule/roomCount":
    "Establishes how many room-level schedules and production scopes must be planned.",
  "/content/rooms/*/video/audienceQaMethod":
    "Defines how audience questions will reach presenters so microphone and staffing needs can be reviewed.",
  "/content/hybridVirtual/streamingPlatform":
    "Identifies the platform the production workflow must connect to and test.",
  "/content/budgetPreferences/budgetBand":
    "Gives vendors a planning range without authorizing spend or replacing an approved estimate.",
  "/content/venueTechnical/coiRequirements":
    "Captures insurance wording, additional-insured requirements, and submission deadlines from the venue.",
});

const EXAMPLE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "/content/event/name": "Apex Dynamics Global Summit 2026",
  "/content/event/objectives":
    "Launch the new partner program and schedule 30 qualified customer meetings.",
  "/content/event/sacredConstraints":
    "The CEO keynote must start at 9:00 AM and run exactly 22 minutes.",
  "/content/venueSchedule/venueName": "Javits Center",
  "/content/venueSchedule/roomCount": "4",
  "/content/rooms/*/function": "Main Keynote Ballroom",
  "/content/rooms/*/video/audienceQaMethod": "Two roaming wireless microphones",
  "/content/hybridVirtual/streamingPlatform": "Zoom Events",
  "/content/videoRecording/cameraCount": "3",
  "/content/venueTechnical/coiRequirements":
    "Certificate due 10 business days before load-in; venue and owner listed as additional insured.",
  "/content/budgetPreferences/budgetBand": "$250,000–$350,000",
  "/content/contacts/primary/email": "events@example.com",
});

const resolveSchema = (value: JsonSchema): JsonSchema => {
  if (!value.$ref) return value;
  const segments = value.$ref.replace(/^#\//, "").split("/");
  let current: unknown = schema;
  for (const segment of segments) {
    current = (current as Record<string, unknown>)[segment];
  }
  return resolveSchema(current as JsonSchema);
};

type SchemaLeaf = {
  canonicalPath: string;
  schema: JsonSchema;
  required: boolean;
};

const schemaLeaves = (
  node: JsonSchema,
  path: string,
  inheritedRequired = true,
): SchemaLeaf[] => {
  const resolved = resolveSchema(node);
  if (resolved.type === "array" && resolved.items) {
    const item = resolveSchema(resolved.items);
    if (item.properties || item.type === "object") {
      return schemaLeaves(item, `${path}/*`, inheritedRequired);
    }
    return [{ canonicalPath: `${path}/*`, schema: item, required: inheritedRequired }];
  }
  if (resolved.properties) {
    const requiredKeys = new Set(resolved.required ?? []);
    return Object.entries(resolved.properties).flatMap(([key, child]) =>
      schemaLeaves(
        child,
        `${path}/${key}`,
        inheritedRequired && requiredKeys.has(key),
      ),
    );
  }
  return [{ canonicalPath: path, schema: resolved, required: inheritedRequired }];
};

const proposalContentSchema = resolveSchema(
  resolveSchema(schema.properties!.content),
);

export const PROPOSAL_FORM_SCHEMA_LEAF_PATHS: readonly string[] = Object.freeze(
  schemaLeaves(proposalContentSchema, "/content")
    .map((leaf) => leaf.canonicalPath)
    .sort(),
);

const sectionForPath = (path: string): ProposalFormSection | undefined =>
  PROPOSAL_FORM_SECTIONS.find((section) =>
    section.canonicalRoots.some(
      (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}/*/`),
    ),
  );

const humanize = (value: string): string =>
  value
    .replace(/\*/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();

const labelForPath = (path: string): string => {
  const overridden = LABEL_OVERRIDES[path];
  if (overridden) return overridden;
  const parts = path.split("/").filter((part) => part && part !== "*");
  const leaf = parts.at(-1) ?? "Field";
  if (["required", "count", "type", "name", "date", "time", "value"].includes(leaf)) {
    const parent = parts.at(-2);
    if (parent) return humanize(`${parent} ${leaf}`);
  }
  return humanize(leaf);
};

const typeForSchema = (
  field: JsonSchema,
  canonicalPath: string,
): ProposalFormFieldType => {
  const resolved = resolveSchema(field);
  const variants = resolved.oneOf ?? resolved.anyOf ?? resolved.allOf ?? [];
  const variantTypes = variants.map(resolveSchema).map((item) => item.type);
  const type = Array.isArray(resolved.type)
    ? resolved.type.find((item) => item !== "null")
    : resolved.type ?? variantTypes.find((item) => item && item !== "null");
  if (canonicalPath.endsWith("/amountMinor")) return "money";
  if (canonicalPath.endsWith("/value") && /(?:Size|Pitch|Amperage)/.test(canonicalPath)) {
    return "measurement";
  }
  if (resolved.format === "date") return "date";
  if (resolved.format === "time") return "time";
  if (resolved.format === "date-time") return "date_time";
  if (resolved.format === "email") return "email";
  if (resolved.format === "uri") return "url";
  if (type === "boolean") return "yes_no";
  if (type === "integer" || type === "number") return "number";
  if (type === "array") return "multi_select";
  if (resolved.enum || variants.some((item) => resolveSchema(item).enum)) return "select";
  if ((resolved.minLength ?? 0) > 300 || /notes|objectives|background|statement|requirements/i.test(canonicalPath)) {
    return "long_text";
  }
  return "text";
};

const conditionalRulesForPath = (
  path: string,
  section: ProposalFormSection,
): readonly ProposalFormCondition[] => {
  const rules: ProposalFormCondition[] = [...(section.visibility ?? [])];
  const conditionalParents: readonly [RegExp, ProposalFormCondition][] = [
    [
      /^\/content\/contentCreative\/(?!servicesRequired)/,
      {
        fieldKey: "/content/contentCreative/servicesRequired",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/videoRecording\/(?!required)/,
      {
        fieldKey: "/content/videoRecording/required",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/hybridVirtual\/remoteSpeakers\/(?!required)/,
      {
        fieldKey: "/content/hybridVirtual/remoteSpeakers/required",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/hybridVirtual\/closedCaptions\/(?!required)/,
      {
        fieldKey: "/content/hybridVirtual/closedCaptions/required",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/venueTechnical\/(?:riggingPlotOrSpecs|trussAndMotorsProvided|liftsProvided)$/,
      {
        fieldKey: "/content/venueTechnical/riggingRequired",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/venueTechnical\/(?:powerDropAmperage|powerDropCount)/,
      {
        fieldKey: "/content/venueTechnical/powerDropsRequired",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/venueTechnical\/internetUseCases/,
      {
        fieldKey: "/content/venueTechnical/wirelessInternetRequired",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/confidentiality\/(?!ndaRequired)/,
      {
        fieldKey: "/content/confidentiality/ndaRequired",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/budgetPreferences\/vendorPresentationDate$/,
      {
        fieldKey: "/content/budgetPreferences/vendorPresentation",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/budgetPreferences\/proposalCount$/,
      {
        fieldKey: "/content/budgetPreferences/competitiveBid",
        operator: "equals",
        value: "true",
      },
    ],
    [
      /^\/content\/budgetPreferences\/referralSourceOther$/,
      {
        fieldKey: "/content/budgetPreferences/referralSource",
        operator: "equals",
        value: "Other",
      },
    ],
  ];
  for (const [pattern, condition] of conditionalParents) {
    if (pattern.test(path)) rules.push(condition);
  }
  return rules;
};

const defaultExample = (
  label: string,
  fieldType: ProposalFormFieldType,
): string => {
  if (fieldType === "date") return "2026-10-15";
  if (fieldType === "time") return "09:00";
  if (fieldType === "date_time") return "October 15, 2026 at 9:00 AM";
  if (fieldType === "number") return "3";
  if (fieldType === "yes_no") return "Yes";
  if (fieldType === "email") return "events@example.com";
  if (fieldType === "url") return "https://example.com/event";
  if (fieldType === "multi_select") return "Select only the options that apply.";
  return `A concise, confirmed ${label.toLocaleLowerCase("en-US")} value.`;
};

const flattenedUiOptions = (
  field: ProposalFormUiField | undefined,
): readonly ProposalFormOption[] =>
  Object.freeze([
    ...(field?.options ?? []),
    ...(field?.optionGroups ?? []).flatMap((group) => group.options),
  ]);

const selectionInstruction = (
  field: ProposalFormUiField | undefined,
): string | null => {
  const optionCount = flattenedUiOptions(field).length;
  if (!field || optionCount === 0) return null;
  if (field.controlType !== "multi_select") {
    return "Choose the one available option that best matches the confirmed event details.";
  }
  if (field.minimumSelections && field.maximumSelections) {
    return `Choose between ${field.minimumSelections} and ${field.maximumSelections} available options.`;
  }
  if (field.maximumSelections) {
    return `Choose up to ${field.maximumSelections} available options.`;
  }
  return "Choose only the available options that apply.";
};

const buildFieldGuidance = (leaf: SchemaLeaf): ProposalFormFieldGuidance | null => {
  if (proposalFormPathExcluded(leaf.canonicalPath)) return null;
  const section = sectionForPath(leaf.canonicalPath);
  if (!section) return null;
  const uiField = proposalFormUiFields[leaf.canonicalPath];
  const label = uiField?.label ?? labelForPath(leaf.canonicalPath);
  const fieldType = uiField?.controlType ?? typeForSchema(leaf.schema, leaf.canonicalPath);
  const visibilityConditions = conditionalRulesForPath(leaf.canonicalPath, section);
  const requirement: ProposalFormRequirement = visibilityConditions.length
    ? "conditional"
    : uiField?.requirement ?? (leaf.required ? "required" : "optional");
  const dependencies = visibilityConditions.map((condition) => condition.fieldKey);
  const allowedOptions = flattenedUiOptions(uiField);
  const optionGroups = Object.freeze(uiField?.optionGroups ?? []);
  const choose = selectionInstruction(uiField);
  const requirementGuidance =
    requirement === "required"
      ? `The current guided form marks ${label.toLocaleLowerCase("en-US")} as required.`
      : requirement === "conditional"
        ? "Complete this only when the related selection makes it applicable."
        : "This field is optional; leave it blank instead of guessing.";
  return Object.freeze({
    fieldKey: leaf.canonicalPath,
    canonicalPath: leaf.canonicalPath,
    sectionId: section.id,
    sectionLabel: section.label,
    label,
    fieldType,
    requirement,
    visibilityConditions: Object.freeze(visibilityConditions),
    dependencies: Object.freeze([...new Set(dependencies)]),
    purpose:
      uiField?.helperText ??
      PURPOSE_OVERRIDES[leaf.canonicalPath] ??
      `Provides the ${label.toLocaleLowerCase("en-US")} detail used in the ${section.label} section.`,
    entryGuidance: [requirementGuidance, choose].filter(Boolean).join(" "),
    goodExample:
      uiField?.example ??
      EXAMPLE_OVERRIDES[leaf.canonicalPath] ??
      defaultExample(label, fieldType),
    commonMistakes: Object.freeze([
      "Entering an assumption as though it were confirmed.",
      "Using vague wording when a date, quantity, owner, or requirement is available.",
    ]),
    followUpQuestions: Object.freeze([
      `Who can confirm the ${label.toLocaleLowerCase("en-US")}?`,
      `Does this apply to every room or only part of the event?`,
    ]),
    allowedOptions,
    optionGroups,
    ...(uiField?.minimumSelections !== undefined
      ? { minimumSelections: uiField.minimumSelections }
      : {}),
    ...(uiField?.maximumSelections !== undefined
      ? { maximumSelections: uiField.maximumSelections }
      : {}),
    approvedSourceIds: Object.freeze([
      "contract:proposal.v1",
      `ui:${section.component}`,
    ]),
    applicationSchemaVersion: PROPOSAL_FORM_SCHEMA_VERSION,
    guidanceVersion: PROPOSAL_FORM_GUIDANCE_VERSION,
    owner: PROPOSAL_FORM_GUIDANCE_OWNER,
    reviewDate: PROPOSAL_FORM_GUIDANCE_REVIEW_DATE,
  });
};

const allLeaves = schemaLeaves(proposalContentSchema, "/content");

export const PROPOSAL_FORM_FIELD_GUIDANCE: readonly ProposalFormFieldGuidance[] =
  Object.freeze(
    allLeaves
      .map(buildFieldGuidance)
      .filter((field): field is ProposalFormFieldGuidance => field !== null)
      .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath)),
  );

const guidanceByKey = new Map(
  PROPOSAL_FORM_FIELD_GUIDANCE.map((field) => [field.fieldKey, field]),
);

export const proposalFormGuidanceForField = (
  fieldKey: string,
): ProposalFormFieldGuidance | undefined => guidanceByKey.get(fieldKey.trim());

const normalizedTerms = (value: string): readonly string[] =>
  value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => {
      if (/^requir(?:e|ed|ement|ements)$/.test(term)) return "require";
      return term.length > 4 && term.endsWith("s") && !term.endsWith("ss")
        ? term.slice(0, -1)
        : term;
    });

const evidenceForField = (
  field: ProposalFormFieldGuidance,
): AssistantPromptEvidence => {
  const groupedOptions = field.optionGroups.map(
    (group) =>
      `${group.label}: ${group.options.map((option) => option.label).join(", ")}`,
  );
  const ungroupedOptions =
    field.optionGroups.length === 0 && field.allowedOptions.length > 0
      ? [`Available options: ${field.allowedOptions.map((option) => option.label).join(", ")}`]
      : [];
  return {
    id: `form-field:${field.sectionId}:${field.fieldKey}`,
    title: `${field.sectionLabel}: ${field.label}`,
    content: [
      `${field.label} is ${field.requirement} in the current guided form.`,
      field.purpose,
      field.entryGuidance,
      ...(groupedOptions.length > 0
        ? [`Available option groups — ${groupedOptions.join("; ")}.`]
        : ungroupedOptions.map((options) => `${options}.`)),
      `Example: ${field.goodExample}`,
      `Common mistakes: ${field.commonMistakes.join(" ")}`,
      `Useful follow-up: ${field.followUpQuestions[0]}`,
    ].join(" "),
    href: "/proposals/add-new-proposal",
    sourceType: "platform_fact",
    trust: "trusted_platform_fact",
    releaseId: PROPOSAL_FORM_GUIDANCE_VERSION,
  };
};

export const proposalFormGuidanceEvidenceForField = (
  fieldKey: string,
): AssistantPromptEvidence | undefined => {
  const field = proposalFormGuidanceForField(fieldKey);
  return field ? evidenceForField(field) : undefined;
};

export const proposalFormGuidanceEvidenceForQuery = (
  query: string,
  limit = 3,
): AssistantPromptEvidence[] => {
  const normalized = query.toLocaleLowerCase("en-US");
  const requestsFieldGuidance =
    /\b(?:field|form|enter|input|fill|blank|required|optional|example|collect|provide|include|sacred constraint|what belongs|what information)\b/i.test(
      query,
    ) ||
    PROPOSAL_FORM_FIELD_GUIDANCE.some((field) =>
      normalized.includes(field.label.toLocaleLowerCase("en-US")),
    );
  if (!requestsFieldGuidance) return [];
  const terms = new Set(normalizedTerms(query));
  const scored = PROPOSAL_FORM_FIELD_GUIDANCE.map((field, index) => {
    const searchable = [
      field.label,
      field.sectionLabel,
      field.canonicalPath,
      field.purpose,
    ].join(" ");
    const fieldTerms = normalizedTerms(searchable);
    const labelTerms = normalizedTerms(field.label);
    const exactLabel =
      normalized.includes(field.label.toLocaleLowerCase("en-US")) ||
      (labelTerms.length > 0 && labelTerms.every((term) => terms.has(term)));
    const score =
      (exactLabel ? 20 : 0) +
      fieldTerms.filter((term) => terms.has(term)).length;
    return { field, index, score };
  })
    .filter((item) => item.score > 1)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, 5)));
  return scored.map((item) => evidenceForField(item.field));
};

export const proposalFormGuidanceCoverage = (): {
  schemaLeafCount: number;
  guidedFieldCount: number;
  excludedFieldCount: number;
  uncoveredPaths: readonly string[];
} => {
  const covered = new Set(PROPOSAL_FORM_FIELD_GUIDANCE.map((field) => field.canonicalPath));
  const uncoveredPaths = PROPOSAL_FORM_SCHEMA_LEAF_PATHS.filter(
    (path) => !covered.has(path) && !proposalFormPathExcluded(path),
  );
  const excludedFieldCount = PROPOSAL_FORM_SCHEMA_LEAF_PATHS.filter(
    proposalFormPathExcluded,
  ).length;
  return {
    schemaLeafCount: PROPOSAL_FORM_SCHEMA_LEAF_PATHS.length,
    guidedFieldCount: PROPOSAL_FORM_FIELD_GUIDANCE.length,
    excludedFieldCount,
    uncoveredPaths,
  };
};
