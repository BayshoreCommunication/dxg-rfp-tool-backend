import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { DocumentIngestionError, type DocumentSource } from "./domain";
import type { DocumentRepository } from "./ports";

type Row = {
  id: string; proposal_mongo_id: string | null; status: DocumentSource["status"];
  confidentiality: DocumentSource["confidentiality"];
  original_filename: string; declared_mime_type: string; expected_size_bytes: string;
  actual_size_bytes: string | null; sha256: string | null; duplicate_source_id: string | null;
  retention_until: Date | null; legal_hold: boolean; created_at: Date; updated_at: Date; object_key: string; origin: "upload"|"notes"|"conversation";
};
const select = `SELECT s.id, p.external_mongo_id proposal_mongo_id, s.status,s.confidentiality, o.original_filename,
 o.declared_mime_type, o.expected_size_bytes, o.actual_size_bytes, o.sha256,
 (SELECT o2.source_id::text FROM rfpilot.document_objects o2 WHERE o2.organization_id=s.organization_id AND o2.sha256=o.sha256 AND o2.source_id<>s.id ORDER BY o2.created_at LIMIT 1) duplicate_source_id,
 s.retention_until, s.legal_hold, s.created_at, s.updated_at, o.object_key, s.origin
 FROM rfpilot.document_sources s JOIN rfpilot.document_objects o ON o.source_id=s.id
 LEFT JOIN rfpilot.proposal_references p ON p.id=s.proposal_reference_id`;
const map = (row: Row): DocumentSource & { objectKey: string } => ({
  id: row.id, proposalMongoId: row.proposal_mongo_id, status: row.status,
  confidentiality:row.confidentiality, origin: row.origin,
  originalFilename: row.original_filename, mimeType: row.declared_mime_type,
  expectedSizeBytes: Number(row.expected_size_bytes), actualSizeBytes: row.actual_size_bytes === null ? null : Number(row.actual_size_bytes),
  sha256: row.sha256?.trim() ?? null, duplicateSourceId: row.duplicate_source_id,
  retentionUntil: row.retention_until?.toISOString() ?? null, legalHold: row.legal_hold,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), objectKey: row.object_key,
});

const tenant = async (client: PoolClient, organizationMongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id', $1, true)", [organizationMongoId]);
  const organization = await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'", [organizationMongoId]);
  if (!organization.rows[0]) throw new DocumentIngestionError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await client.query("SELECT set_config('app.organization_id', $1, true)", [organization.rows[0].id]);
  return organization.rows[0].id;
};
const getRow = async (client: PoolClient, sourceId: string, lock = false) => {
  const result = await client.query<Row>(`${select} WHERE s.id=$1 ${lock ? "FOR UPDATE OF s" : ""}`, [sourceId]);
  if (!result.rows[0]) throw new DocumentIngestionError("SOURCE_NOT_FOUND", "Document source was not found.", 404);
  return result.rows[0];
};
const audit = (client: PoolClient, values: { organizationId: string; actor?: string; action: string; sourceId: string; decision?: string; correlationId: string; metadata?: object }) =>
  client.query(`INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata)
    VALUES($1,$2,$3,$4,'document_source',$5,$6,$7,$8::jsonb)`, [uuidv7(), values.organizationId, values.actor ?? null, values.action, values.sourceId, values.decision ?? "allowed", values.correlationId, JSON.stringify(values.metadata ?? {})]);

