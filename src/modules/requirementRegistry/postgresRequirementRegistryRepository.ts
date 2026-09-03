/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import {
  checksum,
  duplicateRequirementIds,
  normalizeCriterionWeights,
  RequirementRegistryError,
  suggestedCriterionKey,
  suggestedMandatoryStatus,
  suggestedVerificationMethod,
  validateForApproval,
} from "./domain";
import type { RequirementUpdate } from "./domain";
import {
  generateCriteria,
  generateRequirements,
  REQUIREMENT_GENERATOR_VERSION, isPlannerInstructionLocator } from "./generator";
import type { RenderedParagraph } from "./generator";
import {
  activeProposalWorkflowContent,
  activeProposalWorkflowFingerprintContent,
  CANONICAL_STANDALONE_VIDEO_RECORDING_ROOT,
  LEGACY_STANDALONE_VIDEO_RECORDING_ROOT,
  LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
  proposalWorkflowSectionEnabled,
} from "../proposals/domain/workflowSections";
import { PROPOSAL_DRAFT_INPUT_VERSION } from "../proposalDraft/domain";

type Context = {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  correlationId: string;
};

const tenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationMongoId]);
  const result = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!result.rows[0])
    throw new RequirementRegistryError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503);
  await client.query("SELECT set_config('app.organization_id',$1,true)", [result.rows[0].id]);
  return result.rows[0].id;
};

const owned = async (client: PoolClient, proposalMongoId: string, actorUserMongoId: string) => {
  const result = await client.query<{ id: string }>(
    `SELECT p.id FROM rfpilot.proposal_references p
     JOIN rfpilot.users u ON u.id=p.owner_user_id
     WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2`,
    [proposalMongoId, actorUserMongoId],
  );
  if (!result.rows[0])
    throw new RequirementRegistryError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0].id;
};

const loadProposal = async (input: Context) => {
  const proposal = await Proposal.findOne({
    _id: input.proposalMongoId,
    organizationId: input.organizationMongoId,
    userId: input.actorUserMongoId,
  }).lean<any>();
  if (!proposal)
    throw new RequirementRegistryError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  const activeProposal = activeProposalWorkflowContent(
    proposal as Record<string, unknown>,
  );
  const fingerprint = checksum(
    activeProposalWorkflowFingerprintContent(
      proposal as Record<string, unknown>,
    ),
  );
  return {
    proposal: activeProposal,
    version: fingerprint,
    checksum: fingerprint,
  };
};

const renderedParagraphs = async (client: PoolClient, proposalReferenceId: string) => {
  const run = await client.query<any>(
    `SELECT r.id,r.output_checksum FROM rfpilot.proposal_draft_runs r
     JOIN rfpilot.ai_jobs j
       ON j.id=r.job_id AND j.input_version=$2
     WHERE r.proposal_reference_id=$1 AND r.status='succeeded' AND r.section_scope IS NULL
       AND r.retention_until>now()
     ORDER BY r.created_at DESC LIMIT 1`,
    [proposalReferenceId, PROPOSAL_DRAFT_INPUT_VERSION],
  );
  if (!run.rows[0]) return { run: null, paragraphs: [] as RenderedParagraph[] };
  const rows = await client.query<any>(
    `SELECT s.key section_key,p.id paragraph_id,p.ordinal,p.text
     FROM rfpilot.proposal_draft_sections s
     JOIN rfpilot.proposal_draft_paragraphs p ON p.section_id=s.id
     JOIN rfpilot.proposal_draft_section_decisions d
       ON d.run_id=s.run_id AND d.section_key=s.key AND d.decision='accepted'
     WHERE s.run_id=$1
       AND NOT EXISTS(
         SELECT 1 FROM rfpilot.proposal_draft_citations retired
          WHERE retired.paragraph_id=p.id
            AND (retired.canonical_path=$2
              OR retired.canonical_path LIKE $2||'/%'
              OR retired.canonical_path=$3
              OR retired.canonical_path LIKE $3||'/%')
       )
     ORDER BY s.ordinal,p.ordinal`,
    [
      run.rows[0].id,
      LEGACY_STANDALONE_VIDEO_RECORDING_ROOT,
      CANONICAL_STANDALONE_VIDEO_RECORDING_ROOT,
    ],
  );
  return {
    run: run.rows[0] as { id: string; output_checksum: string | null },
    paragraphs: rows.rows.map((row) => ({
      runId: run.rows[0].id,
      runChecksum: run.rows[0].output_checksum,
      sectionKey: row.section_key,
      paragraphId: row.paragraph_id,
      ordinal: Number(row.ordinal),
      text: row.text,
    })),
  };
};

