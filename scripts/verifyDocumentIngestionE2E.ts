import "../config/env";
import crypto from "node:crypto";
import { postgresPool } from "../config/postgres";
import { createDocumentIngestion } from "../src/modules/documentIngestion/application";
import { configuredMalwareScanner } from "../src/modules/documentIngestion/clamAvScanner";
import { postgresDocumentRepository } from "../src/modules/documentIngestion/postgresDocumentRepository";
import { s3PrivateDocumentStorage } from "../src/modules/documentIngestion/s3PrivateDocumentStorage";

const requireTestTarget = () => {
  if (process.env.NODE_ENV !== "test" || process.env.DOCUMENT_STORAGE_BUCKET !== "rfpilot-private-test") {
    throw new Error("Refusing to run outside the isolated rfpilot-private-test environment");
  }
};

const context = async () => {
  const result = await postgresPool().query<{ organization: string; user_id: string; proposal: string }>(`
    SELECT o.external_mongo_id organization, u.external_mongo_id user_id, p.external_mongo_id proposal
    FROM rfpilot.proposal_references p
    JOIN rfpilot.organizations o ON o.id=p.organization_id
    JOIN rfpilot.users u ON u.id=p.owner_user_id
    ORDER BY p.created_at LIMIT 1
  `);
  if (!result.rows[0]) throw new Error("Slice 1C proposal references are required");
  return result.rows[0];
};

const main = async () => {
  requireTestTarget();
  const ids=await context();
  const service=createDocumentIngestion({repository:postgresDocumentRepository,storage:s3PrivateDocumentStorage,scanner:configuredMalwareScanner(),maxBytes:50*1024*1024});
  const results:Record<string,unknown>={};
  const upload=async(label:string,bytes:Buffer,mimeType="application/pdf",extension="pdf")=>{
    const created=await service.createUpload({organizationMongoId:ids.organization,userMongoId:ids.user_id,proposalMongoId:ids.proposal,filename:`${label}.${extension}`,mimeType,sizeBytes:bytes.length,idempotencyKey:`slice1d-e2e-${label}-${crypto.randomUUID()}`,correlationId:crypto.randomUUID()});
    const response=await fetch(created.uploadUrl,{method:"PUT",headers:{"content-type":mimeType},body:new Uint8Array(bytes)});
    if(!response.ok) throw new Error(`${label} signed upload failed: ${response.status}`);
    const unsigned=created.uploadUrl.split("?")[0];
    results[`${label}UnsignedStatus`]=(await fetch(unsigned)).status;
    const completed=await service.complete({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:created.source.id,correlationId:crypto.randomUUID()});
    return{sourceId:created.source.id,completed};
  };

  const clean=await upload("clean",Buffer.from("%PDF-1.7\nRFPilot clean fixture\n"));
  const cleanResult=await service.scan({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:clean.sourceId,correlationId:crypto.randomUUID()});
  results.cleanStatus=cleanResult.status;
  await service.remove({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:clean.sourceId,correlationId:crypto.randomUUID()});
  results.cleanDeletedStatus=(await service.get(ids.organization,clean.sourceId)).status;

  const eicar=Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  const infected=await upload("eicar",eicar,"text/plain","txt");
  const infectedResult=await service.scan({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:infected.sourceId,correlationId:crypto.randomUUID()});
  results.infectedStatus=infectedResult.status;
  await service.remove({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:infected.sourceId,correlationId:crypto.randomUUID()});

  const retry=await upload("retry",Buffer.from("%PDF-1.7\nRFPilot retry fixture\n"));
  process.env.CLAMAV_PORT="59999";
  results.outageStatus=(await service.scan({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:retry.sourceId,correlationId:crypto.randomUUID()})).status;
  process.env.CLAMAV_PORT="53310";
  results.retryStatus=(await service.scan({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:retry.sourceId,correlationId:crypto.randomUUID()})).status;
  await service.remove({organizationMongoId:ids.organization,userMongoId:ids.user_id,sourceId:retry.sourceId,correlationId:crypto.randomUUID()});

  if(results.cleanStatus!=="ready"||results.infectedStatus!=="blocked"||results.outageStatus!=="scan_failed"||results.retryStatus!=="ready"||results.cleanDeletedStatus!=="deleted"||results.cleanUnsignedStatus!==403) throw new Error(`E2E assertions failed: ${JSON.stringify(results)}`);
  console.log(JSON.stringify(results,null,2));
};

void main().finally(async()=>{await postgresPool().end();}).catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
