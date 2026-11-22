import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import {closePostgres} from "../config/postgres";
import {durableJobRepository} from "../src/modules/durableJobs/composition";
import {createAiGatewayWorker} from "../src/modules/durableJobs/aiGatewayWorker";
import {durableJobsEnabled} from "../src/modules/durableJobs/redis";
import {startupFailureLine,startWorkerWithMongo} from "../src/modules/durableJobs/workerStartup";

const main=async()=>{
 if(!durableJobsEnabled()||process.env.AI_GATEWAY_ENABLED!=="true")throw new Error("Durable jobs and AI gateway must be enabled");
 // MongoDB first, awaited: every job asks whether its organization is blocked before it runs
 // (organizationBlockDeferral.ts). No worker exists until the connection does (workerStartup.ts).
 const worker=await startWorkerWithMongo({name:"AI gateway worker",connect:connectDB,createWorker:()=>createAiGatewayWorker(durableJobRepository)});
 const stop=async()=>{await worker.close();await closePostgres();if(mongoose.connection.readyState!==0)await mongoose.disconnect();process.exit(0);};
 process.on("SIGINT",()=>{void stop();});process.on("SIGTERM",()=>{void stop();});
 console.log("AI gateway mock worker started");
};
void main().catch(error=>{console.error(startupFailureLine(error));process.exit(1);});
