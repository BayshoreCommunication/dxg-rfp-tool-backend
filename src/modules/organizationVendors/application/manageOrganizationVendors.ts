import { hasOrganizationAction } from "../../identity/domain/authorizationPolicy";
import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  OrganizationVendorError,
  type OrganizationVendorRecord,
  type OrganizationVendorRepository,
  type VendorChanges,
  type VendorContact,
  type VendorListActor,
  type VendorListPage,
  type VendorListQuery,
  type VendorListStatus,
} from "../domain";

type Dependencies = {
  vendors: OrganizationVendorRepository;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
  now?: () => Date;
};

export const MAX_COMPANY_LENGTH = 200;
export const MAX_CATEGORY_LENGTH = 80;
export const MAX_CONTACT_NAME_LENGTH = 120;
export const MAX_CONTACTS = 50;
const MAX_EMAIL_LENGTH = 254;
const MAX_SEARCH_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES: readonly VendorListStatus[] = ["active", "archived", "all"];

const invalid = (code: string, message: string) => new OrganizationVendorError(code, message, 400);
const notFound = () => new OrganizationVendorError("VENDOR_NOT_FOUND", "Vendor not found.", 404);
const vendorArchived = () => new OrganizationVendorError("VENDOR_ARCHIVED", "Restore this vendor before editing it.", 409);
const companyTaken = () => new OrganizationVendorError("VENDOR_COMPANY_TAKEN", "A vendor with this company name is already on the list.", 409);

const text = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

const companyOf = (value: unknown): string => {
  const company = text(value);
  if (!company || company.length > MAX_COMPANY_LENGTH) {
    throw invalid("INVALID_VENDOR_COMPANY", `Company name must be 1 to ${MAX_COMPANY_LENGTH} characters.`);
  }
  return company;
};

const categoryOf = (value: unknown): string => {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw invalid("INVALID_VENDOR_CATEGORY", "Category must be text.");
  }
  const category = text(value);
  if (category.length > MAX_CATEGORY_LENGTH) {
    throw invalid("INVALID_VENDOR_CATEGORY", `Category must be at most ${MAX_CATEGORY_LENGTH} characters.`);
  }
  return category;
};

const contactsOf = (value: unknown): VendorContact[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTACTS) {
    throw invalid("INVALID_VENDOR_CONTACTS", `Contacts must be a list of at most ${MAX_CONTACTS} people.`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") {
      throw invalid("INVALID_VENDOR_CONTACTS", "A contact name must be text.");
    }
    const name = text(raw.name);
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    if (name.length > MAX_CONTACT_NAME_LENGTH) {
      throw invalid("INVALID_VENDOR_CONTACTS", `A contact name must be at most ${MAX_CONTACT_NAME_LENGTH} characters.`);
    }
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
      throw invalid("INVALID_VENDOR_CONTACT_EMAIL", "Every contact needs a valid email address.");
    }
    if (seen.has(email)) {
      throw invalid("DUPLICATE_VENDOR_CONTACT_EMAIL", "Each contact email can appear only once for a vendor.");
    }
    seen.add(email);
    return { name, email };
  });
};

const wholeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

