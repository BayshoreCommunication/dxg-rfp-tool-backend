import "./env";
import {
  ensureMigrated,
  ensureServices,
  seedTenant,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closePostgres, postgresPool } from "../config/postgres";
import {
  deterministicEmbedding,
  vectorLiteral,
} from "../src/modules/knowledgeRetrieval/deterministicEmbedding";
import { padToDimension } from "../src/modules/knowledgeRetrieval/embeddingProvider";
import { approvedKnowledgeSource } from "../src/modules/platformAssistant/approvedKnowledgeSource";
import { platformAssistantApplication } from "../src/modules/platformAssistant/composition";

process.env.KNOWLEDGE_RETRIEVAL_ENABLED = "true";
process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "mock";
process.env.LIVE_AI_KILL_SWITCH = "false";

const MOCK_EMBEDDING_RELEASE_ID = "40000000-0000-7000-8000-000000000001";

let tenantA: Tenant;
let tenantB: Tenant;
let activeOperating: SeededKnowledge;
let wrongSource: SeededKnowledge;
let expiredOperating: SeededKnowledge;
let wrongClassification: SeededKnowledge;
let otherTenantOperating: SeededKnowledge;
let assistantPolicyId: string;

type SeededKnowledge = {
  releaseId: string;
  fragmentId: string;
  content: string;
};

const context = (tenant: Tenant) => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  correlationId: crypto.randomUUID(),
});

