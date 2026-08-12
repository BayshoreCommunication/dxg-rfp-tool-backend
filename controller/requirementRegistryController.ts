import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  parseExpectedVersion,
  parseRequirementUpdate,
  RequirementRegistryError,
} from "../src/modules/requirementRegistry/domain";
import { requirementRegistryRepository } from "../src/modules/requirementRegistry/postgresRequirementRegistryRepository";

const context = (req: AuthRequest) => {
  if (!req.user?.organizationId || !req.user.userId)
    throw new RequirementRegistryError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    proposalMongoId: mongoId(req.params.proposalId),
    correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};
const mongoId = (value: unknown) => {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{24}$/i.test(normalized))
    throw new RequirementRegistryError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return normalized;
};
const uuid = (value: unknown, code = "REQUIREMENT_SET_NOT_FOUND") => {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized))
    throw new RequirementRegistryError(code, code === "REQUIREMENT_NOT_FOUND" ? "Requirement was not found." : "Requirement set was not found.", 404);
  return normalized;
};
const idempotencyKey = (req: AuthRequest) => {
  const value = String(req.headers["idempotency-key"] ?? "").trim();
  if (!value || value.length > 200)
    throw new RequirementRegistryError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 400);
  return value;
};
const expectedVersion = (req: AuthRequest) => {
  const header = String(req.headers["if-match"] ?? "").replace(/^W\//, "").replace(/"/g, "");
  return parseExpectedVersion(header || (req.body as Record<string, unknown> | undefined)?.expectedVersion);
};
const handle = (res: Response, error: unknown) => {
  const known = error instanceof RequirementRegistryError;
  const status = known ? error.status : 500;
  res.status(status).json({
    title: known ? error.message : "Requirement registry operation failed.",
    status,
    code: known ? error.code : "INTERNAL_ERROR",
  });
};

export const createRequirementSet = async (req: AuthRequest, res: Response) => {
  try {
    const result = await requirementRegistryRepository.create({
      ...context(req),
      idempotencyKey: idempotencyKey(req),
    });
    res.status(result.created ? 201 : 200).json({ data: result.data });
  } catch (error) { handle(res, error); }
};
export const listRequirementSets = async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await requirementRegistryRepository.list(context(req)) }); }
  catch (error) { handle(res, error); }
};
export const readRequirementSet = async (req: AuthRequest, res: Response) => {
  try { res.json({ data: await requirementRegistryRepository.read({ ...context(req), setId: uuid(req.params.setId) }) }); }
  catch (error) { handle(res, error); }
};
export const updateRequirement = async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await requirementRegistryRepository.updateRequirement({
      ...context(req),
      setId: uuid(req.params.setId),
      requirementId: uuid(req.params.requirementId, "REQUIREMENT_NOT_FOUND"),
      idempotencyKey: idempotencyKey(req),
      expectedVersion: expectedVersion(req),
      update: parseRequirementUpdate(req.body),
    }) });
  } catch (error) { handle(res, error); }
};
export const approveRequirementSet = async (req: AuthRequest, res: Response) => {
  try {
    res.json({ data: await requirementRegistryRepository.approve({
      ...context(req), setId: uuid(req.params.setId),
      idempotencyKey: idempotencyKey(req), expectedVersion: expectedVersion(req),
    }) });
  } catch (error) { handle(res, error); }
};
export const supersedeRequirementSet = async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json({ data: await requirementRegistryRepository.supersede({
      ...context(req), setId: uuid(req.params.setId), idempotencyKey: idempotencyKey(req),
    }) });
  } catch (error) { handle(res, error); }
};
