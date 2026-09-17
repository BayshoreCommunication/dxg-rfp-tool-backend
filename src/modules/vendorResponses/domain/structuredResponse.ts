import type { ErrorObject } from "ajv";
import type { VendorResponseCalculationV1 } from "../../../../contracts/generated/vendor-response-calculation-v1";
import type {
  SectionId,
  VendorResponseQuestionnaireV1,
} from "../../../../contracts/generated/vendor-response-questionnaire-v1";
import type { VendorResponseValidationEnvelopeV1 } from "../../../../contracts/generated/vendor-response-validation-error-v1";
import type { Money, VendorResponseV1 } from "../../../../contracts/generated/vendor-response-v1";
import {
  validateVendorResponseQuestionnaireV1,
  validateVendorResponseV1,
} from "../../../../contracts/vendor-response/v1/validators";

export type VendorResponseValidationIssue =
  VendorResponseValidationEnvelopeV1["errors"][number];
export type VendorResponseValidationMode = "draft" | "final";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sectionForPath = (path: string): string => {
  if (path.startsWith("/companyProfile")) return "company_profile";
  if (path.startsWith("/rooms") || path.startsWith("/platformIntegrationPlan")) return "rooms";
  if (path.startsWith("/crew")) return "crew";
  if (path.startsWith("/travel")) return "travel";
  if (path.startsWith("/pricing")) return "pricing";
  if (path.startsWith("/alternates")) return "alternates";
  if (path.startsWith("/references")) return "references";
  if (path.startsWith("/documents")) return "documents";
  if (path.startsWith("/valueAdds")) return "value_adds";
  return "compliance";
};

const issue = (
  code: string,
  path: string,
  sectionId: string,
  message: string,
): VendorResponseValidationIssue => ({ code, path, sectionId, message });

const contractIssues = (
  errors: ErrorObject[] | null | undefined,
  questionnaire = false,
): VendorResponseValidationIssue[] =>
  (errors ?? []).map((error) => {
    const path = error.instancePath || "/";
    return issue(
      `contract.${error.keyword}`,
      path,
      questionnaire ? "questionnaire" : sectionForPath(path),
      error.message ?? "Contract validation failed",
    );
  });

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
};

const addDuplicateIssues = (
  errors: VendorResponseValidationIssue[],
  values: readonly string[],
  path: string,
  sectionId: string,
  label: string,
): void => {
  for (const value of duplicateValues(values)) {
    errors.push(issue("duplicate_id", path, sectionId, `Duplicate ${label}: ${value}`));
  }
};

const wordCount = (value: string): number => {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};

const isBlank = (value: string | undefined): boolean => !value || value.trim().length === 0;

const parseDateOnly = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? timestamp
    : null;
};

export const roomNightsBetween = (checkIn: string, checkOut: string): number => {
  const start = parseDateOnly(checkIn);
  const end = parseDateOnly(checkOut);
  if (start === null || end === null || end <= start) return 0;
  return Math.floor((end - start) / 86_400_000);
};

/**
 * Whether a date range runs backwards.
 *
 * Distinct from roomNightsBetween, which counts hotel nights and so returns 0
 * for a same-day stay. Ordering a start and an end is a different question: a
 * one-day event is ordinary and ends on the day it starts. Unparseable dates
 * are not an ordering problem — the contract schema rejects those.
 */
export const endsBeforeStart = (startDate: string, endDate: string): boolean => {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (start === null || end === null) return false;
  return end < start;
};

const isSectionApplicable = (
  questionnaire: VendorResponseQuestionnaireV1,
  response: VendorResponseV1,
  sectionId: SectionId,
): boolean => {
  const section = questionnaire.sections.find((candidate) => candidate.sectionId === sectionId);
  if (!section?.enabled) return false;
  if (section.condition === "travel_flagged") {
    return response.rooms.some((room) => room.laborLines.some((line) => line.travel));
  }
  return true;
};

/**
 * Phrase a count requirement without the "between 3 and 3" the naive range
 * wording produces when a questionnaire pins an exact number.
 */
export const countRequirement = (
  verb: string,
  minimum: number,
  maximum: number,
  noun: string,
): string => {
  const plural = (count: number) => (count === 1 ? noun : `${noun}s`);
  if (minimum === maximum) return `${verb} ${minimum} ${plural(minimum)}`;
  return `${verb} between ${minimum} and ${maximum} ${plural(maximum)}`;
};

