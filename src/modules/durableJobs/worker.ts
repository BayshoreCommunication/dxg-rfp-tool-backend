import crypto from "node:crypto";
import {Worker,type Job} from "bullmq";
import type {JobRepository} from "./jobRepository";
import type {QueueMessage} from "./domain";
import {redisConnection} from "./redis";
import {SOURCE_SECURITY_QUEUE} from "./queue";
import {handleSourceSecurity} from "./sourceSecurityHandler";
export const createSourceSecurityWorker=(repository:JobRepository)=>{
 const workerId=`source-security-${crypto.randomUUID()}`;const leaseSeconds=Number(process.env.JOB_LEASE_SECONDS||90);const maxAttempts=Number(process.env.JOB_MAX_ATTEMPTS||5);
 return new Worker<QueueMessage>(SOURCE_SECURITY_QUEUE,async(job:Job<QueueMessage>)=>{const attempt=job.attemptsMade+1;const claimed=await repository.claim({message:job.data,workerId,attempt,leaseSeconds});if(claimed.cancelled)return{cancelled:true};const alive=await repository.heartbeat({message:job.data,workerId,leaseSeconds,progress:10,stage:"security_scan"});if(!alive)return{cancelled:true};try{const result=await handleSourceSecurity(job.data);await repository.complete({message:job.data,workerId,attempt,resultReference:result.resultReference});return result;}catch(error){const retryable=Boolean((error as {retryable?:boolean}).retryable);const code=String((error as {code?:string}).code||"JOB_HANDLER_FAILED");await repository.fail({message:job.data,workerId,attempt,diagnosticCode:code,retryable,maxAttempts});if(retryable)throw error;return{failed:true,code};}},{connection:redisConnection(),concurrency:Number(process.env.SOURCE_SECURITY_CONCURRENCY||2),lockDuration:leaseSeconds*1000,stalledInterval:15000,maxStalledCount:2});
};
