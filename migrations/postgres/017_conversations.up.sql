CREATE TABLE rfpilot.conversations(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 owner_external_user_id varchar(24) NOT NULL CHECK(owner_external_user_id~'^[0-9a-f]{24}$'),
 title text NOT NULL DEFAULT 'Proposal workspace' CHECK(char_length(title)<=200),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),
 message_count integer NOT NULL DEFAULT 0 CHECK(message_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(proposal_reference_id)
);

CREATE TABLE rfpilot.conversation_messages(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 conversation_id uuid NOT NULL REFERENCES rfpilot.conversations(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal>=1),
 role text NOT NULL CHECK(role IN('user','assistant','system_event')),
 kind text NOT NULL CHECK(kind IN('note','instruction','action_request','run_result','status','question_answer')),
 content text NOT NULL DEFAULT '' CHECK(char_length(content)<=16000),
 intent text CHECK(intent IN('chat','extract_requirements','generate_draft','add_notes')),
 run_type text CHECK(run_type IN('proposal_context','proposal_draft')),
 run_id uuid,
 job_id uuid,
 status text NOT NULL DEFAULT 'complete' CHECK(status IN('complete','pending','failed')),
 idempotency_key text CHECK(char_length(idempotency_key)<=200),
 actor_external_user_id varchar(24) CHECK(actor_external_user_id IS NULL OR actor_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,ordinal),
 CHECK(run_id IS NULL OR run_type IS NOT NULL)
);
CREATE UNIQUE INDEX conversation_messages_idempotency_idx ON rfpilot.conversation_messages(conversation_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX conversation_messages_list_idx ON rfpilot.conversation_messages(conversation_id,ordinal);
CREATE INDEX conversation_messages_run_idx ON rfpilot.conversation_messages(run_type,run_id) WHERE run_id IS NOT NULL;

CREATE TABLE rfpilot.conversation_message_attachments(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 message_id uuid NOT NULL REFERENCES rfpilot.conversation_messages(id) ON DELETE RESTRICT,
 source_id uuid NOT NULL REFERENCES rfpilot.document_sources(id) ON DELETE RESTRICT,
 role text NOT NULL DEFAULT 'primary' CHECK(role IN('primary','context')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(message_id,source_id)
);
CREATE INDEX conversation_message_attachments_source_idx ON rfpilot.conversation_message_attachments(source_id);

CREATE TABLE rfpilot.clarification_questions(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 conversation_id uuid REFERENCES rfpilot.conversations(id) ON DELETE RESTRICT,
 context_run_id uuid NOT NULL REFERENCES rfpilot.proposal_context_runs(id) ON DELETE RESTRICT,
 issue_code text NOT NULL CHECK(char_length(issue_code)<=100),
 severity text NOT NULL CHECK(severity IN('info','question','blocking')),
 canonical_paths jsonb NOT NULL DEFAULT '[]',
 prompt text NOT NULL CHECK(char_length(prompt)<=1000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','answered','dismissed','superseded')),
 answered_message_id uuid REFERENCES rfpilot.conversation_messages(id),
 answered_by_external_user_id varchar(24) CHECK(answered_by_external_user_id IS NULL OR answered_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(proposal_reference_id,context_run_id,issue_code)
);
CREATE INDEX clarification_questions_open_idx ON rfpilot.clarification_questions(proposal_reference_id,status);

ALTER TABLE rfpilot.conversations ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.conversation_messages ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.conversation_message_attachments ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.conversation_message_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.clarification_questions ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.clarification_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_conversations ON rfpilot.conversations USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_conversation_messages ON rfpilot.conversation_messages USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_conversation_message_attachments ON rfpilot.conversation_message_attachments USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_clarification_questions ON rfpilot.clarification_questions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
