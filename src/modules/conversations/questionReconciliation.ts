import type { PoolClient } from "pg";
import { activeCandidatePaths } from "../candidateApplication/canonicalMapping";
import { isRetiredProposalWorkflowPath } from "../proposals/domain/workflowSections";
import {
  fieldQuestionCode, IMPORTANT_FIELD_QUESTIONS, importantFieldPaths,
  isCatchAllIssue, MAX_OPEN_FIELD_QUESTIONS, questionPrompt,
} from "./domain";

type Issue = { code: string; severity: string; paths: string[] };
export type PlannedQuestion = Issue & { prompt: string };
export const isDecisionQuestion = (code: string, severity: string) =>
  severity === "blocking" || /CONFLICT|PROMPT_INJECTION/i.test(code);

/** Field identity, not a model's diagnostic code, owns ordinary follow-ups. */
export function planExtractionQuestions(issues: Issue[]): PlannedQuestion[] {
  const questions = new Map<string, PlannedQuestion>();
  let ordinaryCount = 0;
  for (const issue of issues) {
    const paths = [...new Set(issue.paths ?? [])];
    if (!paths.length || paths.some(isRetiredProposalWorkflowPath)) continue;
    if (isDecisionQuestion(issue.code, issue.severity)) {
      // Never drop a conflict just because eight ordinary gaps were asked.
      questions.set(issue.code, { ...issue, paths, prompt: questionPrompt(issue.code, paths) });
      continue;
    }
    const fields = isCatchAllIssue(issue.code, paths)
      ? IMPORTANT_FIELD_QUESTIONS.filter(field => importantFieldPaths(field).some(path => paths.includes(path))).flatMap(field => importantFieldPaths(field))
      : paths;
    for (const path of fields) {
      if (!activeCandidatePaths.includes(path)) continue;
      const composite = IMPORTANT_FIELD_QUESTIONS.find(field => field.answerType === "date_time" && importantFieldPaths(field).includes(path));
      const targets = composite ? importantFieldPaths(composite) : [path];
      const code = fieldQuestionCode(targets[0]);
      if (questions.has(code) || ordinaryCount >= MAX_OPEN_FIELD_QUESTIONS) continue;
      questions.set(code, { code, severity: "question", paths: targets, prompt: questionPrompt(code, targets) });
      ordinaryCount += 1;
    }
  }
  return [...questions.values()];
}

export type QuestionRow = {
  id: string; issue_code: string; severity: string; canonical_paths: string[];
  status: string; context_run_id: string | null;
};

/** Only supersede redundant open field gaps; preserve human answers and decisions. */
export function duplicateQuestionIds(rows: QuestionRow[]): string[] {
  const groups = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    if (isDecisionQuestion(row.issue_code, row.severity) || !row.canonical_paths?.length) continue;
    const key = [...new Set(row.canonical_paths)].sort().join("|");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => {
    const resolved = group.some(row => row.status === "answered" || row.status === "dismissed");
    const open = group.filter(row => row.status === "open");
    // Prefer the stable beginner-intake row, so resolving it keeps the same
    // question id, answer control and progress position across every read.
    const keep = open.find(row => row.context_run_id === null) ?? open[0];
    return open.filter(row => resolved || row !== keep).map(row => row.id);
  });
}

export async function reconcileQuestionDuplicates(c: PoolClient, proposalRefId: string, inputVersion: string) {
  const result = await c.query<QuestionRow>(
    `SELECT q.id,q.issue_code,q.severity,q.canonical_paths,q.status,q.context_run_id
       FROM rfpilot.clarification_questions q
       LEFT JOIN rfpilot.proposal_context_runs r ON r.id=q.context_run_id
       LEFT JOIN rfpilot.ai_jobs j ON j.id=r.job_id AND j.input_version=$2
      WHERE q.proposal_reference_id=$1 AND q.status IN('open','answered','dismissed')
        AND (q.context_run_id IS NULL OR j.id IS NOT NULL)
      ORDER BY q.created_at,q.id`, [proposalRefId, inputVersion],
  );
  const ids = duplicateQuestionIds(result.rows);
  if (ids.length) await c.query(
    "UPDATE rfpilot.clarification_questions SET status='superseded',updated_at=now() WHERE proposal_reference_id=$1 AND id=ANY($2::uuid[]) AND status='open'",
    [proposalRefId, ids],
  );
}
