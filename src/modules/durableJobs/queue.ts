import {Queue} from "bullmq";
import type {QueueMessage} from "./domain";
import {redisConnection} from "./redis";
export const SOURCE_SECURITY_QUEUE="rfpilot-source-security";
let queue:Queue<QueueMessage>|null=null;
export const sourceSecurityQueue=()=>queue??=new Queue<QueueMessage>(SOURCE_SECURITY_QUEUE,{connection:redisConnection(),defaultJobOptions:{attempts:Number(process.env.JOB_MAX_ATTEMPTS||5),backoff:{type:"exponential",delay:Number(process.env.JOB_BACKOFF_BASE_MS||5000),jitter:1},removeOnComplete:{age:86400,count:1000},removeOnFail:{age:7*86400,count:5000}}});
export const closeQueue=async()=>{if(queue)await queue.close();queue=null;};
export const checkQueue=async()=>{if(process.env.DURABLE_JOBS_ENABLED!=="true")return{enabled:false,ready:false};try{await Promise.race([sourceSecurityQueue().waitUntilReady(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("timeout")),2000))]);return{enabled:true,ready:true};}catch{return{enabled:true,ready:false};}};
