import crypto from "node:crypto";

export const COMPARISON_SCHEMA_VERSION = "proposal-intelligence-comparison.v1";
export const PARTICIPANT_SCHEMA_VERSION = "comparison-participant.v1";

export class ComparisonOrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422, public readonly retryable = false) { super(message); }
}

export const comparisonChecksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const uniqueReasons = (values: string[]) => [...new Set(values)].sort();

export const weightedProgress = (nodes: Array<{ status: string; weight: unknown }>) => {
  const value = nodes.reduce((total, node) => {
    const weight = Number(node.weight);
    if (node.status === "succeeded") return total + weight;
    if (node.status === "running") return total + (weight * 0.25);
    return total;
  }, 0);
  return Math.round(Math.min(100, Math.max(0, value)) * 1000) / 1000;
};