const seedKnowledge = async (input: {
  tenant: Tenant;
  sourceType: "operating_guidance" | "price_sheet";
  content: string;
  effectiveAt: Date;
  expiresAt?: Date | null;
  classification?: "synthetic" | "internal";
}): Promise<SeededKnowledge> => {
  const sourceId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const parserRunId = crypto.randomUUID();
  const fragmentId = crypto.randomUUID();
  const reviewVersionId = crypto.randomUUID();
  const releaseId = crypto.randomUUID();
  const checksum = crypto.createHash("sha256").update(input.content).digest("hex");
  const embedding = vectorLiteral(
    padToDimension(deterministicEmbedding(input.content), 1536),
  );
  const client = await postgresPool().connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rfpilot.document_sources(
         id,organization_id,uploader_external_user_id,purpose,confidentiality,status
       ) VALUES($1,$2,$3,'organization_knowledge','internal','ready')`,
      [sourceId, input.tenant.organizationId, input.tenant.actorUserMongoId],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_import_batches(
         id,organization_id,name,status,source_type,classification,intended_use,
         created_by_external_user_id
       ) VALUES($1,$2,$3,'approved',$4,$5,'Platform assistant integration test',$6)`,
      [
        batchId,
        input.tenant.organizationId,
        `Assistant ${input.sourceType} ${batchId.slice(0, 8)}`,
        input.sourceType,
        input.classification ?? "synthetic",
        input.tenant.actorUserMongoId,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_import_documents(
         id,organization_id,batch_id,document_source_id,status,sha256,
         parser_kind,parser_version
       ) VALUES($1,$2,$3,$4,'needs_review',$5,'text','deterministic-v1')`,
      [
        documentId,
        input.tenant.organizationId,
        batchId,
        sourceId,
        checksum,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_parser_runs(
         id,organization_id,document_id,parser_kind,parser_version,status,
         fragment_count,started_at,completed_at
       ) VALUES($1,$2,$3,'text','deterministic-v1','succeeded',1,now(),now())`,
      [parserRunId, input.tenant.organizationId, documentId],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_source_fragments(
         id,organization_id,document_id,parser_run_id,ordinal,content,
         coordinates,checksum,review_status
       ) VALUES($1,$2,$3,$4,0,$5,'{"characterStart":0}'::jsonb,$6,'accepted')`,
      [
        fragmentId,
        input.tenant.organizationId,
        documentId,
        parserRunId,
        input.content,
        checksum,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_review_versions(
         id,organization_id,batch_id,version_number,status,
         submitted_by_external_user_id,submitted_checksum,effective_at,expires_at,
         created_by_external_user_id,submitted_at,decided_at
       ) VALUES($1,$2,$3,1,'approved',$4,$5,$6,$7,$4,now(),now())`,
      [
        reviewVersionId,
        input.tenant.organizationId,
        batchId,
        input.tenant.actorUserMongoId,
        checksum,
        input.effectiveAt,
        input.expiresAt ?? null,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_fragment_decisions(
         id,organization_id,review_version_id,fragment_id,decision,
         reviewed_by_external_user_id
       ) VALUES($1,$2,$3,$4,'accepted',$5)`,
      [
        crypto.randomUUID(),
        input.tenant.organizationId,
        reviewVersionId,
        fragmentId,
        input.tenant.actorUserMongoId,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_approval_decisions(
         id,organization_id,review_version_id,decision,
         decided_by_external_user_id,correlation_id
       ) VALUES($1,$2,$3,'approved',$4,$5)`,
      [
        crypto.randomUUID(),
        input.tenant.organizationId,
        reviewVersionId,
        input.tenant.actorUserMongoId,
        crypto.randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_releases(
         id,organization_id,batch_id,review_version_id,release_number,state,
         effective_at,expires_at,approved_by_external_user_id
       ) VALUES($1,$2,$3,$4,1,'active',$5,$6,$7)`,
      [
        releaseId,
        input.tenant.organizationId,
        batchId,
        reviewVersionId,
        input.effectiveAt,
        input.expiresAt ?? null,
        input.tenant.actorUserMongoId,
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_release_fragments(
         organization_id,release_id,fragment_id,fragment_checksum
       ) VALUES($1,$2,$3,$4)`,
      [input.tenant.organizationId, releaseId, fragmentId, checksum],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_release_events(
         id,organization_id,release_id,event_type,actor_external_user_id,
         correlation_id
       ) VALUES($1,$2,$3,'published',$4,$5)`,
      [
        crypto.randomUUID(),
        input.tenant.organizationId,
        releaseId,
        input.tenant.actorUserMongoId,
        crypto.randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO rfpilot.knowledge_fragment_embeddings(
         organization_id,release_id,fragment_id,embedding_model_release_id,
         fragment_checksum,embedding
       ) VALUES($1,$2,$3,$4,$5,$6::vector)`,
      [
        input.tenant.organizationId,
        releaseId,
        fragmentId,
        MOCK_EMBEDDING_RELEASE_ID,
        checksum,
        embedding,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { releaseId, fragmentId, content: input.content };
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenantA = await seedTenant("Assistant Knowledge Org A");
  tenantB = await seedTenant("Assistant Knowledge Org B");
  assistantPolicyId = crypto.randomUUID();
  await postgresPool().query(
    `INSERT INTO rfpilot.knowledge_retrieval_policies(
       id,stable_key,version,environment,purpose,classification,
       lexical_enabled,vector_enabled,lexical_weight,vector_weight,
       minimum_score,default_limit,maximum_limit,embedding_model_release_id,
       active,approved_at,effective_from
     ) VALUES(
       $1,'assistant-mock-knowledge','1.0.0','test','knowledge_retrieval',
       'synthetic',true,true,0.5000,0.5000,0.0000,8,8,$2,true,now(),now()
     )`,
    [assistantPolicyId, MOCK_EMBEDDING_RELEASE_ID],
  );

  const now = Date.now();
  activeOperating = await seedKnowledge({
    tenant: tenantA,
    sourceType: "operating_guidance",
    content:
      "An event brief should include event dates, venue, attendee count, room schedule, audio, video, lighting, streaming, recording, budget, and approval deadlines.",
    effectiveAt: new Date(now - 60_000),
  });
  wrongSource = await seedKnowledge({
    tenant: tenantA,
    sourceType: "price_sheet",
    content:
      "Event dates, venue, attendee count, room schedule, audio, video, lighting, streaming, recording, and budget appear in this price sheet.",
    effectiveAt: new Date(now - 60_000),
  });
  expiredOperating = await seedKnowledge({
    tenant: tenantA,
    sourceType: "operating_guidance",
    content:
      "Expired event guidance mentions event dates, venue, attendees, rooms, audio, video, lighting, and budget.",
    effectiveAt: new Date(now - 172_800_000),
    expiresAt: new Date(now - 86_400_000),
  });
  wrongClassification = await seedKnowledge({
    tenant: tenantA,
    sourceType: "operating_guidance",
    classification: "internal",
    content:
      "Internal event guidance mentions event dates, venue, attendees, rooms, audio, video, lighting, and budget.",
    effectiveAt: new Date(now - 60_000),
  });
  otherTenantOperating = await seedKnowledge({
    tenant: tenantB,
    sourceType: "operating_guidance",
    content:
      "Another tenant event guide mentions event dates, venue, attendees, rooms, audio, video, lighting, and budget.",
    effectiveAt: new Date(now - 60_000),
  });
});

after(async () => {
  await closePostgres();
});

test("real approved knowledge retrieval enforces purpose, source, eligibility, and tenant", async () => {
  const retrieved = await approvedKnowledgeSource.retrieve({
    ...context(tenantA),
    query: "event dates venue attendees room schedule audio video lighting budget",
    limit: 8,
    idempotencyKey: `assistant-knowledge:${crypto.randomUUID()}`,
  });

  assert.equal(retrieved.status.state, "available");
  if (retrieved.status.state !== "available") return;
  assert.equal(retrieved.status.resultCount, 1);
  assert.equal(retrieved.evidence.length, 1);
  assert.equal(retrieved.evidence[0].releaseId, activeOperating.releaseId);
  assert.equal(retrieved.evidence[0].fragmentId, activeOperating.fragmentId);
  assert.equal(retrieved.evidence[0].content, activeOperating.content);
  assert.equal(retrieved.evidence[0].sourceType, "operating_guidance");
  assert.equal(retrieved.evidence[0].trust, "untrusted_retrieved_content");

  const forbiddenIds = new Set([
    wrongSource.releaseId,
    expiredOperating.releaseId,
    wrongClassification.releaseId,
    otherTenantOperating.releaseId,
  ]);
  assert.ok(
    retrieved.evidence.every(
      (evidence) => !evidence.releaseId || !forbiddenIds.has(evidence.releaseId),
    ),
  );

  const audit = await postgresPool().query<{
    policy_id: string;
    fixture: string;
    result_count: number;
  }>(
    `SELECT policy_id,fixture,result_count
     FROM rfpilot.knowledge_retrieval_queries
     WHERE organization_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantA.organizationId],
  );
  assert.equal(audit.rows[0]?.policy_id, assistantPolicyId);
  assert.equal(audit.rows[0]?.fixture, "free_text");
  assert.equal(Number(audit.rows[0]?.result_count), 1);
});

test("real operating guidance reaches the deterministic prompt and durable citation", async () => {
  const created = await platformAssistantApplication.createThread(
    context(tenantA),
    { title: "Approved event guidance" },
    `assistant-thread:${crypto.randomUUID()}`,
  );
  const generated = await platformAssistantApplication.generateGuidance(
    context(tenantA),
    {
      threadId: created.thread.id,
      body: {
        content: "What information should I gather for an event checklist?",
      },
      idempotencyKey: `assistant-message:${crypto.randomUUID()}`,
    },
  );

  assert.equal(generated.knowledge.state, "available");
  assert.equal(generated.assistantMessage.status, "complete");
  assert.equal(
    generated.assistantMessage.model,
    "platform-assistant-deterministic-v1",
  );
  assert.deepEqual(
    generated.assistantMessage.citations.map((citation) => ({
      sourceId: citation.sourceId,
      releaseId: citation.releaseId,
      fragmentId: citation.fragmentId,
    })),
    [
      {
        sourceId: `knowledge:${activeOperating.releaseId}:${activeOperating.fragmentId}`,
        releaseId: activeOperating.releaseId,
        fragmentId: activeOperating.fragmentId,
      },
    ],
  );

  const detail = await platformAssistantApplication.getThread(context(tenantA), {
    threadId: created.thread.id,
  });
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].citations[0]?.releaseId, activeOperating.releaseId);
});
