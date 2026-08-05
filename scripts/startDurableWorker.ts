import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import {closePostgres} from "../config/postgres";
import {durableJobRepository} from "../src/modules/durableJobs/composition";
import {closeQueue} from "../src/modules/durableJobs/queue";
import {durableJobsEnabled} from "../src/modules/durableJobs/redis";
import {createSourceSecurityWorker} from "../src/modules/durableJobs/worker";

const main=async()=>{
 if(!durableJobsEnabled())throw new Error("DURABLE_JOBS_ENABLED must be true to start a worker");
 if(process.env.CANDIDATE_APPLICATION_ENABLED==="true"||process.env.PROPOSAL_DRAFT_ENABLED==="true"||process.env.CONVERSATIONS_ENABLED==="true")await connectDB();
 const worker=createSourceSecurityWorker(durableJobRepository);
 const shutdown=async()=>{await worker.close();await closeQueue();await closePostgres();if(mongoose.connection.readyState!==0)await mongoose.disconnect();process.exit(0);};
 process.on("SIGTERM",()=>{void shutdown();});process.on("SIGINT",()=>{void shutdown();});
 console.log("Durable worker started");
};
void main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
