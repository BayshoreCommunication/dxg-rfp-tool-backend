const ALLOWED_AI_ENVIRONMENTS = new Set(["test", "staging", "production"]);

// AI_ENVIRONMENT declares which runtime the governed AI surface is authorized
// for ("test" | "staging" | "production"). Deny by default: when unset, the
// surface stays disabled unless NODE_ENV is "test", preserving the isolated
// test behaviour the accepted slices were signed off under. Individual
// feature flags and kill switches still apply on top of this authorization.
export const aiEnvironment = (): string => {
  const configured = (process.env.AI_ENVIRONMENT || "").trim().toLowerCase();
  if (ALLOWED_AI_ENVIRONMENTS.has(configured)) return configured;
  return process.env.NODE_ENV === "test" ? "test" : "";
};

export const aiRuntimeAuthorized = (): boolean => aiEnvironment() !== "";
