import type {ConnectionOptions} from "bullmq";
import {DurableJobError} from "./domain";
// URL userinfo is percent-encoded; WHATWG URL exposes it still encoded, so it
// must be decoded before it is sent as AUTH (an encoded password fails
// against the real credential).
export const redisConnection=():ConnectionOptions=>{const raw=process.env.REDIS_URL;if(!raw)throw new DurableJobError("QUEUE_UNAVAILABLE","Redis is not configured.",503);const url=new URL(raw);if(!["redis:","rediss:"].includes(url.protocol))throw new Error("REDIS_URL must use redis:// or rediss://");return{host:url.hostname,port:Number(url.port||6379),username:url.username?decodeURIComponent(url.username):undefined,password:url.password?decodeURIComponent(url.password):undefined,tls:url.protocol==="rediss:"?{}:undefined,maxRetriesPerRequest:null};};
export const durableJobsEnabled=()=>process.env.DURABLE_JOBS_ENABLED==="true";

