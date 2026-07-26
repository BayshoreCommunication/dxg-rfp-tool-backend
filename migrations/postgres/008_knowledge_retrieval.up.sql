CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rfpilot.embedding_model_releases (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version text NOT NULL,
  provider text NOT NULL CHECK(provider='mock'),
  model text NOT NULL CHECK(model='deterministic-v1'),
  dimension integer NOT NULL CHECK(dimension=16),
  environment text NOT NULL CHECK(environment='test'),
  allowed_classifications text[] NOT NULL CHECK(allowed_classifications <@ ARRAY['synthetic']::text[]),
  implementation_checksum char(64) NOT NULL CHECK(implementation_checksum ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT false,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stable_key,version)
);

CREATE TABLE rfpilot.knowledge_retrieval_policies (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version text NOT NULL,
  environment text NOT NULL CHECK(environment='test'),
  purpose text NOT NULL CHECK(purpose='retrieval_test'),
  classification text NOT NULL CHECK(classification='synthetic'),
  lexical_enabled boolean NOT NULL DEFAULT true,
  vector_enabled boolean NOT NULL DEFAULT true,
  lexical_weight numeric(5,4) NOT NULL CHECK(lexical_weight BETWEEN 0 AND 1),
  vector_weight numeric(5,4) NOT NULL CHECK(vector_weight BETWEEN 0 AND 1),
  minimum_score numeric(5,4) NOT NULL CHECK(minimum_score BETWEEN 0 AND 1),
  default_limit smallint NOT NULL CHECK(default_limit BETWEEN 1 AND 20),
  maximum_limit smallint NOT NULL CHECK(maximum_limit BETWEEN default_limit AND 20),
  embedding_model_release_id uuid NOT NULL REFERENCES rfpilot.embedding_model_releases(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT false,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stable_key,version),
  CHECK(lexical_enabled OR vector_enabled),
  CHECK(lexical_weight+vector_weight=1)
);

CREATE TABLE rfpilot.knowledge_index_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES rfpilot.knowledge_releases(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL REFERENCES rfpilot.knowledge_retrieval_policies(id) ON DELETE RESTRICT,
  embedding_model_release_id uuid NOT NULL REFERENCES rfpilot.embedding_model_releases(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL UNIQUE REFERENCES rfpilot.ai_jobs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN('queued','running','succeeded','failed')),
  fragment_count integer NOT NULL DEFAULT 0 CHECK(fragment_count>=0),
  indexed_fragment_count integer NOT NULL DEFAULT 0 CHECK(indexed_fragment_count>=0),
  safe_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_id,policy_id)
);

CREATE TABLE rfpilot.knowledge_fragment_embeddings (
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES rfpilot.knowledge_releases(id) ON DELETE RESTRICT,
  fragment_id uuid NOT NULL REFERENCES rfpilot.knowledge_source_fragments(id) ON DELETE RESTRICT,
  embedding_model_release_id uuid NOT NULL REFERENCES rfpilot.embedding_model_releases(id) ON DELETE RESTRICT,
  fragment_checksum char(64) NOT NULL CHECK(fragment_checksum ~ '^[0-9a-f]{64}$'),
  embedding vector(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(release_id,fragment_id,embedding_model_release_id)
);

CREATE TABLE rfpilot.knowledge_retrieval_queries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id ~ '^[0-9a-f]{24}$'),
  policy_id uuid NOT NULL REFERENCES rfpilot.knowledge_retrieval_policies(id) ON DELETE RESTRICT,
  fixture text NOT NULL CHECK(fixture IN('breakout-room-schedule','general-session-production','no-match')),
  filter_fingerprint char(64) NOT NULL CHECK(filter_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  result_count smallint NOT NULL CHECK(result_count BETWEEN 0 AND 20),
  latency_ms integer NOT NULL CHECK(latency_ms>=0),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,idempotency_key)
);