export const validateVendorResponseQuestionnaire = (
  candidate: unknown,
): VendorResponseValidationIssue[] => {
  if (!validateVendorResponseQuestionnaireV1(candidate)) {
    return contractIssues(validateVendorResponseQuestionnaireV1.errors, true);
  }

  const questionnaire = candidate;
  const errors: VendorResponseValidationIssue[] = [];
  addDuplicateIssues(errors, questionnaire.sections.map((entry) => entry.sectionId), "/sections", "questionnaire", "section ID");
  addDuplicateIssues(errors, questionnaire.sections.map((entry) => String(entry.order)), "/sections", "questionnaire", "section order");
  addDuplicateIssues(errors, questionnaire.acknowledgements.map((entry) => entry.acknowledgementId), "/acknowledgements", "questionnaire", "acknowledgement ID");
  addDuplicateIssues(errors, questionnaire.rooms.map((entry) => entry.roomId), "/rooms", "questionnaire", "room ID");
  addDuplicateIssues(errors, questionnaire.rooms.flatMap((room) => room.specs.map((entry) => entry.specId)), "/rooms/*/specs", "questionnaire", "spec ID");
  addDuplicateIssues(errors, questionnaire.companyProfile.clientMix.categories.map((entry) => entry.categoryId), "/companyProfile/clientMix/categories", "questionnaire", "client mix category ID");
  addDuplicateIssues(errors, questionnaire.crew.roles.map((entry) => entry.id), "/crew/roles", "questionnaire", "crew role ID");
  addDuplicateIssues(errors, questionnaire.pricing.equipmentCategories.map((entry) => entry.id), "/pricing/equipmentCategories", "questionnaire", "equipment category ID");
  addDuplicateIssues(errors, questionnaire.pricing.feeLines.map((entry) => entry.feeId), "/pricing/feeLines", "questionnaire", "fee ID");
  addDuplicateIssues(errors, questionnaire.documents.categories.map((entry) => entry.purposeId), "/documents/categories", "questionnaire", "document purpose ID");

  const roleIds = new Set(questionnaire.crew.roles.map((entry) => entry.id));
  for (const roleId of questionnaire.crew.requiredRoleIds) {
    if (!roleIds.has(roleId)) {
      errors.push(issue("unknown_reference", "/crew/requiredRoleIds", "questionnaire", `Required crew role does not exist: ${roleId}`));
    }
  }
  if (questionnaire.crew.headshotRequired && !questionnaire.crew.headshotAllowed) {
    errors.push(issue("invalid_configuration", "/crew/headshotRequired", "questionnaire", "Headshots cannot be required when uploads are disabled"));
  }
  if (questionnaire.context.currency !== questionnaire.pricing.currency) {
    errors.push(issue("currency_mismatch", "/pricing/currency", "questionnaire", "Context and pricing must use the same currency"));
  }
  if (questionnaire.context.decimalPrecision !== questionnaire.pricing.decimalPrecision) {
    errors.push(issue("precision_mismatch", "/pricing/decimalPrecision", "questionnaire", "Context and pricing must use the same decimal precision"));
  }
  if (questionnaire.context.eventStartDate && questionnaire.context.eventEndDate &&
    endsBeforeStart(questionnaire.context.eventStartDate, questionnaire.context.eventEndDate)) {
    errors.push(issue("invalid_date_range", "/context", "questionnaire", "Event end date cannot be before the event start date"));
  }
  if (questionnaire.alternates.minimumCount > questionnaire.alternates.maximumCount) {
    errors.push(issue("invalid_range", "/alternates", "questionnaire", "Alternate minimum cannot exceed maximum"));
  }
  if (questionnaire.references.minimumCount > questionnaire.references.maximumCount) {
    errors.push(issue("invalid_range", "/references", "questionnaire", "Reference minimum cannot exceed maximum"));
  }
  for (const category of questionnaire.documents.categories) {
    if (category.minimumFiles > category.maximumFiles) {
      errors.push(issue("invalid_range", `/documents/categories/${category.purposeId}`, "questionnaire", "Document minimum cannot exceed maximum"));
    }
    if (category.required && category.minimumFiles === 0) {
      errors.push(issue("invalid_configuration", `/documents/categories/${category.purposeId}/minimumFiles`, "questionnaire", "A required document category must require at least one file"));
    }
  }
  return errors;
};

const requireText = (
  errors: VendorResponseValidationIssue[],
  value: string | undefined,
  path: string,
  sectionId: string,
  label: string,
): void => {
  if (isBlank(value)) errors.push(issue("required", path, sectionId, `${label} is required`));
};

const enforceWordLimit = (
  errors: VendorResponseValidationIssue[],
  value: string,
  maxWords: number,
  path: string,
  sectionId: string,
  label: string,
): void => {
  if (wordCount(value) > maxWords) {
    errors.push(issue("word_limit", path, sectionId, `${label} must be ${maxWords} words or fewer`));
  }
};

const checkMoney = (
  errors: VendorResponseValidationIssue[],
  money: Money,
  currency: string,
  path: string,
): void => {
  if (money.currency !== currency) {
    errors.push(issue("currency_mismatch", `${path}/currency`, "pricing", `Currency must be ${currency}`));
  }
  if (!Number.isSafeInteger(money.amountMinor)) {
    errors.push(issue("unsafe_money", `${path}/amountMinor`, "pricing", "Money must be a safe integer in minor units"));
  }
};

