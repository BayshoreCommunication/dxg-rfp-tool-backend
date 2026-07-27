import crypto from "node:crypto";
import {
  ENGINE_VERSION,
  SCHEMA_VERSION,
  validateRoomRecommendationResult,
  type RoomBlock,
  type RoomClarificationQuestion,
  type RoomRecommendation,
  type RoomRecommendationResult,
  type RoomWarning,
} from "./domain";
import { isApplyEligiblePath } from "./applyAllowlist";
import { hasCoreRoomFacts, PROPOSAL_RULES, ROOM_RULES, type RoomFacts, type RuleContext } from "./rules";
import type { RoomKnowledgeEntry } from "./knowledgeProvider";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const roomFacts = (proposal: Record<string, unknown>): RoomFacts[] => {
  const rooms = Array.isArray(proposal.roomByRoom) ? proposal.roomByRoom : [];
  return rooms.slice(0, 200).map((raw, index) => {
    const room = record(raw);
    const label = typeof room.roomFunction === "string" ? room.roomFunction.trim().slice(0, 200) : "";
    return { index, label, raw: room };
  });
};

export const roomIdentityChecksum = (roomIndex: number, roomLabel: string): string =>
  crypto.createHash("sha256").update(`${roomIndex}:${roomLabel}`).digest("hex").slice(0, 16);

/**
 * Pure, deterministic generation: confirmed proposal facts + approved
 * knowledge in, validated room-recommendation.v1 payload out. No model call,
 * no proposal write, no clock — callers supply nothing time-dependent, so the
 * same input always produces byte-identical output (the idempotency
 * fingerprint depends on this).
 */
export const computeRoomRecommendations = (input: {
  proposalId: string;
  proposalVersion: number;
  proposal: Record<string, unknown>;
  knowledge: RoomKnowledgeEntry[];
}): RoomRecommendationResult => {
  const rooms = roomFacts(input.proposal);
  const event = record(input.proposal.event);
  const venueSchedule = record(input.proposal.venueSchedule);
  const hybridVirtual = record(input.proposal.hybridVirtual);

  const blocks: RoomBlock[] = rooms.map((room) => {
    const ctx: RuleContext = { room, rooms, event, venueSchedule, hybridVirtual, knowledge: input.knowledge };
    const core = hasCoreRoomFacts(room);
    const recommendations: RoomRecommendation[] = [];
    const clarificationQuestions: RoomClarificationQuestion[] = [];
    const warnings: RoomWarning[] = [];
    for (const rule of ROOM_RULES) {
      // Missing purpose or attendance means we ask, not invent: value-producing
      // rules are suppressed for that room while validations still run.
      if (rule.requiresCoreFacts && (!core.purpose || !core.attendance)) continue;
      for (const output of rule.evaluate(ctx)) {
        if (output.kind === "recommendation") {
          const path = `/content/roomByRoom/${room.index}/${output.relativePath}`;
          recommendations.push({
            recommendationKey: `${rule.id}:${room.index}:${output.relativePath}${output.keySuffix ? `/${output.keySuffix}` : ""}`,
            path,
            mongoPath: `roomByRoom.${room.index}.${output.relativePath.replace(/\//g, ".")}`,
            value: output.value,
            classification: output.classification,
            confidence: output.confidence,
            explanation: output.explanation,
            evidence: output.evidence,
            ruleIds: [rule.id],
            knowledgeIds: output.knowledgeIds,
            assumptions: output.assumptions,
            // This slice never applies anything unattended; every generated
            // value is review-gated regardless of classification.
            requiresHumanReview: true,
            applyEligible: isApplyEligiblePath(path),
          });
        } else if (output.kind === "question") {
          clarificationQuestions.push({
            questionKey: `${rule.id}:${room.index}:${output.questionKeySuffix}`,
            ruleId: rule.id,
            prompt: output.prompt,
            paths: output.paths,
          });
        } else {
          warnings.push({ code: output.code, ruleId: rule.id, severity: output.severity, message: output.message, paths: output.paths });
        }
      }
    }
    return {
      roomKey: `room-${room.index}-${roomIdentityChecksum(room.index, room.label)}`,
      roomIndex: room.index,
      roomLabel: room.label,
      recommendations,
      clarificationQuestions,
      warnings,
    };
  });

  const globalClarificationQuestions: RoomClarificationQuestion[] = [];
  const globalWarnings: RoomWarning[] = [];
  const proposalCtx: RuleContext = {
    room: rooms[0] ?? { index: 0, label: "", raw: {} },
    rooms,
    event,
    venueSchedule,
    hybridVirtual,
    knowledge: input.knowledge,
  };
  for (const rule of PROPOSAL_RULES) {
    for (const output of rule.evaluate(proposalCtx)) {
      if (output.kind === "question")
        globalClarificationQuestions.push({ questionKey: `${rule.id}:0:${output.questionKeySuffix}`, ruleId: rule.id, prompt: output.prompt, paths: output.paths });
      else if (output.kind === "warning")
        globalWarnings.push({ code: output.code, ruleId: rule.id, severity: output.severity, message: output.message, paths: output.paths });
    }
  }

  const knowledgeIds = [...new Set(
    blocks.flatMap((block) => block.recommendations.flatMap((item) => item.knowledgeIds)),
  )].sort();

  return validateRoomRecommendationResult({
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    rooms: blocks,
    globalClarificationQuestions,
    globalWarnings,
    knowledgeIds,
  });
};

/**
 * Fingerprint of everything generation depends on. Repeated requests against
 * an unchanged proposal return the stored run instead of a duplicate row.
 */
export const generationFingerprint = (input: {
  proposalVersion: number;
  proposal: Record<string, unknown>;
  knowledge: RoomKnowledgeEntry[];
}): string =>
  crypto.createHash("sha256").update(JSON.stringify({
    engineVersion: ENGINE_VERSION,
    proposalVersion: input.proposalVersion,
    rooms: Array.isArray(input.proposal.roomByRoom) ? input.proposal.roomByRoom : [],
    event: record(input.proposal.event),
    venueSchedule: record(input.proposal.venueSchedule),
    hybridVirtual: record(input.proposal.hybridVirtual),
    knowledgeIds: input.knowledge.map((entry) => entry.id).sort(),
  })).digest("hex");
