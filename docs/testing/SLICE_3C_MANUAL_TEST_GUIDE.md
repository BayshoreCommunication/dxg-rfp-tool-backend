# Slice 3C Manual Test Guide

Use synthetic, non-sensitive test content only. Keep the backend, dashboard and one durable worker running. Set the existing Slice 3B live flags plus `LIVE_AI_PROPOSAL_SOURCE_ENABLED=true`, then apply migration `014_live_proposal_sources` and restart the backend and worker.

1. Open a proposal and upload a TXT or PDF containing an event name, format, objective, and room count. Check **I confirm this source is non-confidential and approved for live AI processing** before uploading.
2. Wait until its security status is `ready`. Refresh the proposal edit page if necessary. The filename should appear under **Approved proposal source**.
3. Select it and click **Extract with OpenAI**. Confirm the durable status reaches `succeeded`.
4. Confirm every displayed candidate reports at least one citation. In **Run evidence**, confirm provider `openai`, model `gpt-5.4-mini`, nonzero input/output tokens, proposal mutation `No`, and automatic publication `No`.
5. Reload the page. Confirm the same durable result returns without creating another run or provider call.
6. Upload the same kind of test file without checking the approval checkbox. After it becomes ready, confirm it is not offered in the live source selector. A direct POST using that source ID must return `SOURCE_NOT_ELIGIBLE` and must not call OpenAI.
7. From another account, confirm the proposal URL and source ID cannot be used to queue or read the run.
8. Set `LIVE_AI_KILL_SWITCH=true`, restart the worker, queue an eligible source extraction, and confirm it fails with `LIVE_AI_KILLED` without a provider call. Restore `false` and restart the worker.
9. Stop the worker, queue a source extraction, then delete or otherwise make the source ineligible before restarting. Confirm the queued run fails safely and produces no candidates.

Do not accept/apply candidates during the read-only extraction checks unless separately testing the existing explicit review/application workflow. Nothing should publish automatically.
