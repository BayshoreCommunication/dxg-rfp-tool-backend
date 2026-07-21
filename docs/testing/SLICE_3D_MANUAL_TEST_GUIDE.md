# Slice 3D Deferred Manual Test Guide

During consolidated final acceptance, upload two explicitly non-confidential clean test sources to one proposal. Give both the same event name but different event formats or room counts. Select both sources in the extraction selector and run OpenAI extraction.

Confirm the run succeeds, every candidate is cited, provider/model/token usage is visible, and a blocking cross-source conflict warning appears for each supported disagreement. Confirm no conflicting value is selected, applied, or published automatically. Reload and verify durable recovery. Repeat the direct endpoint with more than five IDs, a confidential ID, another account's ID, a deleted/not-ready source, and the emergency kill switch; each must fail safely without widening access or silently dropping an ineligible source.
