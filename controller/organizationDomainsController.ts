import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { correlationId } from "./authController";
import { domainVerification } from "../src/modules/domainVerification/composition";
import { verificationInstructions, type DomainRecord } from "../src/modules/domainVerification/application/manageDomains";

/* ORG-305. Mounted under /api/organization/domains behind organization:manage.
   Always the caller's session organization. */

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

const handleError = (res: Response, error: unknown, context: string) => {
  console.error(`Organization domain ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "ORGANIZATION_DOMAIN_ERROR", "Request failed");
};

const present = (record: DomainRecord) => ({
  id: record.id,
  domain: record.domain,
  status: record.status,
  method: record.method,
  verification: verificationInstructions(record),
  verifiedAt: record.verifiedAt,
  lastCheckedAt: record.lastCheckedAt,
  lastCheckOutcome: record.lastCheckOutcome,
  nextCheckAt: record.nextCheckAt,
  createdAt: record.createdAt,
});

/* GET /api/organization/domains */
export const listDomains = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const records = await domainVerification.list(req.user!.organizationId!);
    res.status(200).json({ success: true, domains: records.map(present) });
  } catch (error) {
    handleError(res, error, "list");
  }
};

/* POST /api/organization/domains { domain } → the TXT record to publish */
export const addDomain = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await domainVerification.add({
      organizationId: req.user!.organizationId!,
      actorUserId: req.user!.userId,
      actorEmail: req.user!.email ?? "",
      domain: req.body?.domain,
      correlationId: correlationId(req),
    });
    switch (result.kind) {
      case "invalid": fail(res, 400, "DOMAIN_INVALID", "Enter a domain like example.com"); return;
      case "not_verifiable": fail(res, 422, "DOMAIN_NOT_VERIFIABLE", "Public email domains can't be verified"); return;
      case "limit": fail(res, 409, "DOMAIN_LIMIT_REACHED", "This organization has the maximum number of domains"); return;
      case "unavailable": fail(res, 409, "DOMAIN_UNAVAILABLE", "This domain can't be added"); return;
      case "already_added": fail(res, 409, "DOMAIN_ALREADY_ADDED", "This domain is already on your organization"); return;
      default: res.status(201).json({ success: true, domain: present(result.record) });
    }
  } catch (error) {
    handleError(res, error, "add");
  }
};

/* POST /api/organization/domains/:id/check: check now instead of waiting for the job */
export const checkDomain = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await domainVerification.checkNow({
      organizationId: req.user!.organizationId!,
      id: String(req.params.id ?? ""),
      actorUserId: req.user!.userId,
      correlationId: correlationId(req),
    });
    if (result.kind === "not_found") {
      fail(res, 404, "DOMAIN_NOT_FOUND", "Domain not found");
      return;
    }
    res.status(200).json({ success: true, domain: present(result.record) });
  } catch (error) {
    handleError(res, error, "check");
  }
};

/* DELETE /api/organization/domains/:id */
export const removeDomain = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await domainVerification.remove({
      organizationId: req.user!.organizationId!,
      id: String(req.params.id ?? ""),
      actorUserId: req.user!.userId,
      correlationId: correlationId(req),
    });
    if (result.kind === "not_found") {
      fail(res, 404, "DOMAIN_NOT_FOUND", "Domain not found");
      return;
    }
    res.status(200).json({ success: true });
  } catch (error) {
    handleError(res, error, "remove");
  }
};
