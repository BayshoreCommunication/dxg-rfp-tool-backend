export class OrganizationVendorError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "OrganizationVendorError";
  }
}

export type VendorListActor = { organizationId: string; userId: string; roles: readonly string[]; correlationId: string };

export type VendorContact = { name: string; email: string };
export type OrganizationVendorRecord = {
  id: string;
  company: string;
  category: string;
  contacts: VendorContact[];
  addedBy: string | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VendorListStatus = "active" | "archived" | "all";
export type VendorListQuery = { search: string; category: string; status: VendorListStatus; limit: number; offset: number };
export type VendorListPage = { items: OrganizationVendorRecord[]; total: number; limit: number; offset: number };
export type VendorChanges = Partial<Pick<OrganizationVendorRecord, "company" | "category" | "contacts">>;

// Every method names the organization, so a foreign id is indistinguishable from a missing one.
export interface OrganizationVendorRepository {
  list(organizationId: string, query: VendorListQuery): Promise<{ items: OrganizationVendorRecord[]; total: number }>;
  // Distinct categories of active vendors, for the filter and the add form.
  categories(organizationId: string): Promise<string[]>;
  findById(organizationId: string, vendorId: string): Promise<OrganizationVendorRecord | null>;
  // "duplicate" when an active vendor in the organization already has the company name (case-insensitive).
  create(input: { organizationId: string; company: string; category: string; contacts: VendorContact[]; addedBy: string }): Promise<OrganizationVendorRecord | "duplicate">;
  // Null when the vendor is missing or archived.
  update(input: { organizationId: string; vendorId: string; changes: VendorChanges }): Promise<OrganizationVendorRecord | "duplicate" | null>;
  // Null when the vendor is missing or already in that state. Restoring can hit "duplicate".
  setArchived(input: { organizationId: string; vendorId: string; archived: boolean; at: Date }): Promise<OrganizationVendorRecord | "duplicate" | null>;
}
