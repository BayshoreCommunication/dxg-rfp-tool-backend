import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import {closePostgres} from "../config/postgres";
import {durableJobRepository} from "../src/modules/durableJobs/composition";
import {closeQueue} from "../src/modules/durableJobs/queue";
import {durableJobsEnabled} from "../src/modules/durableJobs/redis";
import {createSourceSecurityWorker} from "../src/modules/durableJobs/worker";
import {startupFailureLine,startWorkerWithMongo} from "../src/modules/durableJobs/workerStartup";

const main=async()=>{
 if(!durableJobsEnabled())throw new Error("DURABLE_JOBS_ENABLED must be true to start a worker");
 // Always: every job asks MongoDB whether its organization is blocked before it runs
 // (src/modules/durableJobs/organizationBlockDeferral.ts). Until this change the worker connected
 // only when a capability that reads MongoDB was enabled. Awaited before the worker exists; a
 // missing MONGODB_URL or an unreachable MongoDB stops the start (workerStartup.ts).
 const worker=await startWorkerWithMongo({name:"Durable worker",connect:connectDB,createWorker:()=>createSourceSecurityWorker(durableJobRepository)});
 const shutdown=async()=>{await worker.close();await closeQueue();await closePostgres();if(mongoose.connection.readyState!==0)await mongoose.disconnect();process.exit(0);};
 process.on("SIGTERM",()=>{void shutdown();});process.on("SIGINT",()=>{void shutdown();});
 console.log("Durable worker started");
};
void main().catch(error=>{console.error(startupFailureLine(error));process.exit(1);});
