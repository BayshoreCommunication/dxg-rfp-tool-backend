/* AUTO-GENERATED from contracts/vendor-response/v1. Do not edit directly. */

export type Identifier = string;
export type NonNegativeMoney = number;

export interface VendorResponseCalculationV1 {
  schemaVersion: "vendor-response-calculation.v1";
  currency: string;
  /**
   * @maxItems 200
   */
  roomTotals: RoomTotal[];
  equipmentSubtotalMinor: NonNegativeMoney;
  laborSubtotalMinor: NonNegativeMoney;
  travelSubtotalMinor: NonNegativeMoney;
  feeSubtotalMinor: NonNegativeMoney;
  taxSubtotalMinor: NonNegativeMoney;
  discountMinor: NonNegativeMoney;
  grandTotalMinor: NonNegativeMoney;
  requestedRoomNights: number;
  specCounts: SpecCounts;
  completion: Completion;
  calculatedAt: string;
}
export interface RoomTotal {
  roomId: Identifier;
  equipmentSubtotalMinor: NonNegativeMoney;
  laborSubtotalMinor: NonNegativeMoney;
  roomTotalMinor: NonNegativeMoney;
}
export interface SpecCounts {
  total: number;
  answered: number;
  comply: number;
  substitute: number;
  exception: number;
}
export interface Completion {
  requiredSections: number;
  completedSections: number;
  percent: number;
}