const requirementRows = (client: PoolClient, setId: string) =>
  client.query<any>(
    `SELECT r.*,c.criterion_key,c.name criterion_name
     FROM rfpilot.requirements r
     LEFT JOIN rfpilot.evaluation_criteria c ON c.id=r.criterion_id
     WHERE r.requirement_set_id=$1
       AND ($2::boolean OR r.group_key IS DISTINCT FROM $3)
     ORDER BY r.ordinal`,
    [
      setId,
      proposalWorkflowSectionEnabled("video_recording"),
      LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
    ],
  );
const criterionRows = (client: PoolClient, setId: string) =>
  client.query<any>(
    `SELECT c.*,m.weights_confirmed,m.total_weight,m.status matrix_status,m.id matrix_version_id
     FROM rfpilot.evaluation_matrix_versions m
     JOIN rfpilot.evaluation_criteria c ON c.matrix_version_id=m.id
     WHERE m.requirement_set_id=$1 ORDER BY c.ordinal`,
    [setId],
  );

const validationForRows = (requirements: any[], criteria: any[]) =>
  validateForApproval({
    weightsConfirmed: criteria[0]?.weights_confirmed === true,
    criteria: criteria.map((item) => ({
      id: item.id,
      weight: Number(item.weight),
    })),
    requirements,
  });

const contentChecksumForRows = (requirements: any[], criteria: any[]) =>
  checksum({
    criteria: criteria.map(({ id, criterion_key, name, description, weight, rubric, price_visibility, human_only, ordinal }) => ({ id, criterion_key, name, description, weight: Number(weight), rubric, price_visibility, human_only, ordinal })),
    requirements: requirements.map(({ id, requirement_key, kind, title, normalized_text, mandatory_status, mandatory_reviewed, eligibility, source_kind, source_locator, criterion_id, criterion_reviewed, importance, verification_method, included, inclusion_reviewed, group_key, parent_requirement_id, ordinal, provenance }) => ({ id, requirement_key, kind, title, normalized_text, mandatory_status, mandatory_reviewed, eligibility, source_kind, source_locator, criterion_id, criterion_reviewed, importance, verification_method, included, inclusion_reviewed, group_key, parent_requirement_id, ordinal, provenance })),
  });

const refreshValidationAndChecksum = async (client: PoolClient, setId: string) => {
  const [requirements, criteria] = await Promise.all([
    requirementRows(client, setId),
    criterionRows(client, setId),
  ]);
  const validation = validationForRows(requirements.rows, criteria.rows);
  const contentChecksum = contentChecksumForRows(requirements.rows, criteria.rows);
  await client.query(
    "UPDATE rfpilot.requirement_sets SET validation=$2::jsonb,content_checksum=$3,updated_at=now() WHERE id=$1",
    [setId, JSON.stringify(validation), contentChecksum],
  );
  return { validation, contentChecksum, requirements: requirements.rows, criteria: criteria.rows };
};

const operation = async (client: PoolClient, organizationId: string, idempotencyKey: string) => {
  const epochKey = `requirement-registry:${REQUIREMENT_GENERATOR_VERSION}:${checksum(idempotencyKey)}`;
  const result = await client.query<any>(
    `SELECT o.* FROM rfpilot.requirement_registry_operations o
     JOIN rfpilot.requirement_sets s
       ON s.id=o.requirement_set_id AND s.generator_version=$3
     WHERE o.organization_id=$1 AND o.idempotency_key=$2`,
    [organizationId, epochKey, REQUIREMENT_GENERATOR_VERSION],
  );
  return result.rows[0] ?? null;
};

const registryEpochKey = (idempotencyKey: string) =>
  `requirement-registry:${REQUIREMENT_GENERATOR_VERSION}:${checksum(idempotencyKey)}`;

const audit = (
  client: PoolClient,
  input: Context,
  organizationId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
) => client.query(
  `INSERT INTO rfpilot.audit_events(
    id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata
   ) VALUES($1,$2,$3,$4,'requirement_set',$5,'allow',$6,$7::jsonb)`,
  [uuidv7(), organizationId, input.actorUserMongoId, action, targetId, input.correlationId, JSON.stringify(metadata)],
);

