CREATE INDEX assistant_product_events_filter_idx
  ON rfpilot.assistant_product_events(
    organization_id,
    occurred_at DESC,
    model,
    prompt_version,
    knowledge_version
  );

CREATE INDEX assistant_product_events_finding_idx
  ON rfpilot.assistant_product_events(
    organization_id,
    finding_category,
    occurred_at DESC
  )
  WHERE finding_category IS NOT NULL;
