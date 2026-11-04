import type { PoolClient } from "pg";

// Moves one customer's AI-domain rows from one organization to another (ORG-107, reused by ORG-110),
// and moves a holding organization's rows back on rollback. Every move runs inside
// withRowMovesAllowed, which needs only table-owner rights (the migration role created the tables).

// Organization-level and platform tables never move with a customer: DXG's corpus (migration 064),
// governance of it, and per-organization configuration and counters.
export const STAY_TABLES = new Set([
  "pricing_records", "pricing_modifiers", "pricing_regional_factors", "pricing_confidence_rules",
  "expert_rules", "governed_assets", "governed_asset_events",
  "knowledge_approval_decisions", "knowledge_fragment_decisions", "knowledge_fragment_embeddings",
  "knowledge_import_batches", "knowledge_import_documents", "knowledge_index_runs", "knowledge_parser_runs",
  "knowledge_release_events", "knowledge_release_fragments", "knowledge_releases", "knowledge_review_versions",
  "knowledge_source_fragments",
  "ai_budget_accounts", "ai_provider_policies", "ai_kill_switches",
  "assistant_retention_policies", "proposal_intelligence_retention_policies",
]);

// Columns that name the person who did or owns the row. Columns naming someone else's part in it
// (reviewer, evaluator, approver, assigner) don't seed ownership: those rows follow their parent.
const DOER_COLUMNS = [
  "owner_external_user_id", "actor_external_user_id", "initiator_external_user_id",
  "initiated_by_external_user_id", "created_by_external_user_id", "submitted_by_external_user_id",
  "uploader_external_user_id",
];

// Rows that point at another row by id without a foreign key: provider attempts name their run
// as (run_type, run_id) and outbox events their aggregate as (aggregate_type, aggregate_id). Ids are
// uuidv7 and unique across tables, so either moves when the id it names has moved.
const POLYMORPHIC_REFERENCES = [
  { table: "ai_provider_attempts", column: "run_id", text: false },
  { table: "outbox_events", column: "aggregate_id", text: true },
] as const;

type Edge = { child: string; childColumns: string[]; parent: string; parentColumns: string[]; composite: boolean };
export type TenantSchema = { tables: string[]; doerColumns: Record<string, string[]>; edges: Edge[]; idTables: string[]; primaryKeys: Record<string, string[]> };
export type MoveCounts = Record<string, number>;
// Primary keys of the rows a move changed, per table, as keyOf() renders them (ORG-110 rolls a
// placement back by exactly these rows).
export type MovedKeys = Record<string, string[]>;
export type IntegrityViolation = { child: string; parent: string; columns: string[]; organizationId: string; rows: number };

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const table = (name: string) => `rfpilot.${quoteIdent(name)}`;
const columns = (names: string[]) => names.map(quoteIdent).join(",");

export const loadTenantSchema = async (client: PoolClient): Promise<TenantSchema> => {
  const tenantTables = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' ORDER BY 1`,
  );
  const tables = tenantTables.rows.map((row) => row.name);
  const tenant = new Set(tables);
  const doers = await client.query<{ table: string; column: string }>(
    `SELECT c.relname AS table, a.attname AS column FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' AND NOT a.attisdropped AND a.attname = ANY($1)`,
    [DOER_COLUMNS],
  );
  const doerColumns: Record<string, string[]> = {};
  for (const row of doers.rows) {
    if (!tenant.has(row.table) || STAY_TABLES.has(row.table)) continue;
    (doerColumns[row.table] ??= []).push(row.column);
  }
  const fks = await client.query<{ child: string; child_columns: string[]; parent: string; parent_columns: string[] }>(
    `SELECT cc.relname AS child, pc.relname AS parent,
            ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS child_columns,
            ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS parent_columns
       FROM pg_constraint con
       JOIN pg_class cc ON cc.oid = con.conrelid JOIN pg_class pc ON pc.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'rfpilot' AND con.contype = 'f'`,
  );
  const edges: Edge[] = [];
  for (const fk of fks.rows) {
    if (!tenant.has(fk.child) || !tenant.has(fk.parent)) continue;
    const pairs = fk.child_columns.map((column, i) => [column, fk.parent_columns[i]] as const);
    const composite = pairs.some(([c, p]) => c === "organization_id" && p === "organization_id");
    const keyPairs = pairs.filter(([c]) => c !== "organization_id");
    if (keyPairs.length === 0) continue;
    edges.push({
      child: fk.child, parent: fk.parent, composite,
      childColumns: keyPairs.map(([c]) => c), parentColumns: keyPairs.map(([, p]) => p),
    });
  }
  const ids = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' AND a.attname = 'id' AND NOT a.attisdropped
        AND a.atttypid = 'uuid'::regtype`,
  );
  const idTables = ids.rows.map((row) => row.name).filter((name) => tenant.has(name) && !STAY_TABLES.has(name)).sort();
  const pks = await client.query<{ name: string; columns: string[] }>(
    `SELECT c.relname AS name,
            ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, ord)
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.n ORDER BY k.ord)::text[] AS columns
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' AND i.indisprimary`,
  );
  const primaryKeys: Record<string, string[]> = {};
  for (const row of pks.rows) if (tenant.has(row.name)) primaryKeys[row.name] = row.columns;
  return { tables, doerColumns, edges, idTables, primaryKeys };
};

