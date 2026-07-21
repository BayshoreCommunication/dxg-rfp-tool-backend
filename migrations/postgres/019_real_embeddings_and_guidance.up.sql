-- 1. Embedding release registry: admit governed real providers alongside the mock.
ALTER TABLE rfpilot.embedding_model_releases
 DROP CONSTRAINT IF EXISTS embedding_model_releases_provider_check,
 DROP CONSTRAINT IF EXISTS embedding_model_releases_model_check,
 DROP CONSTRAINT IF EXISTS embedding_model_releases_dimension_check,
 DROP CONSTRAINT IF EXISTS embedding_model_releases_environment_check,
 DROP CONSTRAINT IF EXISTS embedding_model_releases_allowed_classifications_check;
ALTER TABLE rfpilot.embedding_model_releases
 ADD CONSTRAINT embedding_model_releases_provider_check CHECK(provider IN('mock','openai')),
 ADD CONSTRAINT embedding_model_releases_model_check CHECK(char_length(model) BETWEEN 1 AND 100),
 ADD CONSTRAINT embedding_model_releases_dimension_check CHECK(dimension IN(16,1536)),
 ADD CONSTRAINT embedding_model_releases_environment_check CHECK(environment IN('test','staging','production')),
 ADD CONSTRAINT embedding_model_releases_allowed_classifications_check CHECK(allowed_classifications <@ ARRAY['synthetic','internal','customer_confidential','vendor_confidential']::text[]);

-- 2. Retrieval policies: permit general knowledge retrieval, all classifications, any environment.
ALTER TABLE rfpilot.knowledge_retrieval_policies
 DROP CONSTRAINT IF EXISTS knowledge_retrieval_policies_environment_check,
 DROP CONSTRAINT IF EXISTS knowledge_retrieval_policies_purpose_check,
 DROP CONSTRAINT IF EXISTS knowledge_retrieval_policies_classification_check;
ALTER TABLE rfpilot.knowledge_retrieval_policies
 ADD CONSTRAINT knowledge_retrieval_policies_environment_check CHECK(environment IN('test','staging','production')),
 ADD CONSTRAINT knowledge_retrieval_policies_purpose_check CHECK(purpose IN('retrieval_test','knowledge_retrieval')),
 ADD CONSTRAINT knowledge_retrieval_policies_classification_check CHECK(classification IN('synthetic','internal','customer_confidential','vendor_confidential'));

-- 3. Free-text retrieval queries stay content-free in the log: only the label
--    'free_text' plus the request fingerprint are recorded.
ALTER TABLE rfpilot.knowledge_retrieval_queries DROP CONSTRAINT IF EXISTS knowledge_retrieval_queries_fixture_check;
ALTER TABLE rfpilot.knowledge_retrieval_queries ADD CONSTRAINT knowledge_retrieval_queries_fixture_check CHECK(fixture IN('breakout-room-schedule','general-session-production','no-match','free_text'));

-- 4. Embedding storage moves to the real provider dimension. Existing rows are
--    synthetic hash vectors and are re-indexable from immutable fragments.
DROP INDEX IF EXISTS rfpilot.knowledge_embeddings_vector_idx;
DROP TRIGGER IF EXISTS knowledge_embeddings_no_mutation ON rfpilot.knowledge_fragment_embeddings;
DELETE FROM rfpilot.knowledge_fragment_embeddings;
ALTER TABLE rfpilot.knowledge_fragment_embeddings ALTER COLUMN embedding TYPE vector(1536);
CREATE INDEX knowledge_embeddings_vector_idx ON rfpilot.knowledge_fragment_embeddings USING hnsw(embedding vector_cosine_ops);
CREATE TRIGGER knowledge_embeddings_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.knowledge_fragment_embeddings FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_embedding_mutation();
UPDATE rfpilot.embedding_model_releases SET dimension=1536 WHERE stable_key='mock-knowledge-embedding';

-- 5. Governed OpenAI embedding release + retrieval policy (test environment;
--    staging/production rows are provisioned operationally with the same shape).
INSERT INTO rfpilot.embedding_model_releases(id,stable_key,version,provider,model,dimension,environment,allowed_classifications,implementation_checksum,active,approved_at,effective_from)
VALUES('40000000-0000-7000-8000-000000000002','openai-knowledge-embedding','1.0.0','openai','text-embedding-3-small',1536,'test',ARRAY['synthetic','internal'],'0000000000000000000000000000000000000000000000000000000000000002',true,now(),now())
ON CONFLICT DO NOTHING;
INSERT INTO rfpilot.knowledge_retrieval_policies(id,stable_key,version,environment,purpose,classification,lexical_enabled,vector_enabled,lexical_weight,vector_weight,minimum_score,default_limit,maximum_limit,embedding_model_release_id,active,approved_at,effective_from)
VALUES('50000000-0000-7000-8000-000000000002','openai-knowledge-retrieval','1.0.0','test','knowledge_retrieval','internal',true,true,0.4000,0.6000,0.0100,10,20,'40000000-0000-7000-8000-000000000002',true,now(),now())
ON CONFLICT DO NOTHING;

-- 6. Draft citations may reference approved knowledge fragments.
ALTER TABLE rfpilot.proposal_draft_citations DROP CONSTRAINT IF EXISTS proposal_draft_citations_canonical_path_check;
ALTER TABLE rfpilot.proposal_draft_citations ADD CONSTRAINT proposal_draft_citations_canonical_path_check CHECK(canonical_path~'^/content/' OR canonical_path~'^/knowledge/');

-- 7. Deterministic guidance reports (completeness / risk / schedule), rule-based.
CREATE TABLE rfpilot.guidance_reports(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id~'^[0-9a-f]{24}$'),
 proposal_version integer NOT NULL CHECK(proposal_version>=1),
 engine_version text NOT NULL DEFAULT 'guidance-rules.v1',
 overall_completeness numeric(5,4) NOT NULL CHECK(overall_completeness BETWEEN 0 AND 1),
 completeness jsonb NOT NULL DEFAULT '[]',
 findings jsonb NOT NULL DEFAULT '[]',
 finding_count integer NOT NULL DEFAULT 0 CHECK(finding_count>=0),
 blocking_count integer NOT NULL DEFAULT 0 CHECK(blocking_count>=0),
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rfpilot.guidance_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.guidance_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guidance_reports ON rfpilot.guidance_reports USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE INDEX guidance_reports_latest_idx ON rfpilot.guidance_reports(proposal_reference_id,created_at DESC);
