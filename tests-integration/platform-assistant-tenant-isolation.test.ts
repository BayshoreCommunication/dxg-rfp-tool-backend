import { TEST_APP_ROLE_URL } from "./env";
import {
  ensureAppRole,
  ensureMigrated,
  ensureServices,
  seedTenant,
  setTenantGuc,
  type Tenant,
} from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { closePostgres, postgresPool } from "../config/postgres";

let tenantA: Tenant;
let tenantB: Tenant;
let appPool: Pool;
const rows: Record<string, { threadId: string; messageId: string }> = {};

const seedAssistantRows = async (tenant: Tenant) => {
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  await postgresPool().query(
    `INSERT INTO rfpilot.assistant_threads(
       id,organization_id,owner_external_user_id,title,message_count,last_message_at
     ) VALUES($1,$2,$3,$4,1,now())`,
    [
      threadId,
      tenant.organizationId,
      tenant.actorUserMongoId,
      `Thread ${tenant.organizationMongoId.slice(0, 8)}`,
    ],
  );
  await postgresPool().query(
    `INSERT INTO rfpilot.assistant_messages(
       id,organization_id,thread_id,ordinal,role,content,status,actor_external_user_id
     ) VALUES($1,$2,$3,1,'user','RLS fixture message','complete',$4)`,
    [messageId, tenant.organizationId, threadId, tenant.actorUserMongoId],
  );
  return { threadId, messageId };
};

const withAppClient = async <T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

before(async () => {
  await ensureServices();
  ensureMigrated();
  await ensureAppRole();
  tenantA = await seedTenant("Assistant RLS Org A");
  tenantB = await seedTenant("Assistant RLS Org B");
  rows.a = await seedAssistantRows(tenantA);
  rows.b = await seedAssistantRows(tenantB);
  appPool = new Pool({
    connectionString: TEST_APP_ROLE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
});

after(async () => {
  if (appPool) await appPool.end();
  await closePostgres();
});

test("organization RLS filters assistant threads and messages", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    const threads = await client.query<{ id: string }>(
      "SELECT id FROM rfpilot.assistant_threads ORDER BY id",
    );
    const messages = await client.query<{ id: string }>(
      "SELECT id FROM rfpilot.assistant_messages ORDER BY id",
    );
    assert.deepEqual(threads.rows.map((row) => row.id), [rows.a.threadId]);
    assert.deepEqual(messages.rows.map((row) => row.id), [rows.a.messageId]);
  });
});

test("the application role sees no assistant data without a tenant GUC", async () => {
  await withAppClient(async (client) => {
    const threads = await client.query<{ n: string }>(
      "SELECT count(*) n FROM rfpilot.assistant_threads",
    );
    const messages = await client.query<{ n: string }>(
      "SELECT count(*) n FROM rfpilot.assistant_messages",
    );
    assert.equal(Number(threads.rows[0].n), 0);
    assert.equal(Number(messages.rows[0].n), 0);
  });
});

test("RLS rejects an assistant thread written to a different organization", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    await assert.rejects(
      client.query(
        `INSERT INTO rfpilot.assistant_threads(
           id,organization_id,owner_external_user_id,title
         ) VALUES($1,$2,$3,'Cross-tenant assistant write')`,
        [crypto.randomUUID(), tenantB.organizationId, tenantA.actorUserMongoId],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "42501");
        return true;
      },
    );
  });
});

test("database rejects a message whose organization does not match its thread", async () => {
  await withAppClient(async (client) => {
    await setTenantGuc(client, tenantA.organizationId, tenantA.organizationMongoId);
    await assert.rejects(
      client.query(
        `INSERT INTO rfpilot.assistant_messages(
           id,organization_id,thread_id,ordinal,role,content,status,actor_external_user_id
         ) VALUES($1,$2,$3,2,'user','Cross-tenant thread reference','complete',$4)`,
        [
          crypto.randomUUID(),
          tenantA.organizationId,
          rows.b.threadId,
          tenantA.actorUserMongoId,
        ],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "23503");
        return true;
      },
    );
  });
});