const queryOf = (input: Record<string, unknown>): VendorListQuery => {
  // A repeated or nested `status` parameter is refused, not read as the default.
  const status = input.status === undefined ? "active" : input.status;
  if (typeof status !== "string" || !STATUSES.includes(status as VendorListStatus)) {
    throw invalid("INVALID_VENDOR_STATUS", "Status must be active, archived or all.");
  }
  return {
    search: text(input.search).slice(0, MAX_SEARCH_LENGTH),
    category: text(input.category).slice(0, MAX_CATEGORY_LENGTH),
    status: status as VendorListStatus,
    limit: wholeNumber(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: wholeNumber(input.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
};

const sameContacts = (a: readonly VendorContact[], b: readonly VendorContact[]) =>
  a.length === b.length && a.every((contact, index) => contact.name === b[index].name && contact.email === b[index].email);

export const createOrganizationVendorList = (dependencies: Dependencies) => {
  const { vendors, audit } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  // Role rules live in authorizationPolicy: Owner, Admin and Team Manager edit; every member
  // who can create RFPs reads; Viewers get neither (DXG decision Q4, follow-up F6).
  const requireReader = (actor: VendorListActor) => {
    if (!hasOrganizationAction(actor.roles, "vendor-list:read")) {
      throw new OrganizationVendorError("VENDOR_LIST_ACCESS_DENIED", "Your role can't see the organization's vendor list.", 403);
    }
  };
  const requireEditor = (actor: VendorListActor) => {
    if (!hasOrganizationAction(actor.roles, "vendor-list:write")) {
      throw new OrganizationVendorError("VENDOR_LIST_EDIT_DENIED", "Only Owners, Admins and Team Managers can edit the vendor list.", 403);
    }
  };

  // Contact names and emails stay out of the audit trail; it records what changed, not the people.
  const record = (actor: VendorListActor, action: string, vendorId: string, decision: "created" | "revoked" | "allowed", metadata: Record<string, unknown>) =>
    audit.append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      targetType: "organization_vendor",
      targetId: vendorId,
      decision,
      reason: action,
      correlationId: actor.correlationId,
      metadata,
    });

  const load = async (actor: VendorListActor, vendorId: string): Promise<OrganizationVendorRecord> => {
    const vendor = dependencies.isValidId(vendorId) ? await vendors.findById(actor.organizationId, vendorId) : null;
    if (!vendor) throw notFound();
    return vendor;
  };

  return {
    async list(actor: VendorListActor, input: Record<string, unknown> = {}): Promise<VendorListPage> {
      requireReader(actor);
      const query = queryOf(input);
      const { items, total } = await vendors.list(actor.organizationId, query);
      return { items, total, limit: query.limit, offset: query.offset };
    },

    async categories(actor: VendorListActor): Promise<string[]> {
      requireReader(actor);
      return vendors.categories(actor.organizationId);
    },

    async get(actor: VendorListActor, vendorId: string): Promise<OrganizationVendorRecord> {
      requireReader(actor);
      return load(actor, vendorId);
    },

    async create(actor: VendorListActor, input: Record<string, unknown>): Promise<OrganizationVendorRecord> {
      requireEditor(actor);
      const created = await vendors.create({
        organizationId: actor.organizationId,
        company: companyOf(input.company),
        category: categoryOf(input.category),
        contacts: contactsOf(input.contacts),
        addedBy: actor.userId,
      });
      if (created === "duplicate") throw companyTaken();
      await record(actor, "organization_vendor.created", created.id, "created", {
        company: created.company, category: created.category, contactCount: created.contacts.length,
      });
      return created;
    },

    // Only the fields present in the body change. `contacts` replaces the whole list.
    async update(actor: VendorListActor, vendorId: string, input: Record<string, unknown>): Promise<OrganizationVendorRecord> {
      requireEditor(actor);
      const previous = await load(actor, vendorId);
      if (previous.archived) throw vendorArchived();
      const changes: VendorChanges = {};
      if (input.company !== undefined) {
        const company = companyOf(input.company);
        if (company !== previous.company) changes.company = company;
      }
      if (input.category !== undefined) {
        const category = categoryOf(input.category);
        if (category !== previous.category) changes.category = category;
      }
      if (input.contacts !== undefined) {
        const contacts = contactsOf(input.contacts);
        if (!sameContacts(contacts, previous.contacts)) changes.contacts = contacts;
      }
      const changed = Object.keys(changes);
      if (changed.length === 0) return previous;
      const updated = await vendors.update({ organizationId: actor.organizationId, vendorId, changes });
      if (updated === "duplicate") throw companyTaken();
      if (!updated) {
        // Archived by someone else since it was loaded (the write only matches active vendors).
        await load(actor, vendorId);
        throw vendorArchived();
      }
      await record(actor, "organization_vendor.updated", vendorId, "allowed", {
        changed,
        company: updated.company,
        ...(changes.company ? { previousCompany: previous.company } : {}),
        ...(changes.category !== undefined ? { category: updated.category, previousCategory: previous.category } : {}),
        ...(changes.contacts ? { contactCount: updated.contacts.length, previousContactCount: previous.contacts.length } : {}),
      });
      return updated;
    },

    async archive(actor: VendorListActor, vendorId: string): Promise<OrganizationVendorRecord> {
      requireEditor(actor);
      const previous = await load(actor, vendorId);
      const archived = await vendors.setArchived({ organizationId: actor.organizationId, vendorId, archived: true, at: now() });
      // Already archived, possibly by a concurrent request: nothing changed, so nothing is
      // recorded, and the answer is the stored state.
      if (!archived || archived === "duplicate") return previous.archived ? previous : load(actor, vendorId);
      await record(actor, "organization_vendor.archived", vendorId, "revoked", { company: archived.company });
      return archived;
    },

    async restore(actor: VendorListActor, vendorId: string): Promise<OrganizationVendorRecord> {
      requireEditor(actor);
      await load(actor, vendorId);
      const restored = await vendors.setArchived({ organizationId: actor.organizationId, vendorId, archived: false, at: now() });
      if (restored === "duplicate") throw companyTaken();
      if (!restored) return load(actor, vendorId);
      await record(actor, "organization_vendor.restored", vendorId, "allowed", { company: restored.company });
      return restored;
    },
  };
};

export type OrganizationVendorList = ReturnType<typeof createOrganizationVendorList>;
