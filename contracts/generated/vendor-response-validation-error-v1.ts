/* AUTO-GENERATED from contracts/vendor-response/v1. Do not edit directly. */

export interface VendorResponseValidationEnvelopeV1 {
  schemaVersion: "vendor-response-validation-error.v1";
  valid: false;
  /**
   * @minItems 1
   * @maxItems 1000
   */
  errors: {
    code: string;
    path: string;
    sectionId: string;
    message: string;
  }[];
}
