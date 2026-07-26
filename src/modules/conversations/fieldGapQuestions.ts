import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import Proposal from "../../../modal/proposalsModel";
import { mongoPathFor } from "../candidateApplication/canonicalMapping";
import { IMPORTANT_FIELD_QUESTIONS, MAX_OPEN_FIELD_QUESTIONS, fieldQuestionCode } from "./domain";

/*
 * Questions used to originate only from an extraction run, so a proposal
 * started by conversation alone was never asked anything. Every high-impact
 * field that is still empty now becomes a question in its own right, which
 * makes the guided flow work with or without uploaded files. Answers are
 * written back through the same canonical mapping, so answering the questions
 * is itself a way to build the proposal.
 */

const PLACEHOLDER = new Set(["untitled proposal"]);
const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" ||
  (typeof value === "string" && (value.trim() === "" || PLACEHOLDER.has(value.trim().toLowerCase())));

const readPath = (row: Record<string, unknown>, mongoPath: string): unknown =>
  mongoPath.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), row);

export const syncFieldGapQuestions = async (
  c: PoolClient,
  organizationId: string,
  proposalReferenceId: string,
  conversationId: string,
  input: { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string },
): Promise<void> => {
  // The canonical mapping owns path -> mongo path; no value validation here.
  const mapped = IMPORTANT_FIELD_QUESTIONS.map((field) => ({ field, mongoPath: mongoPathFor(field.path) }));
  const paths = mapped.map((item) => item.mongoPath).filter((path): path is string => Boolean(path));
  const proposal = await Proposal.findOne({
    _id: input.proposalMongoId,
    userId: input.actorUserMongoId,
    organizationId: input.organizationMongoId,
  }).select(paths.join(" ")).lean<Record<string, unknown>>();
  if (!proposal) return;

  const open = await c.query<{ n: number }>(
    "SELECT count(*)::int n FROM rfpilot.clarification_questions WHERE proposal_reference_id=$1 AND status='open'",
    [proposalReferenceId],
  );
  let budget = MAX_OPEN_FIELD_QUESTIONS - Number(open.rows[0]?.n ?? 0);

  for (const { field, mongoPath } of mapped) {
    if (!mongoPath) continue;
    const filled = !isEmpty(readPath(proposal, mongoPath));
    const code = fieldQuestionCode(field.path);
    if (filled) {
      // The planner answered it elsewhere (editor, extraction): retire the ask.
      await c.query(
        "UPDATE rfpilot.clarification_questions SET status='superseded',updated_at=now() WHERE proposal_reference_id=$1 AND issue_code=$2 AND status='open'",
        [proposalReferenceId, code],
      );
      continue;
    }
    if (budget <= 0) continue;
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO rfpilot.clarification_questions(id,organization_id,proposal_reference_id,conversation_id,context_run_id,issue_code,severity,canonical_paths,prompt)
       VALUES($1,$2,$3,$4,NULL,$5,'question',$6::jsonb,$7)
       ON CONFLICT DO NOTHING RETURNING id`,
      [uuidv7(), organizationId, proposalReferenceId, conversationId, code, JSON.stringify([field.path]), field.prompt.slice(0, 1000)],
    );
    if (inserted.rows[0]) budget -= 1;
  }
};
