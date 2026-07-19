import {documentIngestion} from "../documentIngestion/composition";
import type {QueueMessage} from "./domain";
export const handleSourceSecurity=async(message:QueueMessage)=>{
 const source=await documentIngestion.scan({organizationMongoId:message.organizationMongoId,userMongoId:message.actorUserMongoId,sourceId:message.inputReference,correlationId:message.correlationId});
 if(source.status==="scan_failed")throw Object.assign(new Error("Scanner dependency unavailable"),{code:"SCANNER_UNAVAILABLE",retryable:true});
 if(!["ready","blocked"].includes(source.status))throw Object.assign(new Error("Unexpected source state"),{code:"SOURCE_STATE_INVALID",retryable:false});
 return{resultReference:source.id,status:source.status};
};
