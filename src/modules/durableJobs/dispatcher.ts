import crypto from "node:crypto";
import type {JobRepository} from "./jobRepository";
import {sourceSecurityQueue} from "./queue";
export const createDispatcher=(repository:JobRepository,publisher?:{publish(message:Parameters<ReturnType<typeof sourceSecurityQueue>["add"]>[1]):Promise<unknown>})=>{
 const id=`dispatcher-${crypto.randomUUID()}`;
 const publish=publisher?.publish??(async(message:Parameters<ReturnType<typeof sourceSecurityQueue>["add"]>[1])=>{const queue=sourceSecurityQueue();const existing=await queue.getJob(message.jobId);if(existing){const state=await existing.getState();if(state==="failed")await existing.retry();else if(state==="unknown"||state==="completed"){await existing.remove();return queue.add(message.jobType,message,{jobId:message.jobId,priority:0});}return existing;}return queue.add(message.jobType,message,{jobId:message.jobId,priority:0});});
 return{
  async dispatch(limit=25){const events=await repository.claimOutbox(limit,id);let published=0;for(const event of events){try{await publish(event.message);await repository.markOutboxPublished(event.eventId);published++;}catch{await repository.markOutboxFailed(event.eventId,"REDIS_PUBLISH_FAILED");}}return{claimed:events.length,published};},
  async reconcile(limit=100){const messages=await repository.reconcile(limit);for(const message of messages)await publish(message);return messages.length;},
 };
};