const view = async (
  client: PoolClient,
  setId: string,
  current: { version: string; checksum: string },
) => {
  const setResult = await client.query<any>(
    "SELECT * FROM rfpilot.requirement_sets WHERE id=$1",
    [setId],
  );
  const set = setResult.rows[0];
  if (!set)
    throw new RequirementRegistryError("REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found.", 404);
  const [requirements, criteria] = await Promise.all([
    requirementRows(client, setId),
    criterionRows(client, setId),
  ]);
  const staleReasons: string[] = [];
  if (String(set.proposal_version) !== current.version) staleReasons.push("proposal_version_changed");
  if (String(set.proposal_checksum) !== current.checksum) staleReasons.push("proposal_content_changed");
  if (String(set.generator_version) !== REQUIREMENT_GENERATOR_VERSION) staleReasons.push("requirement_policy_changed");
  const validation = validationForRows(requirements.rows, criteria.rows);
  const contentChecksum = contentChecksumForRows(requirements.rows, criteria.rows);
  return {
    set: {
      ...set,
      validation,
      content_checksum: contentChecksum,
      requirement_count: requirements.rows.length,
    },
    matrix: criteria.rows.length ? {
      id: criteria.rows[0].matrix_version_id,
      status: criteria.rows[0].matrix_status,
      weightsConfirmed: criteria.rows[0].weights_confirmed,
      totalWeight: Number(criteria.rows[0].total_weight),
      criteria: criteria.rows,
    } : null,
    requirements: requirements.rows,
    freshness: { stale: staleReasons.length > 0, reasons: staleReasons, currentProposalVersion: current.version, currentProposalChecksum: current.checksum },
  };
};