// One text value per row for its primary key, e.g. ["<uuid>"] or ["<uuid>","3"].
const keyOf = (schema: TenantSchema, name: string) => {
  const pk = schema.primaryKeys[name];
  if (!pk?.length) throw new Error(`Table ${name} has no primary key; its rows can't be journaled`);
  return `jsonb_build_array(${pk.map((column) => `${quoteIdent(column)}::text`).join(",")})::text`;
};

const add = (counts: MoveCounts, name: string, rows: number | null) => {
  if (rows) counts[name] = (counts[name] ?? 0) + rows;
};

// Moves every row owned by one customer: their users row, their proposal references, rows they did,
// then everything reachable along foreign keys, until nothing more moves.
export const moveCustomerRows = async (
  client: PoolClient,
  schema: TenantSchema,
  // When given, collects the primary key of every row moved.
  input: { fromOrganizationId: string; toOrganizationId: string; userMongoId: string; keys?: MovedKeys },
): Promise<MoveCounts> => {
  const { fromOrganizationId: from, toOrganizationId: to, keys } = input;
  const counts: MoveCounts = {};
  const update = async (name: string, where: string, params: unknown[]) => {
    if (STAY_TABLES.has(name)) return 0;
    const result = await client.query<{ key: string }>(
      `UPDATE ${table(name)} SET organization_id = $1 WHERE organization_id = $2 AND (${where})${keys ? ` RETURNING ${keyOf(schema, name)} AS key` : ""}`,
      [to, from, ...params],
    );
    add(counts, name, result.rowCount);
    if (keys && result.rows.length) (keys[name] ??= []).push(...result.rows.map((row) => row.key));
    return result.rowCount ?? 0;
  };

  await update("users", `external_mongo_id = $3`, [input.userMongoId]);
  await update("proposal_references", `owner_user_id IN (SELECT id FROM rfpilot.users WHERE organization_id = $1 AND external_mongo_id = $3)`, [input.userMongoId]);
  for (const [name, doers] of Object.entries(input.userMongoId ? schema.doerColumns : {})) {
    await update(name, doers.map((column) => `${quoteIdent(column)}::text = $3`).join(" OR "), [input.userMongoId]);
  }

  for (let moved = 1, pass = 0; moved > 0; pass++) {
    if (pass > 50) throw new Error("Tenant move did not settle after 50 passes");
    moved = 0;
    for (const edge of schema.edges) {
      if (STAY_TABLES.has(edge.child) || STAY_TABLES.has(edge.parent)) continue;
      // A row that points at a moved row is that customer's too.
      moved += await update(edge.child,
        `(${columns(edge.childColumns)}) IN (SELECT ${columns(edge.parentColumns)} FROM ${table(edge.parent)} WHERE organization_id = $1)`, []);
      // A parent a moved row points at through organization_id has to move with it.
      if (edge.composite) {
        moved += await update(edge.parent,
          `(${columns(edge.parentColumns)}) IN (SELECT ${columns(edge.childColumns)} FROM ${table(edge.child)} WHERE organization_id = $1)`, []);
      }
    }
    const movedIds = (text: boolean) => schema.idTables
      .map((name) => `SELECT id${text ? "::text" : ""} FROM ${table(name)} WHERE organization_id = $1`).join(" UNION ALL ");
    for (const reference of POLYMORPHIC_REFERENCES) {
      if (!schema.tables.includes(reference.table)) continue;
      moved += await update(reference.table, `${quoteIdent(reference.column)} IN (${movedIds(reference.text)})`, []);
    }
  }
  return counts;
};

// Moves exactly the rows a journaled move recorded, and nothing else (ORG-110 rollback, and the
// compensation of a placement whose MongoDB half failed). Rows that have since left `from` stay put.
export const moveRowsByKey = async (
  client: PoolClient,
  schema: TenantSchema,
  input: { fromOrganizationId: string; toOrganizationId: string; keys: MovedKeys },
): Promise<MoveCounts> => {
  const counts: MoveCounts = {};
  for (const [name, keys] of Object.entries(input.keys)) {
    if (!schema.tables.includes(name) || STAY_TABLES.has(name)) continue;
    for (let i = 0; i < keys.length; i += 5000) {
      const result = await client.query(
        `UPDATE ${table(name)} SET organization_id = $1 WHERE organization_id = $2 AND ${keyOf(schema, name)} = ANY($3::text[])`,
        [input.toOrganizationId, input.fromOrganizationId, keys.slice(i, i + 5000)],
      );
      add(counts, name, result.rowCount);
    }
  }
  return counts;
};