export const validateStructuredVendorResponse = (
  questionnaireCandidate: unknown,
  responseCandidate: unknown,
  mode: VendorResponseValidationMode = "final",
): VendorResponseValidationIssue[] => {
  const questionnaireErrors = validateVendorResponseQuestionnaire(questionnaireCandidate);
  if (questionnaireErrors.length > 0) return questionnaireErrors;
  if (!validateVendorResponseQuestionnaireV1(questionnaireCandidate)) return [];
  if (!validateVendorResponseV1(responseCandidate)) {
    return contractIssues(validateVendorResponseV1.errors);
  }

  const questionnaire = questionnaireCandidate;
  const response = responseCandidate;
  const errors: VendorResponseValidationIssue[] = [];
  const final = mode === "final";
  const currency = questionnaire.pricing.currency;

  const referencePairs: Array<[keyof typeof response.questionnaire, unknown]> = [
    ["questionnaireId", questionnaire.questionnaireId],
    ["questionnaireVersion", questionnaire.questionnaireVersion],
    ["questionnaireChecksum", questionnaire.questionnaireChecksum],
    ["proposalId", questionnaire.proposalId],
    ["proposalVersion", questionnaire.proposalVersion],
  ];
  for (const [key, expected] of referencePairs) {
    if (response.questionnaire[key] !== expected) {
      errors.push(issue("questionnaire_mismatch", `/questionnaire/${key}`, "compliance", `Response ${key} does not match the published questionnaire`));
    }
  }

  addDuplicateIssues(errors, response.acknowledgements.map((entry) => entry.acknowledgementId), "/acknowledgements", "compliance", "acknowledgement response ID");
  addDuplicateIssues(errors, response.companyProfile.clientMix.map((entry) => entry.categoryId), "/companyProfile/clientMix", "company_profile", "client mix category ID");
  addDuplicateIssues(errors, response.rooms.map((entry) => entry.roomId), "/rooms", "rooms", "room response ID");
  addDuplicateIssues(errors, response.rooms.flatMap((room) => room.specResponses.map((entry) => entry.specId)), "/rooms/*/specResponses", "rooms", "spec response ID");
  addDuplicateIssues(errors, response.rooms.flatMap((room) => room.equipmentLines.map((entry) => entry.equipmentLineId)), "/rooms/*/equipmentLines", "rooms", "equipment line ID");
  addDuplicateIssues(errors, response.rooms.flatMap((room) => room.laborLines.map((entry) => entry.laborLineId)), "/rooms/*/laborLines", "rooms", "labor line ID");
  addDuplicateIssues(errors, response.crew.map((entry) => entry.crewMemberId), "/crew", "crew", "crew member ID");
  addDuplicateIssues(errors, response.travel.lodgingRequests.map((entry) => entry.laborLineId), "/travel/lodgingRequests", "travel", "lodging labor line ID");
  addDuplicateIssues(errors, response.pricing.fees.map((entry) => entry.feeId), "/pricing/fees", "pricing", "fee amount ID");
  addDuplicateIssues(errors, response.alternates.map((entry) => entry.alternateId), "/alternates", "alternates", "alternate ID");
  addDuplicateIssues(errors, response.references.map((entry) => entry.referenceId), "/references", "references", "reference ID");
  addDuplicateIssues(errors, response.documents.map((entry) => entry.documentId), "/documents", "documents", "document ID");

  if (final && isSectionApplicable(questionnaire, response, "compliance")) {
    if (questionnaire.identity.vendorNameRequired) requireText(errors, response.identity.vendorName, "/identity/vendorName", "compliance", "Vendor name");
    if (questionnaire.identity.submittedByRequired) requireText(errors, response.identity.submittedBy, "/identity/submittedBy", "compliance", "Submitted by");
    if (questionnaire.identity.emailRequired) requireText(errors, response.identity.email, "/identity/email", "compliance", "Email");
    if (!isBlank(response.identity.email) && !emailPattern.test(response.identity.email)) {
      errors.push(issue("invalid_email", "/identity/email", "compliance", "Email address is invalid"));
    }
  }

  const acknowledgementById = new Map(questionnaire.acknowledgements.map((entry) => [entry.acknowledgementId, entry]));
  const acknowledgementResponseById = new Map(response.acknowledgements.map((entry) => [entry.acknowledgementId, entry]));
  for (const acknowledgementResponse of response.acknowledgements) {
    const definition = acknowledgementById.get(acknowledgementResponse.acknowledgementId);
    if (!definition) {
      errors.push(issue("unknown_reference", `/acknowledgements/${acknowledgementResponse.acknowledgementId}`, "compliance", "Acknowledgement is not part of this questionnaire"));
    } else if (acknowledgementResponse.textChecksum !== definition.textChecksum) {
      errors.push(issue("checksum_mismatch", `/acknowledgements/${definition.acknowledgementId}/textChecksum`, "compliance", "Acknowledgement text has changed"));
    }
  }
  if (final && isSectionApplicable(questionnaire, response, "compliance")) {
    for (const definition of questionnaire.acknowledgements.filter((entry) => entry.required)) {
      const answer = acknowledgementResponseById.get(definition.acknowledgementId);
      if (!answer?.accepted || !answer.acceptedAt) {
        errors.push(issue("required_acknowledgement", `/acknowledgements/${definition.acknowledgementId}`, "compliance", `${definition.label} must be accepted`));
      }
    }
  }

  const clientMixCategoryIds = new Set(questionnaire.companyProfile.clientMix.categories.map((entry) => entry.categoryId));
  for (const entry of response.companyProfile.clientMix) {
    if (!clientMixCategoryIds.has(entry.categoryId)) {
      errors.push(issue("unknown_reference", `/companyProfile/clientMix/${entry.categoryId}`, "company_profile", "Client mix category is not part of this questionnaire"));
    }
  }
  if (final && isSectionApplicable(questionnaire, response, "company_profile")) {
    const configuration = questionnaire.companyProfile;
    if (configuration.legalNameRequired) requireText(errors, response.companyProfile.legalName, "/companyProfile/legalName", "company_profile", "Legal name");
    if (configuration.headquartersRequired) requireText(errors, response.companyProfile.headquarters, "/companyProfile/headquarters", "company_profile", "Headquarters");
    if (configuration.largestComparableEventEnabled) requireText(errors, response.companyProfile.largestComparableEvent, "/companyProfile/largestComparableEvent", "company_profile", "Largest comparable event");
    if (configuration.clientMix.enabled && configuration.clientMix.required) {
      for (const category of configuration.clientMix.categories) {
        if (!response.companyProfile.clientMix.some((entry) => entry.categoryId === category.categoryId)) {
          errors.push(issue("required", `/companyProfile/clientMix/${category.categoryId}`, "company_profile", `${category.label} percentage is required`));
        }
      }
      const total = response.companyProfile.clientMix.reduce((sum, entry) => sum + entry.percent, 0);
      if (Math.abs(total - 100) > 0.000001) {
        errors.push(issue("invalid_total", "/companyProfile/clientMix", "company_profile", "Client mix percentages must total 100"));
      }
    }
  }

  const roomDefinitions = new Map(questionnaire.rooms.map((entry) => [entry.roomId, entry]));
  const roomResponses = new Map(response.rooms.map((entry) => [entry.roomId, entry]));
  const equipmentCategoryIds = new Set(questionnaire.pricing.equipmentCategories.map((entry) => entry.id));
  const roleIds = new Set(questionnaire.crew.roles.map((entry) => entry.id));
  const laborLines = new Map<string, { roomId: string; travel: boolean }>();
  const streamingRequired = questionnaire.rooms.some((room) => room.streamingApplicable);

  if (final && streamingRequired && questionnaire.hybrid.platformPlanRequired) {
    requireText(errors, response.platformIntegrationPlan, "/platformIntegrationPlan", "rooms", "Platform integration plan");
  }
  if (!streamingRequired && !isBlank(response.platformIntegrationPlan)) {
    errors.push(issue("not_applicable", "/platformIntegrationPlan", "rooms", "Platform integration plan is not applicable when no room streams"));
  }
  enforceWordLimit(errors, response.platformIntegrationPlan, questionnaire.hybrid.platformPlanMaxWords, "/platformIntegrationPlan", "rooms", "Platform integration plan");

  for (const roomResponse of response.rooms) {
    const roomDefinition = roomDefinitions.get(roomResponse.roomId);
    if (!roomDefinition) {
      errors.push(issue("unknown_reference", `/rooms/${roomResponse.roomId}`, "rooms", "Room is not part of this questionnaire"));
      continue;
    }
    const specDefinitions = new Map(roomDefinition.specs.map((entry) => [entry.specId, entry]));
    const specResponses = new Map(roomResponse.specResponses.map((entry) => [entry.specId, entry]));
    for (const specResponse of roomResponse.specResponses) {
      const definition = specDefinitions.get(specResponse.specId);
      if (!definition) {
        errors.push(issue("unknown_reference", `/rooms/${roomResponse.roomId}/specResponses/${specResponse.specId}`, "rooms", "Specification is not part of this room"));
      } else {
        if (!definition.allowedResponses.includes(specResponse.status)) {
          errors.push(issue("disallowed_value", `/rooms/${roomResponse.roomId}/specResponses/${specResponse.specId}/status`, "rooms", "Specification response is not allowed"));
        }
        if ((specResponse.status === "substitute" || specResponse.status === "exception") && isBlank(specResponse.note)) {
          errors.push(issue("note_required", `/rooms/${roomResponse.roomId}/specResponses/${specResponse.specId}/note`, "rooms", "A note is required for a substitute or exception"));
        }
        if (specResponse.note.length > definition.noteMaxLength) {
          errors.push(issue("max_length", `/rooms/${roomResponse.roomId}/specResponses/${specResponse.specId}/note`, "rooms", `Note must be ${definition.noteMaxLength} characters or fewer`));
        }
      }
    }
    for (const line of roomResponse.equipmentLines) {
      if (!equipmentCategoryIds.has(line.categoryId)) {
        errors.push(issue("unknown_reference", `/rooms/${roomResponse.roomId}/equipmentLines/${line.equipmentLineId}/categoryId`, "rooms", "Equipment category is not part of this questionnaire"));
      }
      if (final) requireText(errors, line.description, `/rooms/${roomResponse.roomId}/equipmentLines/${line.equipmentLineId}/description`, "rooms", "Equipment description");
    }
    const categoryTotals = new Map(roomResponse.categoryTotals.map((entry) => [entry.categoryId, entry]));
    for (const total of roomResponse.categoryTotals) {
      if (!equipmentCategoryIds.has(total.categoryId)) {
        errors.push(issue("unknown_reference", `/rooms/${roomResponse.roomId}/categoryTotals/${total.categoryId}`, "rooms", "Equipment category is not part of this questionnaire"));
      }
      checkMoney(errors, total.amount, currency, `/rooms/${roomResponse.roomId}/categoryTotals/${total.categoryId}/amount`);
    }
    for (const line of roomResponse.laborLines) {
      laborLines.set(line.laborLineId, { roomId: roomResponse.roomId, travel: line.travel });
      if (!roleIds.has(line.roleId)) {
        errors.push(issue("unknown_reference", `/rooms/${roomResponse.roomId}/laborLines/${line.laborLineId}/roleId`, "rooms", "Labor role is not part of this questionnaire"));
      }
    }
    checkMoney(errors, roomResponse.laborSubtotal, currency, `/rooms/${roomResponse.roomId}/laborSubtotal`);
    if (final && isSectionApplicable(questionnaire, response, "rooms")) {
      for (const spec of roomDefinition.specs) {
        if (!specResponses.has(spec.specId)) {
          errors.push(issue("required", `/rooms/${roomResponse.roomId}/specResponses/${spec.specId}`, "rooms", `${spec.label} response is required`));
        }
      }
      for (const categoryId of new Set(roomResponse.equipmentLines.map((entry) => entry.categoryId))) {
        if (!categoryTotals.has(categoryId)) {
          errors.push(issue("required", `/rooms/${roomResponse.roomId}/categoryTotals/${categoryId}`, "rooms", "A category total is required for used equipment"));
        }
      }
      if (roomDefinition.streamingApplicable) {
        if (!roomResponse.hybrid) {
          errors.push(issue("required", `/rooms/${roomResponse.roomId}/hybrid`, "rooms", "Hybrid delivery details are required for this room"));
        } else {
          requireText(errors, roomResponse.hybrid.feedHandoff, `/rooms/${roomResponse.roomId}/hybrid/feedHandoff`, "rooms", "Feed handoff plan");
          requireText(errors, roomResponse.hybrid.redundancy, `/rooms/${roomResponse.roomId}/hybrid/redundancy`, "rooms", "Redundancy plan");
          requireText(errors, roomResponse.hybrid.virtualAudienceExperience, `/rooms/${roomResponse.roomId}/hybrid/virtualAudienceExperience`, "rooms", "Virtual audience experience");
        }
      }
    }
    if (!roomDefinition.streamingApplicable && roomResponse.hybrid) {
      errors.push(issue("not_applicable", `/rooms/${roomResponse.roomId}/hybrid`, "rooms", "Hybrid delivery details are not applicable to this room"));
    }
    if (roomResponse.hybrid) {
      enforceWordLimit(errors, roomResponse.hybrid.feedHandoff, questionnaire.hybrid.roomPlanMaxWords, `/rooms/${roomResponse.roomId}/hybrid/feedHandoff`, "rooms", "Feed handoff plan");
      enforceWordLimit(errors, roomResponse.hybrid.redundancy, questionnaire.hybrid.roomPlanMaxWords, `/rooms/${roomResponse.roomId}/hybrid/redundancy`, "rooms", "Redundancy plan");
      enforceWordLimit(errors, roomResponse.hybrid.virtualAudienceExperience, questionnaire.hybrid.roomPlanMaxWords, `/rooms/${roomResponse.roomId}/hybrid/virtualAudienceExperience`, "rooms", "Virtual audience experience");
    }
  }
  if (final && isSectionApplicable(questionnaire, response, "rooms")) {
    for (const room of questionnaire.rooms) {
      if (!roomResponses.has(room.roomId)) {
        errors.push(issue("required", `/rooms/${room.roomId}`, "rooms", `${room.name} response is required`));
      }
    }
  }

  for (const member of response.crew) {
    if (!roleIds.has(member.roleId)) {
      errors.push(issue("unknown_reference", `/crew/${member.crewMemberId}/roleId`, "crew", "Crew role is not part of this questionnaire"));
    }
    enforceWordLimit(errors, member.bio, questionnaire.crew.bioMaxWords, `/crew/${member.crewMemberId}/bio`, "crew", "Crew bio");
    if (!questionnaire.crew.headshotAllowed && member.headshotDocumentId) {
      errors.push(issue("not_applicable", `/crew/${member.crewMemberId}/headshotDocumentId`, "crew", "Headshots are not enabled"));
    }
    if (final && questionnaire.crew.headshotRequired && !member.headshotDocumentId) {
      errors.push(issue("required", `/crew/${member.crewMemberId}/headshotDocumentId`, "crew", "Crew headshot is required"));
    }
    if (final) {
      requireText(errors, member.name, `/crew/${member.crewMemberId}/name`, "crew", "Crew member name");
      requireText(errors, member.bio, `/crew/${member.crewMemberId}/bio`, "crew", "Crew bio");
    }
  }
  if (final && isSectionApplicable(questionnaire, response, "crew")) {
    for (const roleId of questionnaire.crew.requiredRoleIds) {
      if (!response.crew.some((member) => member.roleId === roleId)) {
        errors.push(issue("required_role", `/crew/roles/${roleId}`, "crew", "At least one crew member is required for this role"));
      }
    }
  }

  const lodgingByLaborLine = new Map(response.travel.lodgingRequests.map((entry) => [entry.laborLineId, entry]));
  for (const lodging of response.travel.lodgingRequests) {
    const labor = laborLines.get(lodging.laborLineId);
    if (!labor || labor.roomId !== lodging.roomId) {
      errors.push(issue("unknown_reference", `/travel/lodgingRequests/${lodging.laborLineId}`, "travel", "Lodging request must reference a labor line in the same room"));
    } else if (!labor.travel) {
      errors.push(issue("not_applicable", `/travel/lodgingRequests/${lodging.laborLineId}`, "travel", "Lodging is only applicable to travel labor"));
    }
    if (lodging.clientProvidedRoom) {
      if (final) {
        requireText(errors, lodging.checkIn, `/travel/lodgingRequests/${lodging.laborLineId}/checkIn`, "travel", "Check-in date");
        requireText(errors, lodging.checkOut, `/travel/lodgingRequests/${lodging.laborLineId}/checkOut`, "travel", "Check-out date");
      }
      if (lodging.checkIn && lodging.checkOut && roomNightsBetween(lodging.checkIn, lodging.checkOut) === 0) {
        errors.push(issue("invalid_date_range", `/travel/lodgingRequests/${lodging.laborLineId}`, "travel", "Check-out must be after check-in"));
      }
    } else if (lodging.checkIn || lodging.checkOut) {
      errors.push(issue("not_applicable", `/travel/lodgingRequests/${lodging.laborLineId}`, "travel", "Dates are only allowed for client-provided rooms"));
    }
  }
  if (final && isSectionApplicable(questionnaire, response, "travel")) {
    for (const [laborLineId, labor] of laborLines) {
      if (labor.travel && !lodgingByLaborLine.has(laborLineId)) {
        errors.push(issue("required", `/travel/lodgingRequests/${laborLineId}`, "travel", "Travel labor requires a lodging response"));
      }
    }
  } else if (!isSectionApplicable(questionnaire, response, "travel") && response.travel.lodgingRequests.length > 0) {
    errors.push(issue("not_applicable", "/travel/lodgingRequests", "travel", "Travel details are hidden when no labor line requires travel"));
  }

  checkMoney(errors, response.pricing.travelSubtotal, currency, "/pricing/travelSubtotal");
  checkMoney(errors, response.pricing.discount, currency, "/pricing/discount");
  const feeDefinitions = new Map(questionnaire.pricing.feeLines.map((entry) => [entry.feeId, entry]));
  const responseFeeIds = new Set(response.pricing.fees.map((entry) => entry.feeId));
  for (const fee of response.pricing.fees) {
    if (!feeDefinitions.has(fee.feeId)) {
      errors.push(issue("unknown_reference", `/pricing/fees/${fee.feeId}`, "pricing", "Fee is not part of this questionnaire"));
    }
    checkMoney(errors, fee.amount, currency, `/pricing/fees/${fee.feeId}/amount`);
  }
  if (!questionnaire.pricing.assumptionsAllowed && response.pricing.assumptionsExclusions.length > 0) {
    errors.push(issue("not_applicable", "/pricing/assumptionsExclusions", "pricing", "Assumptions and exclusions are not enabled"));
  }
  if (final && isSectionApplicable(questionnaire, response, "pricing")) {
    for (const fee of questionnaire.pricing.feeLines.filter((entry) => entry.required)) {
      if (!responseFeeIds.has(fee.feeId)) {
        errors.push(issue("required", `/pricing/fees/${fee.feeId}`, "pricing", `${fee.label} is required`));
      }
    }
  }

  if (!questionnaire.alternates.enabled && response.alternates.length > 0) {
    errors.push(issue("not_applicable", "/alternates", "alternates", "Alternates are not enabled"));
  }
  for (const alternate of response.alternates) {
    if (alternate.scope.type === "room" && (!alternate.scope.roomId || !roomDefinitions.has(alternate.scope.roomId))) {
      errors.push(issue("unknown_reference", `/alternates/${alternate.alternateId}/scope/roomId`, "alternates", "Alternate room is not part of this questionnaire"));
    }
    if (alternate.costDelta.currency !== currency || !Number.isSafeInteger(alternate.costDelta.amountMinor)) {
      errors.push(issue("invalid_money", `/alternates/${alternate.alternateId}/costDelta`, "alternates", `Alternate cost must use safe integer ${currency} minor units`));
    }
    if (final) {
      requireText(errors, alternate.title, `/alternates/${alternate.alternateId}/title`, "alternates", "Alternate title");
      requireText(errors, alternate.tradeoff, `/alternates/${alternate.alternateId}/tradeoff`, "alternates", "Alternate tradeoff");
    }
  }
  if (final && questionnaire.alternates.enabled && isSectionApplicable(questionnaire, response, "alternates") &&
    (response.alternates.length < questionnaire.alternates.minimumCount || response.alternates.length > questionnaire.alternates.maximumCount)) {
    errors.push(issue("invalid_count", "/alternates", "alternates", `Provide between ${questionnaire.alternates.minimumCount} and ${questionnaire.alternates.maximumCount} alternates`));
  }

  if (!questionnaire.references.enabled && response.references.length > 0) {
    errors.push(issue("not_applicable", "/references", "references", "References are not enabled"));
  }
  for (const reference of response.references) {
    if (reference.visualDocumentIds.length > questionnaire.references.maxVisualsPerReference) {
      errors.push(issue("invalid_count", `/references/${reference.referenceId}/visualDocumentIds`, "references", `Reference allows at most ${questionnaire.references.maxVisualsPerReference} visuals`));
    }
    if (reference.startDate && reference.endDate && endsBeforeStart(reference.startDate, reference.endDate)) {
      errors.push(issue("invalid_date_range", `/references/${reference.referenceId}`, "references", "Reference end date cannot be before its start date"));
    }
    if (final) {
      requireText(errors, reference.clientName, `/references/${reference.referenceId}/clientName`, "references", "Client name");
      requireText(errors, reference.eventName, `/references/${reference.referenceId}/eventName`, "references", "Event name");
      requireText(errors, reference.servicesProvided, `/references/${reference.referenceId}/servicesProvided`, "references", "Services provided");
    }
  }
  if (final && questionnaire.references.enabled && isSectionApplicable(questionnaire, response, "references") &&
    (response.references.length < questionnaire.references.minimumCount || response.references.length > questionnaire.references.maximumCount)) {
    errors.push(issue("invalid_count", "/references", "references", countRequirement("Provide", questionnaire.references.minimumCount, questionnaire.references.maximumCount, "reference")));
  }

  const documentCategories = new Map(questionnaire.documents.categories.map((entry) => [entry.purposeId, entry]));
  const crewMemberIds = new Set(response.crew.map((entry) => entry.crewMemberId));
  const referenceIds = new Set(response.references.map((entry) => entry.referenceId));
  for (const document of response.documents) {
    if (!documentCategories.has(document.purposeId)) {
      errors.push(issue("unknown_reference", `/documents/${document.documentId}/purposeId`, "documents", "Document purpose is not part of this questionnaire"));
    }
    const validScope = document.scopeType === "proposal" ||
      (document.scopeType === "room" && !!document.scopeId && roomDefinitions.has(document.scopeId)) ||
      (document.scopeType === "crew_member" && !!document.scopeId && crewMemberIds.has(document.scopeId)) ||
      (document.scopeType === "reference" && !!document.scopeId && referenceIds.has(document.scopeId));
    if (!validScope) {
      errors.push(issue("unknown_reference", `/documents/${document.documentId}/scopeId`, "documents", "Document scope does not exist in this response"));
    }
  }
  if (response.documents.length > questionnaire.documents.globalMaximumFiles) {
    errors.push(issue("invalid_count", "/documents", "documents", `At most ${questionnaire.documents.globalMaximumFiles} documents are allowed`));
  }
  if (final && isSectionApplicable(questionnaire, response, "documents")) {
    for (const category of questionnaire.documents.categories) {
      const count = response.documents.filter((document) => document.purposeId === category.purposeId).length;
      if (count < category.minimumFiles || count > category.maximumFiles) {
        errors.push(issue("invalid_count", `/documents/purpose/${category.purposeId}`, "documents", `${category.label} requires between ${category.minimumFiles} and ${category.maximumFiles} files`));
      }
    }
  }

  if (!questionnaire.valueAdds.enabled && !isBlank(response.valueAdds)) {
    errors.push(issue("not_applicable", "/valueAdds", "value_adds", "Value adds are not enabled"));
  }
  enforceWordLimit(errors, response.valueAdds, questionnaire.valueAdds.maxWords, "/valueAdds", "value_adds", "Value adds");
  if (final && questionnaire.valueAdds.enabled && questionnaire.valueAdds.required && isSectionApplicable(questionnaire, response, "value_adds")) {
    requireText(errors, response.valueAdds, "/valueAdds", "value_adds", "Value adds");
  }

  const equipmentSubtotal = response.rooms.flatMap((room) => room.categoryTotals).reduce((sum, total) => sum + total.amount.amountMinor, 0);
  const laborSubtotal = response.rooms.reduce((sum, room) => sum + room.laborSubtotal.amountMinor, 0);
  const feesSubtotal = response.pricing.fees.reduce((sum, fee) => sum + fee.amount.amountMinor, 0);
  if (response.pricing.discount.amountMinor > equipmentSubtotal + laborSubtotal + response.pricing.travelSubtotal.amountMinor + feesSubtotal) {
    errors.push(issue("invalid_discount", "/pricing/discount/amountMinor", "pricing", "Discount cannot exceed the pre-discount total"));
  }

  return errors;
};

