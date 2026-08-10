import type {
  IdentityProjectionInput,
  IdentityProjectionRepository,
  IdentityProjectionResult,
} from "../domain/ports/identityProjectionRepository";

const mongoId = /^[0-9a-f]{24}$/;
const code = /^[A-Z][A-Z0-9_]{1,79}$/;

const failureCode = (error: unknown) => {
  const candidate = String((error as { code?: unknown })?.code ?? "");
  return code.test(candidate) ? candidate : "IDENTITY_PROJECTION_FAILED";
};

export type EnsureIdentityProjectionOutcome =
  | { kind: "skipped" }
  | { kind: "invalid_external_id" }
  | { kind: "failed"; code: string }
  | ({ kind: "ensured" } & IdentityProjectionResult);

/* Total by construction: callers run on the authentication path, where an
   unavailable data foundation must degrade to "AI features are off for now"
   rather than "you cannot sign in". Every failure is returned as an outcome so
   no caller has to remember a try/catch. */
export const createEnsureIdentityProjection = (
  repository: IdentityProjectionRepository,
  dependencies: { enabled: () => boolean },
) => async (input: IdentityProjectionInput): Promise<EnsureIdentityProjectionOutcome> => {
  if (!dependencies.enabled()) return { kind: "skipped" };
  if (!mongoId.test(input.organizationMongoId) || !mongoId.test(input.userMongoId)) {
    return { kind: "invalid_external_id" };
  }
  try {
    return { kind: "ensured", ...await repository.ensure(input) };
  } catch (error) {
    return { kind: "failed", code: failureCode(error) };
  }
};