export const requirementRegistryRepository = {
  async create(input: Context & { idempotencyKey: string }) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const epochIdempotencyKey = registryEpochKey(input.idempotencyKey);
      await client.query("SELECT id FROM rfpilot.proposal_references WHERE id=$1 FOR UPDATE", [proposalReferenceId]);
      const old = await client.query<any>(
        "SELECT id FROM rfpilot.requirement_sets WHERE organization_id=$1 AND idempotency_key=$2 AND generator_version=$3",
        [organizationId, epochIdempotencyKey, REQUIREMENT_GENERATOR_VERSION],
      );
      if (old.rows[0]) return { data: await view(client, old.rows[0].id, current), created: false };
      const rendered = await renderedParagraphs(client, proposalReferenceId);
      const criteria = generateCriteria(current.proposal);
      const requirements = generateRequirements(current.proposal, rendered.paragraphs);
      if (!requirements.length)
        throw new RequirementRegistryError("REQUIREMENTS_EMPTY", "The proposal contains no requirements to register.", 422);
      const versionResult = await client.query<{ version: number }>(
        "SELECT coalesce(max(version),0)::int+1 version FROM rfpilot.requirement_sets WHERE proposal_reference_id=$1",
        [proposalReferenceId],
      );
      const version = versionResult.rows[0].version;
      const setId = uuidv7();
      const matrixId = uuidv7();
      const criterionIds = new Map(criteria.map((item) => [item.key, uuidv7()]));
      const initialValidation = validateForApproval({
        weightsConfirmed: (current.proposal.budget as any)?.evaluationMatrixConfirmed === true,
        criteria: criteria.map((item) => ({ id: criterionIds.get(item.key)!, weight: item.weight })),
        requirements: requirements.map((item) => ({ included: !isPlannerInstructionLocator(item.sourceLocator), inclusion_reviewed: isPlannerInstructionLocator(item.sourceLocator), normalized_text: item.text, mandatory_status: "pending", mandatory_reviewed: false, source_locator: item.sourceLocator, criterion_id: null, criterion_reviewed: false, verification_method: "pending" })),
      });
      await client.query(
        `INSERT INTO rfpilot.requirement_sets(
          id,organization_id,proposal_reference_id,version,proposal_version,proposal_checksum,
          rendered_rfp_run_id,rendered_rfp_checksum,generator_version,validation,content_checksum,idempotency_key,created_by_external_user_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [setId, organizationId, proposalReferenceId, version, current.version, current.checksum, rendered.run?.id ?? null, rendered.run?.output_checksum ?? null, REQUIREMENT_GENERATOR_VERSION, JSON.stringify(initialValidation), checksum({ criteria, requirements }), epochIdempotencyKey, input.actorUserMongoId],
      );
      const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);
      await client.query(
        `INSERT INTO rfpilot.evaluation_matrix_versions(
          id,organization_id,proposal_reference_id,requirement_set_id,version,weights_confirmed,total_weight,content_checksum
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [matrixId, organizationId, proposalReferenceId, setId, version, (current.proposal.budget as any)?.evaluationMatrixConfirmed === true, totalWeight, checksum(criteria)],
      );
      for (const criterion of criteria) {
        await client.query(
          `INSERT INTO rfpilot.evaluation_criteria(
            id,organization_id,matrix_version_id,criterion_key,name,description,weight,rubric,ordinal
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [criterionIds.get(criterion.key), organizationId, matrixId, criterion.key, criterion.name, criterion.description, criterion.weight, JSON.stringify(criterion.rubric), criterion.ordinal],
        );
      }
      for (const requirement of requirements) {
        await client.query(
          `INSERT INTO rfpilot.requirements(
            id,organization_id,requirement_set_id,requirement_key,kind,title,normalized_text,
            mandatory_status,source_kind,source_locator,criterion_id,importance,verification_method,
            group_key,ordinal,updated_by_external_user_id,included,inclusion_reviewed
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [uuidv7(), organizationId, setId, requirement.key, requirement.kind, requirement.title, requirement.text, requirement.mandatoryStatus, requirement.sourceKind, JSON.stringify(requirement.sourceLocator), criterionIds.get(requirement.suggestedCriterionKey ?? "") ?? null, requirement.importance, requirement.verificationMethod, requirement.groupKey.slice(0, 100), requirement.ordinal, input.actorUserMongoId, !isPlannerInstructionLocator(requirement.sourceLocator), isPlannerInstructionLocator(requirement.sourceLocator)],
        );
      }
      await client.query(
        "INSERT INTO rfpilot.requirement_registry_operations(id,organization_id,idempotency_key,operation,requirement_set_id,result_lock_version) VALUES($1,$2,$3,'generate',$4,1)",
        [uuidv7(), organizationId, epochIdempotencyKey, setId],
      );
      await audit(client, input, organizationId, "requirement_set.generated", setId, { version, requirementCount: requirements.length, criterionCount: criteria.length, renderedParagraphCount: rendered.paragraphs.length });
      return { data: await view(client, setId, current), created: true };
    });
  },

  async list(input: Context) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const result = await client.query<any>(
        `SELECT s.*,(SELECT count(*)::int FROM rfpilot.requirements r
                     WHERE r.requirement_set_id=s.id
                       AND ($2::boolean OR r.group_key IS DISTINCT FROM $3)) requirement_count
         FROM rfpilot.requirement_sets s
         WHERE s.proposal_reference_id=$1 AND s.generator_version=$4
         ORDER BY s.version DESC`,
        [
          proposalReferenceId,
          proposalWorkflowSectionEnabled("video_recording"),
          LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY,
          REQUIREMENT_GENERATOR_VERSION,
        ],
      );
      return Promise.all(result.rows.map(async (set) => {
        const [requirements, criteria] = await Promise.all([
          requirementRows(client, set.id),
          criterionRows(client, set.id),
        ]);
        return {
          ...set,
          requirement_count: requirements.rows.length,
          validation: validationForRows(requirements.rows, criteria.rows),
          content_checksum: contentChecksumForRows(requirements.rows, criteria.rows),
          freshness: {
            stale: String(set.proposal_version) !== current.version || String(set.proposal_checksum) !== current.checksum || String(set.generator_version) !== REQUIREMENT_GENERATOR_VERSION,
            reasons: [
              ...(String(set.proposal_version) !== current.version ? ["proposal_version_changed"] : []),
              ...(String(set.proposal_checksum) !== current.checksum ? ["proposal_content_changed"] : []),
              ...(String(set.generator_version) !== REQUIREMENT_GENERATOR_VERSION ? ["requirement_policy_changed"] : []),
            ],
          },
        };
      }));
    });
  },

  async read(input: Context & { setId: string }) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const belongs = await client.query("SELECT id FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND generator_version=$3", [input.setId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION]);
      if (!belongs.rows[0]) throw new RequirementRegistryError("REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found.", 404);
      return view(client, input.setId, current);
    });
  },

  async updateRequirement(input: Context & { setId: string; requirementId: string; idempotencyKey: string; expectedVersion: number; update: RequirementUpdate }) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const replay = await operation(client, organizationId, input.idempotencyKey);
      if (replay) return view(client, replay.requirement_set_id, current);
      const setResult = await client.query<any>("SELECT * FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND generator_version=$3 FOR UPDATE", [input.setId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION]);
      const set = setResult.rows[0];
      if (!set) throw new RequirementRegistryError("REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found.", 404);
      if (!['draft','in_review'].includes(set.status)) throw new RequirementRegistryError("REQUIREMENT_SET_IMMUTABLE", "Approved requirement sets cannot be edited.", 409);
      if (set.lock_version !== input.expectedVersion) throw new RequirementRegistryError("REQUIREMENT_SET_VERSION_CONFLICT", "The requirement set changed. Refresh and try again.", 409);
      if (set.proposal_version !== current.version || set.proposal_checksum !== current.checksum) throw new RequirementRegistryError("REQUIREMENT_SET_STALE", "The proposal changed. Supersede this set before editing.", 409);
      if (input.update.criterionId) {
        const criterion = await client.query(
          `SELECT c.id FROM rfpilot.evaluation_criteria c JOIN rfpilot.evaluation_matrix_versions m ON m.id=c.matrix_version_id
           WHERE c.id=$1 AND m.requirement_set_id=$2`,
          [input.update.criterionId, input.setId],
        );
        if (!criterion.rows[0]) throw new RequirementRegistryError("INVALID_CRITERION", "Criterion was not found in this requirement set.", 400);
      }
      const columns: Array<[string, unknown]> = [];
      const mapping: Record<keyof RequirementUpdate, string> = {
        title: "title", text: "normalized_text", kind: "kind", mandatoryStatus: "mandatory_status",
        mandatoryReviewed: "mandatory_reviewed", eligibility: "eligibility", criterionId: "criterion_id",
        criterionReviewed: "criterion_reviewed", importance: "importance", verificationMethod: "verification_method",
        included: "included", inclusionReviewed: "inclusion_reviewed",
      };
      for (const [key, column] of Object.entries(mapping) as Array<[keyof RequirementUpdate, string]>)
        if (Object.prototype.hasOwnProperty.call(input.update, key)) columns.push([column, input.update[key] ?? null]);
      const values = columns.map(([, value]) => value);
      const assignments = columns.map(([column], index) => `${column}=$${index + 4}`).join(",");
      const updated = await client.query(
        `UPDATE rfpilot.requirements SET ${assignments},updated_by_external_user_id=$${values.length + 4},updated_at=now()
         WHERE id=$1 AND requirement_set_id=$2 AND organization_id=$3
           AND ($${values.length + 5}::boolean OR group_key IS DISTINCT FROM $${values.length + 6})
         RETURNING id`,
        [input.requirementId, input.setId, organizationId, ...values, input.actorUserMongoId,
          proposalWorkflowSectionEnabled("video_recording"), LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY],
      );
      if (!updated.rows[0]) throw new RequirementRegistryError("REQUIREMENT_NOT_FOUND", "Requirement was not found.", 404);
      await client.query("UPDATE rfpilot.requirement_sets SET status='in_review',lock_version=lock_version+1,updated_at=now() WHERE id=$1", [input.setId]);
      await refreshValidationAndChecksum(client, input.setId);
      await client.query(
        "INSERT INTO rfpilot.requirement_registry_operations(id,organization_id,idempotency_key,operation,requirement_set_id,result_lock_version) VALUES($1,$2,$3,'edit',$4,$5)",
        [uuidv7(), organizationId, registryEpochKey(input.idempotencyKey), input.setId, input.expectedVersion + 1],
      );
      await audit(client, input, organizationId, "requirement.updated", input.setId, { requirementId: input.requirementId, changedFields: Object.keys(input.update), lockVersion: input.expectedVersion + 1 });
      return view(client, input.setId, current);
    });
  },

  async prepare(input: Context & { setId: string; idempotencyKey: string; expectedVersion: number }) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const replay = await operation(client, organizationId, input.idempotencyKey);
      if (replay) return view(client, replay.requirement_set_id, current);
      const setResult = await client.query<any>("SELECT * FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND generator_version=$3 FOR UPDATE", [input.setId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION]);
      const set = setResult.rows[0];
      if (!set) throw new RequirementRegistryError("REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found.", 404);
      if (!["draft", "in_review"].includes(set.status)) throw new RequirementRegistryError("REQUIREMENT_SET_IMMUTABLE", "Approved requirement sets cannot be edited.", 409);
      if (set.lock_version !== input.expectedVersion) throw new RequirementRegistryError("REQUIREMENT_SET_VERSION_CONFLICT", "The requirement set changed. Refresh and try again.", 409);
      if (set.proposal_version !== current.version || set.proposal_checksum !== current.checksum) throw new RequirementRegistryError("REQUIREMENT_SET_STALE", "The proposal changed. Supersede this set before editing.", 409);

      const [requirements, initialCriteria] = await Promise.all([
        requirementRows(client, input.setId),
        criterionRows(client, input.setId),
      ]);
      let criteria = initialCriteria;
      if (!criteria.rows.length) {
        const matrix = await client.query<any>("SELECT id FROM rfpilot.evaluation_matrix_versions WHERE requirement_set_id=$1", [input.setId]);
        if (!matrix.rows[0]) throw new RequirementRegistryError("CRITERIA_REQUIRED", "The evaluation matrix could not be prepared.", 409);
        const generatedCriteria = generateCriteria(current.proposal);
        for (const criterion of generatedCriteria) {
          await client.query(
            `INSERT INTO rfpilot.evaluation_criteria(
              id,organization_id,matrix_version_id,criterion_key,name,description,weight,rubric,ordinal
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
            [uuidv7(), organizationId, matrix.rows[0].id, criterion.key, criterion.name, criterion.description, criterion.weight, JSON.stringify(criterion.rubric), criterion.ordinal],
          );
        }
        criteria = await criterionRows(client, input.setId);
      }

      const normalizedWeights = normalizeCriterionWeights(criteria.rows.map((item) => ({ id: item.id, weight: Number(item.weight), ordinal: Number(item.ordinal) })));
      for (const criterion of normalizedWeights)
        await client.query("UPDATE rfpilot.evaluation_criteria SET weight=$2,updated_at=now() WHERE id=$1", [criterion.id, criterion.weight]);
      await client.query(
        "UPDATE rfpilot.evaluation_matrix_versions SET weights_confirmed=true,total_weight=100 WHERE requirement_set_id=$1",
        [input.setId],
      );

      const criterionIds = new Map(criteria.rows.map((item) => [item.criterion_key, item.id]));
      const duplicateIds = duplicateRequirementIds(requirements.rows.map((item) => ({
        id: item.id,
        kind: item.kind,
        normalized_text: item.normalized_text,
        source_kind: item.source_kind,
        group_key: item.group_key,
        ordinal: Number(item.ordinal),
      })));
      for (const requirement of requirements.rows) {
        // Instructions to vendors stay out unless the planner includes them by hand.
        const included = !duplicateIds.has(requirement.id) && !isPlannerInstructionLocator(requirement.source_locator);
        const criterionId = requirement.criterion_id ?? criterionIds.get(suggestedCriterionKey(requirement)) ?? null;
        await client.query(
          `UPDATE rfpilot.requirements SET included=$2,inclusion_reviewed=true,
             mandatory_status=$3,mandatory_reviewed=true,criterion_id=$4,criterion_reviewed=$5,
             verification_method=$6,updated_by_external_user_id=$7,updated_at=now()
           WHERE id=$1`,
          [
            requirement.id,
            included,
            suggestedMandatoryStatus(requirement.kind, requirement.normalized_text),
            criterionId,
            criterionId !== null,
            suggestedVerificationMethod(requirement.kind),
            input.actorUserMongoId,
          ],
        );
      }

      await client.query("UPDATE rfpilot.requirement_sets SET status='in_review',lock_version=lock_version+1,updated_at=now() WHERE id=$1", [input.setId]);
      const refreshed = await refreshValidationAndChecksum(client, input.setId);
      await client.query(
        "INSERT INTO rfpilot.requirement_registry_operations(id,organization_id,idempotency_key,operation,requirement_set_id,result_lock_version) VALUES($1,$2,$3,'edit',$4,$5)",
        [uuidv7(), organizationId, registryEpochKey(input.idempotencyKey), input.setId, input.expectedVersion + 1],
      );
      await audit(client, input, organizationId, "requirement_set.prepared", input.setId, {
        normalizedCriterionCount: normalizedWeights.length,
        reviewedRequirementCount: requirements.rows.length,
        excludedDuplicateCount: duplicateIds.size,
        remainingBlockerCount: refreshed.validation.blocking.length,
      });
      return view(client, input.setId, current);
    });
  },

  async approve(input: Context & { setId: string; idempotencyKey: string; expectedVersion: number }) {
    const current = await loadProposal(input);
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      const proposalReferenceId = await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const replay = await operation(client, organizationId, input.idempotencyKey);
      if (replay) return view(client, replay.requirement_set_id, current);
      const result = await client.query<any>("SELECT * FROM rfpilot.requirement_sets WHERE id=$1 AND proposal_reference_id=$2 AND generator_version=$3 FOR UPDATE", [input.setId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION]);
      const set = result.rows[0];
      if (!set) throw new RequirementRegistryError("REQUIREMENT_SET_NOT_FOUND", "Requirement set was not found.", 404);
      if (!['draft','in_review'].includes(set.status)) throw new RequirementRegistryError("REQUIREMENT_SET_IMMUTABLE", "This requirement set is already frozen.", 409);
      if (set.lock_version !== input.expectedVersion) throw new RequirementRegistryError("REQUIREMENT_SET_VERSION_CONFLICT", "The requirement set changed. Refresh and try again.", 409);
      if (set.proposal_version !== current.version || set.proposal_checksum !== current.checksum) throw new RequirementRegistryError("REQUIREMENT_SET_STALE", "The proposal changed. Supersede this set before approval.", 409);
      const refreshed = await refreshValidationAndChecksum(client, input.setId);
      if (refreshed.validation.blocking.length)
        throw new RequirementRegistryError("REQUIREMENT_SET_NOT_READY", "Resolve all blocking validation items before approval.", 409);
      await client.query("UPDATE rfpilot.evaluation_matrix_versions SET status='approved',approved_at=now() WHERE requirement_set_id=$1", [input.setId]);
      await client.query(
        `UPDATE rfpilot.requirement_sets SET status='approved',lock_version=lock_version+1,
         approved_by_external_user_id=$2,approved_at=now(),updated_at=now() WHERE id=$1`,
        [input.setId, input.actorUserMongoId],
      );
      await client.query(
        "INSERT INTO rfpilot.requirement_registry_operations(id,organization_id,idempotency_key,operation,requirement_set_id,result_lock_version) VALUES($1,$2,$3,'approve',$4,$5)",
        [uuidv7(), organizationId, registryEpochKey(input.idempotencyKey), input.setId, input.expectedVersion + 1],
      );
      await audit(client, input, organizationId, "requirement_set.approved", input.setId, { version: set.version, requirementCount: refreshed.requirements.length, criterionCount: refreshed.criteria.length, contentChecksum: refreshed.contentChecksum });
      return view(client, input.setId, current);
    });
  },

  async supersede(input: Context & { setId: string; idempotencyKey: string }) {
    const existing = await this.read({ ...input, setId: input.setId });
    if (existing.set.status === "superseded" && existing.set.superseded_by_id)
      return this.read({ ...input, setId: existing.set.superseded_by_id });
    if (existing.set.status !== "approved")
      throw new RequirementRegistryError("REQUIREMENT_SET_NOT_APPROVED", "Only an approved requirement set can be superseded.", 409);
    const created = await this.create({ ...input, idempotencyKey: `supersede-draft:${checksum(input.idempotencyKey)}` });
    const nextId = created.data.set.id;
    await withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId);
      await owned(client, input.proposalMongoId, input.actorUserMongoId);
      const replay = await operation(client, organizationId, input.idempotencyKey);
      if (replay) return;
      await client.query(
        "UPDATE rfpilot.requirement_sets SET status='superseded',superseded_by_id=$2,superseded_at=now(),updated_at=now() WHERE id=$1 AND status='approved'",
        [input.setId, nextId],
      );
      await client.query(
        "INSERT INTO rfpilot.requirement_registry_operations(id,organization_id,idempotency_key,operation,requirement_set_id,result_lock_version) VALUES($1,$2,$3,'supersede',$4,$5)",
        [uuidv7(), organizationId, registryEpochKey(input.idempotencyKey), input.setId, existing.set.lock_version],
      );
      await audit(client, input, organizationId, "requirement_set.superseded", input.setId, { supersededById: nextId });
    });
    return created.data;
  },
};
