const test=require("node:test"); const assert=require("node:assert/strict");
require("ts-node/register");
const {createDocumentIngestion}=require("../src/modules/documentIngestion/application");
const {validateUpload,detectMimeType}=require("../src/modules/documentIngestion/domain");

const base={id:"01900000-0000-7000-8000-000000000001",proposalMongoId:"507f1f77bcf86cd799439011",status:"pending_upload",originalFilename:"brief.pdf",mimeType:"application/pdf",expectedSizeBytes:8,actualSizeBytes:null,sha256:null,duplicateSourceId:null,retentionUntil:null,legalHold:false,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()};
const fixture=(scanStatus="clean")=>{
 let source={...base}; let deleted=false;
 const repository={
  async create(){return{source,objectKey:"quarantine/org/id/original.pdf",created:true}}, async get(){return{...source,objectKey:"quarantine/org/id/original.pdf"}},
  async complete(input){source={...source,status:"uploaded",actualSizeBytes:input.actualSizeBytes,sha256:input.sha256};return source},
  async beginScan(){if(source.status==="uploaded"||source.status==="scan_failed")source={...source,status:"scanning"};return{source,objectKey:"quarantine/org/id/original.pdf"}},
  async finishScan(input){source={...source,status:input.status==="clean"?"ready":input.status==="infected"?"blocked":"scan_failed"};return source},
  async list(){return[source]}, async requestDeletion(){source={...source,status:"deletion_pending"};return{source,objectKey:"key"}},async markDeleted(){source={...source,status:"deleted"};return source}
 };
 const storage={async createUpload(){return{uploadUrl:"https://private.invalid/signed",expiresAt:new Date(1).toISOString()}},async read(){const bytes=Buffer.from("%PDF-1.7");return{bytes,sizeBytes:bytes.length}},async delete(){deleted=true}};
 const scanner={async scan(){return{status:scanStatus,scanner:"test"}}};
 return{service:createDocumentIngestion({repository,storage,scanner,maxBytes:1024}),deleted:()=>deleted};
};

test("upload policy allows approved matching formats and rejects mismatches",()=>{
 assert.equal(validateUpload("brief.pdf","application/pdf",8,1024).mimeType,"application/pdf");
 assert.throws(()=>validateUpload("brief.exe","application/pdf",8,1024),error=>error.code==="FILE_TYPE_MISMATCH");
 assert.throws(()=>validateUpload("brief.pdf","application/pdf",2048,1024),error=>error.code==="FILE_SIZE_INVALID");
});
test("content detection rejects extension-only spoofing",()=>{
 assert.equal(detectMimeType(Buffer.from("%PDF-1.7"),"application/pdf"),"application/pdf");
 assert.equal(detectMimeType(Buffer.from("malicious binary\0"),"application/pdf"),null);
});
test("clean file completes integrity verification and becomes ready after scan",async()=>{
 const {service}=fixture(); const completed=await service.complete({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"});
 assert.equal(completed.status,"uploaded"); assert.match(completed.sha256,/^[a-f0-9]{64}$/);
 assert.equal((await service.scan({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"})).status,"ready");
});
test("infected file fails closed in blocked state",async()=>{
 const {service}=fixture("infected"); await service.complete({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"});
 assert.equal((await service.scan({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"})).status,"blocked");
});
test("scanner failure is unavailable and never ready",async()=>{
 const {service}=fixture("unavailable"); await service.complete({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"});
 assert.equal((await service.scan({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"})).status,"scan_failed");
});
test("deletion removes private object before marking metadata deleted",async()=>{
 const f=fixture(); const result=await f.service.remove({organizationMongoId:"org",userMongoId:"user",sourceId:base.id,correlationId:"c"});
 assert.equal(f.deleted(),true); assert.equal(result.status,"deleted");
});