const safeSum = (values: readonly number[], label: string): number => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError(`${label} exceeds safe integer precision`);
  return total;
};

export const calculateStructuredVendorResponse = (
  questionnaire: VendorResponseQuestionnaireV1,
  response: VendorResponseV1,
  calculatedAt = new Date().toISOString(),
): VendorResponseCalculationV1 => {
  const roomTotals = response.rooms.map((room) => {
    const equipmentSubtotalMinor = safeSum(room.categoryTotals.map((entry) => entry.amount.amountMinor), `Equipment total for ${room.roomId}`);
    const laborSubtotalMinor = room.laborSubtotal.amountMinor;
    return {
      roomId: room.roomId,
      equipmentSubtotalMinor,
      laborSubtotalMinor,
      roomTotalMinor: safeSum([equipmentSubtotalMinor, laborSubtotalMinor], `Room total for ${room.roomId}`),
    };
  });
  const equipmentSubtotalMinor = safeSum(roomTotals.map((entry) => entry.equipmentSubtotalMinor), "Equipment subtotal");
  const laborSubtotalMinor = safeSum(roomTotals.map((entry) => entry.laborSubtotalMinor), "Labor subtotal");
  const feeKindById = new Map(questionnaire.pricing.feeLines.map((entry) => [entry.feeId, entry.kind]));
  const feeSubtotalMinor = safeSum(response.pricing.fees.filter((entry) => feeKindById.get(entry.feeId) === "fee").map((entry) => entry.amount.amountMinor), "Fee subtotal");
  const taxSubtotalMinor = safeSum(response.pricing.fees.filter((entry) => feeKindById.get(entry.feeId) === "tax").map((entry) => entry.amount.amountMinor), "Tax subtotal");
  const travelSubtotalMinor = response.pricing.travelSubtotal.amountMinor;
  const discountMinor = response.pricing.discount.amountMinor;
  const grandTotalMinor = safeSum([equipmentSubtotalMinor, laborSubtotalMinor, travelSubtotalMinor, feeSubtotalMinor, taxSubtotalMinor, -discountMinor], "Grand total");
  if (grandTotalMinor < 0) throw new RangeError("Discount cannot make the grand total negative");

  const applicableSpecIds = new Set(questionnaire.rooms.flatMap((room) => room.specs.map((spec) => spec.specId)));
  const specResponses = response.rooms.flatMap((room) => room.specResponses).filter((entry) => applicableSpecIds.has(entry.specId));
  const finalErrors = validateStructuredVendorResponse(questionnaire, response, "final");
  const applicableRequiredSections = questionnaire.sections.filter((section) =>
    section.required && section.sectionId !== "review" && isSectionApplicable(questionnaire, response, section.sectionId));
  const incompleteSections = new Set(finalErrors.map((entry) => entry.sectionId));
  const completedSections = applicableRequiredSections.filter((section) => !incompleteSections.has(section.sectionId)).length;
  const requiredSections = applicableRequiredSections.length;

  return {
    schemaVersion: "vendor-response-calculation.v1",
    currency: questionnaire.pricing.currency,
    roomTotals,
    equipmentSubtotalMinor,
    laborSubtotalMinor,
    travelSubtotalMinor,
    feeSubtotalMinor,
    taxSubtotalMinor,
    discountMinor,
    grandTotalMinor,
    requestedRoomNights: response.travel.lodgingRequests.reduce((sum, request) =>
      sum + (request.clientProvidedRoom && request.checkIn && request.checkOut ? roomNightsBetween(request.checkIn, request.checkOut) : 0), 0),
    specCounts: {
      total: applicableSpecIds.size,
      answered: specResponses.length,
      comply: specResponses.filter((entry) => entry.status === "comply").length,
      substitute: specResponses.filter((entry) => entry.status === "substitute").length,
      exception: specResponses.filter((entry) => entry.status === "exception").length,
    },
    completion: {
      requiredSections,
      completedSections,
      percent: requiredSections === 0 ? 100 : Math.round((completedSections / requiredSections) * 100),
    },
    calculatedAt,
  };
};
