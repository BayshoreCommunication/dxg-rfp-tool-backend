import type {ConnectionOptions} from "bullmq";
import {DurableJobError} from "./domain";
export const redisConnection=():ConnectionOptions=>{const raw=process.env.REDIS_URL;if(!raw)throw new DurableJobError("QUEUE_UNAVAILABLE","Redis is not configured.",503);const url=new URL(raw);if(!["redis:","rediss:"].includes(url.protocol))throw new Error("REDIS_URL must use redis:// or rediss://");return{host:url.hostname,port:Number(url.port||6379),username:url.username||undefined,password:url.password||undefined,tls:url.protocol==="rediss:"?{}:undefined,maxRetriesPerRequest:null};};
export const durableJobsEnabled=()=>process.env.DURABLE_JOBS_ENABLED==="true";

