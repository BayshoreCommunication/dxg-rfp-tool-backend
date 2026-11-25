// Shared by the proposal purge suites: the application-role switch, a storage stand-in that
// behaves like a bucket (it knows which objects exist), and Postgres fixtures written by the
// migration role.
import { TEST_APP_ROLE_URL, TEST_POSTGRES_URL } from './env';
import { ensureAppRole, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { closePostgres, postgresPool } from '../config/postgres';

export const SYSTEM_ACTOR = '000000000000000000000000';

// ---- storage stand-in ---------------------------------------------------------------------------
// DELETE of an object it holds answers 204 and forgets the object. DELETE of a key it does not
// hold answers 404 NoSuchKey, which is stricter than S3 (S3 answers 204): the purge has to treat
// "already gone" as done rather than be handed a success.
const bucket = `purge-artifacts-${randomMongoId().slice(0, 10)}`;
const xml = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
export const storage = {
  requests: [] as string[],
  objects: new Set<string>(),
  /** Keys answered 403 AccessDenied. */
  denied: new Set<string>(),
  /** Keys answered 500 InternalError. */
  failing: new Set<string>(),
  /** Runs when a DELETE for the key arrives, before it is answered. */
  onDelete: new Map<string, () => Promise<void>>(),
  server: null as http.Server | null,
};
export const deleteRequests = (objectKey: string) => storage.requests.filter((request) => request === `DELETE ${objectKey}`).length;

const answer = async (request: http.IncomingMessage, response: http.ServerResponse) => {
  const objectKey = decodeURIComponent(new URL(request.url ?? '/', 'http://storage').pathname).replace(`/${bucket}/`, '');
  storage.requests.push(`${request.method} ${objectKey}`);
  request.resume();
  const fail = (status: number, code: string) => {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(xml(code));
  };
  if (storage.denied.has(objectKey)) return fail(403, 'AccessDenied');
  if (storage.failing.has(objectKey)) return fail(500, 'InternalError');
  if (request.method !== 'DELETE') return fail(405, 'MethodNotAllowed');
  await storage.onDelete.get(objectKey)?.();
  if (!storage.objects.delete(objectKey)) return fail(404, 'NoSuchKey');
  response.writeHead(204);
  response.end();
};

// ---- roles --------------------------------------------------------------------------------------
/** The migration role: writes fixtures and reads results, outside row-level security. */
export let admin: Pool;

/**
 * Migrates, then points the code under test at the application role and the stand-in. Asserts
 * that the role is bound by row-level security and that the transition trigger is in place.
 */
export const startPurgeEnvironment = async (): Promise<void> => {
  admin = new Pool({ connectionString: TEST_POSTGRES_URL, max: 4 });
  try {
    await admin.query('SELECT 1');
  } catch (error) {
    throw new Error(`integration services are not reachable; start them with \`npm run integration:up\`. ${String(error)}`);
  }
  ensureMigrated();
  await ensureAppRole(admin);

  await closePostgres();
  process.env.POSTGRES_URL = TEST_APP_ROLE_URL;
  const role = (await postgresPool().query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  )).rows[0];
  assert.deepEqual(role, { role: 'rfpilot_app', rolsuper: false, rolbypassrls: false });
  const guards = (await admin.query<{ forced: boolean; triggers: number }>(
    `SELECT c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'document_source_transition' AND t.tgenabled <> 'D') AS triggers
       FROM pg_class c WHERE c.oid = 'rfpilot.document_sources'::regclass`,
  )).rows[0];
  assert.deepEqual(guards, { forced: true, triggers: 1 });

  storage.server = http.createServer((request, response) => {
    answer(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => storage.server!.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    DOCUMENT_STORAGE_BUCKET: bucket,
    DOCUMENT_STORAGE_REGION: 'us-east-1',
    DOCUMENT_STORAGE_ENDPOINT: `http://127.0.0.1:${(storage.server.address() as AddressInfo).port}`,
    DOCUMENT_STORAGE_FORCE_PATH_STYLE: 'true',
    DOCUMENT_STORAGE_KEY: 'test',
    DOCUMENT_STORAGE_SECRET: 'test',
  });
};

export const stopPurgeEnvironment = async (): Promise<void> => {
  storage.server?.closeAllConnections();
  storage.server?.close();
  await admin?.end();
  await closePostgres();
};

// ---- Postgres fixtures --------------------------------------------------------------------------
export type Fixture = { organizationId: string; organizationMongoId: string; referenceId: string; proposalMongoId: string; conversationId: string };

/**
 * An organization (or `existing`'s), a user, a proposal reference and its active conversation.
 * `ids` pins the MongoDB ids when the suite also writes the MongoDB documents.
 */
export const seedProposal = async (
  label: string,
  existing?: Pick<Fixture, 'organizationId' | 'organizationMongoId'>,
  ids: { organizationMongoId?: string; proposalMongoId?: string } = {},
): Promise<Fixture> => {
  const organizationMongoId = existing?.organizationMongoId ?? ids.organizationMongoId ?? randomMongoId();
  const proposalMongoId = ids.proposalMongoId ?? randomMongoId();
  let organizationId = existing?.organizationId;
  if (!organizationId) {
    organizationId = (await admin.query<{ id: string }>(
      'INSERT INTO rfpilot.organizations(external_mongo_id,name) VALUES($1,$2) RETURNING id',
      [organizationMongoId, `Purge ${label} ${organizationMongoId.slice(0, 8)}`],
    )).rows[0].id;
  }
  const userId = (await admin.query<{ id: string }>(
    'INSERT INTO rfpilot.users(organization_id,external_mongo_id) VALUES($1,$2) RETURNING id',
    [organizationId, randomMongoId()],
  )).rows[0].id;
  const referenceId = (await admin.query<{ id: string }>(
    'INSERT INTO rfpilot.proposal_references(organization_id,owner_user_id,external_mongo_id) VALUES($1,$2,$3) RETURNING id',
    [organizationId, userId, proposalMongoId],
  )).rows[0].id;
  const conversationId = crypto.randomUUID();
  await admin.query(
    'INSERT INTO rfpilot.conversations(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4)',
    [conversationId, organizationId, referenceId, randomMongoId()],
  );
  return { organizationId, organizationMongoId, referenceId, proposalMongoId, conversationId };
};

export type SourceOptions = {
  /** No document_objects row: an upload session whose bytes never arrived. */
  withObject?: boolean;
  /** The object row exists but the object is not in storage. */
  inStorage?: boolean;
  legalHold?: boolean;
  retentionDays?: number;
};
export const seedSource = async (fixture: Fixture, status: string, options: SourceOptions = {}) => {
  const id = crypto.randomUUID();
  await admin.query(
    `INSERT INTO rfpilot.document_sources(id,organization_id,proposal_reference_id,uploader_external_user_id,status,legal_hold,retention_until,deleted_at)
     VALUES($1,$2,$3,$4,$5::text,$6::boolean,CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END,CASE WHEN $5::text='deleted' THEN now() - interval '1 day' ELSE NULL END)`,
    [id, fixture.organizationId, fixture.referenceId, randomMongoId(), status, options.legalHold ?? false, options.retentionDays ?? null],
  );
  const objectKey = `quarantine/${fixture.organizationMongoId}/${id}/original.pdf`;
  let objectId: string | null = null;
  if (options.withObject !== false) {
    objectId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO rfpilot.document_objects(id,organization_id,source_id,object_key,original_filename,safe_filename,declared_mime_type,expected_size_bytes)
       VALUES($1,$2,$3,$4,'brief.pdf','brief.pdf','application/pdf',1024)`,
      [objectId, fixture.organizationId, id, objectKey],
    );
    // A source the owner already deleted has no object left.
    if (options.inStorage !== false && status !== 'deleted') storage.objects.add(objectKey);
  }
  return { id, objectKey, objectId };
};

// ---- reads --------------------------------------------------------------------------------------
export const sourceRow = async (id: string) =>
  (await admin.query<{ status: string; deleted_at: Date | null; updated_at: Date }>(
    'SELECT status, deleted_at, updated_at FROM rfpilot.document_sources WHERE id=$1', [id],
  )).rows[0];
export const conversationStatus = async (fixture: Fixture) =>
  (await admin.query<{ status: string }>('SELECT status FROM rfpilot.conversations WHERE id=$1', [fixture.conversationId])).rows[0].status;
export const purgeEvents = async (fixture: Fixture) =>
  (await admin.query<{ actor_external_user_id: string; target_type: string; target_id: string; decision: string; metadata: Record<string, unknown> }>(
    `SELECT actor_external_user_id, target_type, target_id, decision, metadata FROM rfpilot.audit_events
      WHERE organization_id=$1 AND action='proposal_artifacts_purged' AND target_id=$2 ORDER BY occurred_at, id`,
    [fixture.organizationId, fixture.referenceId],
  )).rows;