export const postgresDocumentRepository: DocumentRepository = {
  create(input) { return withPostgresTransaction(async (client) => {
    const organizationId = await tenant(client, input.organizationMongoId);
    const existing = await client.query<{ aggregate_id: string }>("SELECT aggregate_id FROM rfpilot.outbox_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, `document.upload:${input.idempotencyKey}`]);
    if (existing.rows[0]) { const row=await getRow(client,existing.rows[0].aggregate_id); return { source: map(row), objectKey: row.object_key, created: false }; }
    const proposal = await client.query<{ id: string }>("SELECT id FROM rfpilot.proposal_references WHERE organization_id=$1 AND external_mongo_id=$2", [organizationId, input.proposalMongoId]);
    if (!proposal.rows[0]) throw new DocumentIngestionError("PROPOSAL_NOT_FOUND", "Proposal reference is unavailable.", 404);
    const sourceId = input.objectKey.split("/")[2];
    const objectId = uuidv7();
    await client.query(`INSERT INTO rfpilot.document_sources(id,organization_id,proposal_reference_id,uploader_external_user_id,retention_until,confidentiality,origin,segment_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [sourceId, organizationId, proposal.rows[0].id, input.userMongoId, input.retentionUntil,input.confidentiality,input.origin??"upload",input.segmentMessageId??null]);
    await client.query(`INSERT INTO rfpilot.document_objects(id,organization_id,source_id,object_key,original_filename,safe_filename,declared_mime_type,expected_size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [objectId, organizationId, sourceId, input.objectKey, input.originalFilename.slice(0,255), input.safeFilename, input.mimeType, input.expectedSizeBytes]);
    await client.query(`INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload)
      VALUES($1,$2,'document_source',$3,'document.upload_session_created',$4,$5::jsonb)`, [uuidv7(), organizationId, sourceId, `document.upload:${input.idempotencyKey}`, JSON.stringify({ sourceId, proposalMongoId: input.proposalMongoId, correlationId: input.correlationId })]);
    await audit(client, { organizationId, actor: input.userMongoId, action: "document.upload_session.create", sourceId, correlationId: input.correlationId });
    return { source: map(await getRow(client, sourceId)), objectKey: input.objectKey, created: true };
  }); },
  get(organizationMongoId, sourceId) { return withPostgresTransaction(async (client) => { await tenant(client, organizationMongoId); return map(await getRow(client, sourceId)); }); },
  complete(input) { return withPostgresTransaction(async (client) => {
    const organizationId = await tenant(client, input.organizationMongoId); const current = await getRow(client, input.sourceId, true);
    if (current.status !== "pending_upload") return map(current);
    await client.query(`UPDATE rfpilot.document_objects SET actual_size_bytes=$2,detected_mime_type=$3,sha256=$4,storage_version=$5,uploaded_at=now(),verified_at=now(),updated_at=now() WHERE source_id=$1`, [input.sourceId,input.actualSizeBytes,input.detectedMimeType,input.sha256,input.storageVersion??null]);
    await client.query("UPDATE rfpilot.document_sources SET status='uploaded',updated_at=now() WHERE id=$1", [input.sourceId]);
    await audit(client,{organizationId,actor:input.actorUserMongoId,action:"document.upload.complete",sourceId:input.sourceId,correlationId:input.correlationId,metadata:{sha256:input.sha256}});
    return map(await getRow(client,input.sourceId));
  }); },
  beginScan(organizationMongoId, sourceId) { return withPostgresTransaction(async (client) => {
    await tenant(client,organizationMongoId); const current=await getRow(client,sourceId,true);
    if (["ready","blocked"].includes(current.status)) return {source:map(current),objectKey:current.object_key};
    if (!["uploaded","scan_failed"].includes(current.status)) throw new DocumentIngestionError("INVALID_SOURCE_STATE","Document is not ready to scan.",409);
    await client.query("UPDATE rfpilot.document_sources SET status='scanning',updated_at=now() WHERE id=$1",[sourceId]);
    return {source:map(await getRow(client,sourceId)),objectKey:current.object_key};
  }); },
  finishScan(input) { return withPostgresTransaction(async(client)=>{
    const organizationId=await tenant(client,input.organizationMongoId); const current=await getRow(client,input.sourceId,true);
    if (current.status!=="scanning") return map(current);
    const object=await client.query<{id:string}>("SELECT id FROM rfpilot.document_objects WHERE source_id=$1",[input.sourceId]);
    await client.query(`INSERT INTO rfpilot.document_scan_results(id,organization_id,object_id,scanner,scanner_version,signature_version,status,diagnostic_code,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,[uuidv7(),organizationId,object.rows[0].id,input.scanner,input.scannerVersion??null,input.signatureVersion??null,input.status,input.diagnosticCode??null,input.startedAt]);
    const next=input.status==="clean"?"ready":input.status==="infected"?"blocked":"scan_failed";
    await client.query("UPDATE rfpilot.document_sources SET status=$2,updated_at=now() WHERE id=$1",[input.sourceId,next]);
    await audit(client,{organizationId,actor:input.actorUserMongoId,action:"document.scan.complete",sourceId:input.sourceId,decision:input.status==="clean"?"allowed":"denied",correlationId:input.correlationId,metadata:{status:input.status,diagnosticCode:input.diagnosticCode}});
    return map(await getRow(client,input.sourceId));
  }); },
  list(organizationMongoId,proposalMongoId,limit) { return withPostgresTransaction(async(client)=>{
    const organizationId=await tenant(client,organizationMongoId); const result=await client.query<Row>(`${select} WHERE s.organization_id=$1 AND p.external_mongo_id=$2 ORDER BY s.created_at DESC LIMIT $3`,[organizationId,proposalMongoId,limit]); return result.rows.map(map);
  }); },
  requestDeletion(input) { return withPostgresTransaction(async(client)=>{
    const organizationId=await tenant(client,input.organizationMongoId); const current=await getRow(client,input.sourceId,true);
    if (current.status==="deleted") return {source:map(current),objectKey:current.object_key};
    if (current.legal_hold || (current.retention_until && current.retention_until>input.now)) throw new DocumentIngestionError("RETENTION_BLOCKED","Document cannot be deleted while retention or legal hold applies.",409);
    if (current.status!=="deletion_pending") await client.query("UPDATE rfpilot.document_sources SET status='deletion_pending',updated_at=now() WHERE id=$1",[input.sourceId]);
    await audit(client,{organizationId,actor:input.actorUserMongoId,action:"document.deletion.request",sourceId:input.sourceId,correlationId:input.correlationId});
    return {source:map(await getRow(client,input.sourceId)),objectKey:current.object_key};
  }); },
  markDeleted(input) { return withPostgresTransaction(async(client)=>{
    const organizationId=await tenant(client,input.organizationMongoId); const current=await getRow(client,input.sourceId,true); if(current.status==="deleted") return map(current);
    await client.query("UPDATE rfpilot.document_sources SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1",[input.sourceId]);
    await audit(client,{organizationId,actor:input.actorUserMongoId,action:"document.deletion.complete",sourceId:input.sourceId,correlationId:input.correlationId}); return map(await getRow(client,input.sourceId));
  }); },
};
