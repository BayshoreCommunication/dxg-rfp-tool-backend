export type VendorResponseFormat = "structured_v1" | "legacy_unstructured";

export type VendorStructuredResponseRollout = {
  structuredResponse: boolean;
  responseFormat: VendorResponseFormat;
  reason: "enabled" | "global_flag_disabled" | "proposal_not_enabled";
};

export const vendorStructuredResponsesEnabled = (): boolean =>
  process.env.VENDOR_STRUCTURED_RESPONSES_ENABLED === "true";

export const configuredVendorResponseFormat = (
  proposalSettings: unknown,
): VendorResponseFormat => {
  if (
    proposalSettings
    && typeof proposalSettings === "object"
    && (proposalSettings as Record<string, unknown>).vendorResponseFormat
      === "structured_v1"
  ) return "structured_v1";
  return "legacy_unstructured";
};

export const resolveVendorStructuredResponseRollout = (
  proposalFormat: VendorResponseFormat,
  globalEnabled = vendorStructuredResponsesEnabled(),
): VendorStructuredResponseRollout => {
  if (!globalEnabled) {
    return {
      structuredResponse: false,
      responseFormat: "legacy_unstructured",
      reason: "global_flag_disabled",
    };
  }
  if (proposalFormat !== "structured_v1") {
    return {
      structuredResponse: false,
      responseFormat: "legacy_unstructured",
      reason: "proposal_not_enabled",
    };
  }
  return {
    structuredResponse: true,
    responseFormat: "structured_v1",
    reason: "enabled",
  };
};