// Rollback: everything in the holding organization goes back. Organization-level rows the holding
// organization accumulated (budget counters, policies) are deleted rather than merged.
export const moveAllRows = async (
  client: PoolClient,
  schema: TenantSchema,
  input: { fromOrganizationId: string; toOrganizationId: string },
): Promise<MoveCounts> => {
  const counts: MoveCounts = {};
  for (const name of schema.tables) {
    if (STAY_TABLES.has(name)) {
      const deleted = await client.query(`DELETE FROM ${table(name)} WHERE organization_id = $1`, [input.fromOrganizationId]);
      add(counts, `${name} (deleted)`, deleted.rowCount);
      continue;
    }
    const result = await client.query(
      `UPDATE ${table(name)} SET organization_id = $1 WHERE organization_id = $2`,
      [input.toOrganizationId, input.fromOrganizationId],
    );
    add(counts, name, result.rowCount);
  }
  return counts;
};

// Every composite foreign key must still resolve inside each organization; with FK checks off
// during the move, this is what proves the move kept integrity.
export const findIntegrityViolations = async (
  client: PoolClient,
  schema: TenantSchema,
  organizationIds: string[],
): Promise<IntegrityViolation[]> => {
  const violations: IntegrityViolation[] = [];
  for (const edge of schema.edges.filter((e) => e.composite)) {
    const join = edge.childColumns.map((c, i) => `p.${quoteIdent(edge.parentColumns[i])} = c.${quoteIdent(c)}`).join(" AND ");
    const present = edge.childColumns.map((c) => `c.${quoteIdent(c)} IS NOT NULL`).join(" AND ");
    const result = await client.query<{ organization_id: string; rows: string }>(
      `SELECT c.organization_id, count(*) AS rows FROM ${table(edge.child)} c
        WHERE c.organization_id = ANY($1::uuid[]) AND ${present}
          AND NOT EXISTS (SELECT 1 FROM ${table(edge.parent)} p WHERE p.organization_id = c.organization_id AND ${join})
        GROUP BY c.organization_id`,
      [organizationIds],
    );
    for (const row of result.rows) {
      violations.push({ child: edge.child, parent: edge.parent, columns: edge.childColumns, organizationId: row.organization_id, rows: Number(row.rows) });
    }
  }
  return violations;
};

// Rows can't change organization under the normal rules: tenant tables force row-level security
// (even the owner can't write a row into another organization), about 60 are append-only by trigger,
// and 70 foreign keys include organization_id. Inside the caller's transaction this lifts exactly
// those for the move, then has Postgres re-check every deferred foreign key and puts every setting
// back before returning. All of it is DDL inside the same transaction, so a failure anywhere rolls
// the settings back with the data.
export const withRowMovesAllowed = async <T>(
  client: PoolClient,
  schema: TenantSchema,
  work: () => Promise<T>,
): Promise<T> => {
  const forced = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' AND c.relforcerowsecurity
        AND (c.relname = ANY($1) OR c.relname = 'organizations')`,
    [schema.tables],
  );
  const triggers = await client.query<{ table: string; trigger: string }>(
    `SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rfpilot' AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND c.relname = ANY($1)`,
    [schema.tables],
  );
  const constraints = await client.query<{ table: string; constraint: string }>(
    `SELECT c.relname AS table, con.conname AS constraint FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = con.connamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) AND a.attname = 'organization_id'
      WHERE n.nspname = 'rfpilot' AND con.contype = 'f' AND NOT con.condeferrable AND cardinality(con.conkey) > 1
        AND c.relname = ANY($1)`,
    [schema.tables],
  );
  for (const { name } of forced.rows) await client.query(`ALTER TABLE ${table(name)} NO FORCE ROW LEVEL SECURITY`);
  for (const t of triggers.rows) await client.query(`ALTER TABLE ${table(t.table)} DISABLE TRIGGER ${quoteIdent(t.trigger)}`);
  for (const k of constraints.rows) {
    await client.query(`ALTER TABLE ${table(k.table)} ALTER CONSTRAINT ${quoteIdent(k.constraint)} DEFERRABLE INITIALLY DEFERRED`);
  }
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  const result = await work();
  // Postgres checks every deferred foreign key here and aborts the transaction on any break.
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  for (const k of constraints.rows) {
    await client.query(`ALTER TABLE ${table(k.table)} ALTER CONSTRAINT ${quoteIdent(k.constraint)} NOT DEFERRABLE`);
  }
  for (const t of triggers.rows) await client.query(`ALTER TABLE ${table(t.table)} ENABLE TRIGGER ${quoteIdent(t.trigger)}`);
  for (const { name } of forced.rows) await client.query(`ALTER TABLE ${table(name)} FORCE ROW LEVEL SECURITY`);
  return result;
};