CREATE TABLE rfpilot.knowledge_retrieval_results (
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  query_id uuid NOT NULL REFERENCES rfpilot.knowledge_retrieval_queries(id) ON DELETE RESTRICT,
  rank smallint NOT NULL CHECK(rank BETWEEN 1 AND 20),
  release_id uuid NOT NULL REFERENCES rfpilot.knowledge_releases(id) ON DELETE RESTRICT,
  fragment_id uuid NOT NULL REFERENCES rfpilot.knowledge_source_fragments(id) ON DELETE RESTRICT,
  fragment_checksum char(64) NOT NULL CHECK(fragment_checksum ~ '^[0-9a-f]{64}$'),
  lexical_score numeric(8,7) NOT NULL CHECK(lexical_score BETWEEN 0 AND 1),
  vector_score numeric(8,7) NOT NULL CHECK(vector_score BETWEEN 0 AND 1),
  fused_score numeric(8,7) NOT NULL CHECK(fused_score BETWEEN 0 AND 1),
  eligible_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(query_id,rank),
  UNIQUE(query_id,fragment_id)
);

CREATE INDEX knowledge_index_runs_list_idx ON rfpilot.knowledge_index_runs(organization_id,status,created_at DESC);
CREATE INDEX knowledge_embeddings_release_idx ON rfpilot.knowledge_fragment_embeddings(organization_id,release_id);
CREATE INDEX knowledge_embeddings_vector_idx ON rfpilot.knowledge_fragment_embeddings USING hnsw(embedding vector_cosine_ops);
CREATE INDEX knowledge_fragments_fts_idx ON rfpilot.knowledge_source_fragments USING gin(to_tsvector('english',content));
CREATE INDEX knowledge_retrieval_queries_list_idx ON rfpilot.knowledge_retrieval_queries(organization_id,created_at DESC);

ALTER TABLE rfpilot.knowledge_index_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_index_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_fragment_embeddings ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_fragment_embeddings FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_retrieval_queries ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_retrieval_queries FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_retrieval_results ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_retrieval_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_knowledge_index_runs ON rfpilot.knowledge_index_runs USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_embeddings ON rfpilot.knowledge_fragment_embeddings USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_retrieval_queries ON rfpilot.knowledge_retrieval_queries USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_retrieval_results ON rfpilot.knowledge_retrieval_results USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.reject_embedding_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'knowledge embeddings are immutable'; END $$;
CREATE TRIGGER knowledge_embeddings_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.knowledge_fragment_embeddings FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_embedding_mutation();
CREATE FUNCTION rfpilot.reject_retrieval_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retrieval evidence is append-only'; END $$;
CREATE TRIGGER knowledge_retrieval_queries_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.knowledge_retrieval_queries FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_retrieval_evidence_mutation();
CREATE TRIGGER knowledge_retrieval_results_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.knowledge_retrieval_results FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_retrieval_evidence_mutation();

INSERT INTO rfpilot.embedding_model_releases(id,stable_key,version,provider,model,dimension,environment,allowed_classifications,implementation_checksum,active,approved_at,effective_from)
VALUES('40000000-0000-7000-8000-000000000001','mock-knowledge-embedding','1.0.0','mock','deterministic-v1',16,'test',ARRAY['synthetic'],'d78f20e3158a62b46798a013a8628fca7fd941f0bb2ad1a5f570ed6b8ca8d474',true,now(),now());
INSERT INTO rfpilot.knowledge_retrieval_policies(id,stable_key,version,environment,purpose,classification,lexical_enabled,vector_enabled,lexical_weight,vector_weight,minimum_score,default_limit,maximum_limit,embedding_model_release_id,active,approved_at,effective_from)
VALUES('50000000-0000-7000-8000-000000000001','test-synthetic-retrieval','1.0.0','test','retrieval_test','synthetic',true,true,0.5000,0.5000,0.0100,10,20,'40000000-0000-7000-8000-000000000001',true,now(),now());
