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
const keyOf = (schema: TenantSchema, name: string, alias?: string) => {
  const pk = schema.primaryKeys[name];
  if (!pk?.length) throw new Error(`Table ${name} has no primary key; its rows can't be journaled`);
  return `jsonb_build_array(${pk.map((column) => `${alias ? `${alias}.` : ""}${quoteIdent(column)}::text`).join(",")})::text`;
};

const add = (counts: MoveCounts, name: string, rows: number | null) => {
  if (rows) counts[name] = (counts[name] ?? 0) + rows;
};

// Owner wins (DECISIONS.md, 2026-11-23): a proposal's Postgres data follows the proposal's owner.
// After the customer's own proposal units have left the source organization (moveCustomerRows,
// step 1), this lists every row still there that belongs with a proposal reference somebody else
// owns: those references, every row that points at a listed row through any foreign key or by id,
// and every parent a listed row is tied to through organization_id, until nothing more is found.
// moveCustomerRows never moves a listed row, so a row the customer did under another owner's
// proposal stays with that proposal, and nothing can drag that proposal after it. The list
// depends only on who owns each reference, never on which customers have already moved: a row
// that hangs by a plain foreign key off data that has already left for a third organization is
// listed too, exactly as it was while that data was still here.
const PINNED = "tenant_move_pinned";
// A customer's users row and proposal references move by ownership only, never as some row's parent.
const ANCHOR_TABLES = new Set(["users", "proposal_references"]);

const pointsAtMoved = (edge: Edge) =>
  `(${columns(edge.childColumns)}) IN (SELECT ${columns(edge.parentColumns)} FROM ${table(edge.parent)} WHERE organization_id = $1)`;
const isPointedAtByMoved = (edge: Edge) =>
  `(${columns(edge.parentColumns)}) IN (SELECT ${columns(edge.childColumns)} FROM ${table(edge.child)} WHERE organization_id = $1)`;

// Plain (one-column-set, no organization_id) foreign keys whose parent is a customer's own row.
// Parents in STAY_TABLES are DXG's shared corpus and configuration, which rows in any
// organization may legitimately name.
export const plainParentEdges = (schema: TenantSchema): Edge[] =>
  schema.edges.filter((edge) => !edge.composite && !STAY_TABLES.has(edge.parent));

const pinOtherOwnersProposalData = async (
  client: PoolClient,
  schema: TenantSchema,
  input: { fromOrganizationId: string; toOrganizationId: string; userMongoId: string },
): Promise<Set<string>> => {
  // Column names no tenant table uses, so a primary key column can't be mistaken for one of these.
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS ${PINNED} (pinned_table text NOT NULL, pinned_key text NOT NULL, pinned_id uuid,
       PRIMARY KEY (pinned_table, pinned_key)) ON COMMIT DROP`,
  );
  await client.query(`TRUNCATE ${PINNED}`);
  const pinnedTables = new Set<string>();
  const pin = async (name: string, where: string, params: unknown[]) => {
    if (STAY_TABLES.has(name)) return 0;
    const result = await client.query(
      `INSERT INTO ${PINNED} SELECT $2::text, ${keyOf(schema, name)}, ${schema.idTables.includes(name) ? "id" : "NULL::uuid"}
         FROM ${table(name)} moving WHERE moving.organization_id = $1 AND (${where}) ON CONFLICT DO NOTHING`,
      [input.fromOrganizationId, name, ...params],
    );
    if (result.rowCount) pinnedTables.add(name);
    return result.rowCount ?? 0;
  };
  // Rows of `other` in the source organization that are listed, as the given columns.
  const listed = (other: string, otherColumns: string[]) =>
    `SELECT ${otherColumns.map((column) => `other.${quoteIdent(column)}`).join(",")} FROM ${table(other)} other
      WHERE other.organization_id = $1 AND EXISTS (SELECT 1 FROM ${PINNED} WHERE pinned_table = $3 AND pinned_key = ${keyOf(schema, other, "other")})`;

  await pin("proposal_references",
    `NOT EXISTS (SELECT 1 FROM rfpilot.users owning_user WHERE owning_user.id = owner_user_id AND owning_user.external_mongo_id = $3)`, [input.userMongoId]);
  // Another owner's data that has already left: whatever still hangs off it by a plain foreign key
  // stays here, as it did while that data was here. (A composite key can't span organizations.)
  for (const edge of plainParentEdges(schema)) {
    if (STAY_TABLES.has(edge.child)) continue;
    await pin(edge.child,
      `EXISTS (SELECT 1 FROM ${table(edge.parent)} elsewhere WHERE elsewhere.organization_id NOT IN ($1, $3::uuid)
         AND ${edge.childColumns.map((column, i) => `elsewhere.${quoteIdent(edge.parentColumns[i])} = moving.${quoteIdent(column)}`).join(" AND ")})`,
      [input.toOrganizationId]);
  }
  for (let added = pinnedTables.size, pass = 0; added > 0; pass++) {
    if (pass > 50) throw new Error("Tenant move did not settle after 50 passes");
    added = 0;
    for (const edge of schema.edges) {
      if (STAY_TABLES.has(edge.child) || STAY_TABLES.has(edge.parent)) continue;
      if (pinnedTables.has(edge.parent)) {
        added += await pin(edge.child, `(${columns(edge.childColumns)}) IN (${listed(edge.parent, edge.parentColumns)})`, [edge.parent]);
      }
      if (edge.composite && pinnedTables.has(edge.child) && !ANCHOR_TABLES.has(edge.parent)) {
        added += await pin(edge.parent, `(${columns(edge.parentColumns)}) IN (${listed(edge.child, edge.childColumns)})`, [edge.child]);
      }
    }
    for (const reference of POLYMORPHIC_REFERENCES) {
      if (!schema.tables.includes(reference.table)) continue;
      added += await pin(reference.table,
        `${quoteIdent(reference.column)} IN (SELECT pinned_id${reference.text ? "::text" : ""} FROM ${PINNED} WHERE pinned_id IS NOT NULL)`, []);
    }
  }
  if (pinnedTables.size) await client.query(`ANALYZE ${PINNED}`);
  return pinnedTables;
};

// Moves every row owned by one customer, in three steps:
// 1. their users row, their proposal references, and each reference's unit: the rows tied to it
//    through organization_id in either direction, which the database won't let live apart;
// 2. everything left that belongs with somebody else's proposal reference is set aside
//    (pinOtherOwnersProposalData) and never moves here;
// 3. rows they did, then everything reachable along foreign keys, until nothing more moves.
export const moveCustomerRows = async (
  client: PoolClient,
  schema: TenantSchema,
  // When given, collects the primary key of every row moved.
  input: { fromOrganizationId: string; toOrganizationId: string; userMongoId: string; keys?: MovedKeys },
): Promise<MoveCounts> => {
  const { fromOrganizationId: from, toOrganizationId: to, keys } = input;
  const counts: MoveCounts = {};
  let pinnedTables = new Set<string>();
  const update = async (name: string, where: string, params: unknown[]) => {
    if (STAY_TABLES.has(name)) return 0;
    const notPinned = pinnedTables.has(name)
      ? ` AND NOT EXISTS (SELECT 1 FROM ${PINNED} WHERE pinned_table = '${name.replace(/'/g, "''")}' AND pinned_key = ${keyOf(schema, name)})`
      : "";
    const result = await client.query<{ key: string }>(
      `UPDATE ${table(name)} SET organization_id = $1 WHERE organization_id = $2 AND (${where})${notPinned}${keys ? ` RETURNING ${keyOf(schema, name)} AS key` : ""}`,
      [to, from, ...params],
    );
    add(counts, name, result.rowCount);
    if (keys && result.rows.length) (keys[name] ??= []).push(...result.rows.map((row) => row.key));
    return result.rowCount ?? 0;
  };

  await update("users", `external_mongo_id = $3`, [input.userMongoId]);
  await update("proposal_references", `owner_user_id IN (SELECT id FROM rfpilot.users WHERE organization_id = $1 AND external_mongo_id = $3)`, [input.userMongoId]);
  for (let moved = counts.proposal_references ?? 0, pass = 0; moved > 0; pass++) {
    if (pass > 50) throw new Error("Tenant move did not settle after 50 passes");
    moved = 0;
    for (const edge of schema.edges) {
      if (!edge.composite || STAY_TABLES.has(edge.child) || STAY_TABLES.has(edge.parent)) continue;
      // Only tables this move has touched can hold a moved row.
      if (counts[edge.parent]) moved += await update(edge.child, pointsAtMoved(edge), []);
      if (counts[edge.child] && !ANCHOR_TABLES.has(edge.parent)) moved += await update(edge.parent, isPointedAtByMoved(edge), []);
    }
  }

  pinnedTables = await pinOtherOwnersProposalData(client, schema, input);

  for (const [name, doers] of Object.entries(input.userMongoId ? schema.doerColumns : {})) {
    await update(name, doers.map((column) => `${quoteIdent(column)}::text = $3`).join(" OR "), [input.userMongoId]);
  }

  for (let moved = 1, pass = 0; moved > 0; pass++) {
    if (pass > 50) throw new Error("Tenant move did not settle after 50 passes");
    moved = 0;
    for (const edge of schema.edges) {
      if (STAY_TABLES.has(edge.child) || STAY_TABLES.has(edge.parent)) continue;
      // A row that points at a moved row is that customer's too.
      moved += await update(edge.child, pointsAtMoved(edge), []);
      // A parent a moved row points at through organization_id has to move with it.
      if (edge.composite) moved += await update(edge.parent, isPointedAtByMoved(edge), []);
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

type CrossOwnerRows = { rows: number; byTable: Record<string, number>; sample: Array<{ table: string; key: string; owners: string[] }> };
export type CrossOwnerCompositeTies = CrossOwnerRows & {
  references: number;
  // The known way in: an extraction run that reuses a run made for another owner's proposal.
  reusedExtractionRunsAcrossOwners: number;
};
export type CrossOwnerTies = { crossOwnerCompositeTies: CrossOwnerCompositeTies; rowsUnderTwoOwners: CrossOwnerRows };

// Rows of one organization reached from the references of two or more owners. With
// compositeOnly, each reference's unit is walked exactly as step 1 of moveCustomerRows walks it
// (foreign keys that include organization_id, both ways). Without, plain foreign keys are
// followed downwards as well, which is everything that hangs off a reference.
const UNITS = "tenant_move_units";
const rowsOfSeveralOwners = async (
  client: PoolClient, schema: TenantSchema, input: { organizationId: string; compositeOnly: boolean; sampleSize: number },
): Promise<CrossOwnerRows & { references: number }> => {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS ${UNITS} (unit_table text NOT NULL, unit_key text NOT NULL, unit_owner uuid NOT NULL,
       PRIMARY KEY (unit_table, unit_key, unit_owner)) ON COMMIT DROP`,
  );
  await client.query(`DELETE FROM ${UNITS}`);
  const labelled = new Set<string>();
  // `tied` rows take the owners of the `other` rows they share a key with.
  const label = async (tied: string, tiedColumns: string[], other: string, otherColumns: string[]) => {
    const result = await client.query(
      `INSERT INTO ${UNITS} SELECT DISTINCT $2::text, ${keyOf(schema, tied, "tied")}, unit.unit_owner
         FROM ${table(tied)} tied
         JOIN ${table(other)} other ON other.organization_id = $1
          AND ${tiedColumns.map((column, i) => `other.${quoteIdent(otherColumns[i])} = tied.${quoteIdent(column)}`).join(" AND ")}
         JOIN ${UNITS} unit ON unit.unit_table = $3 AND unit.unit_key = ${keyOf(schema, other, "other")}
        WHERE tied.organization_id = $1 ON CONFLICT DO NOTHING`,
      [input.organizationId, tied, other],
    );
    if (result.rowCount) labelled.add(tied);
    return result.rowCount ?? 0;
  };
  const seeded = await client.query(
    `INSERT INTO ${UNITS} SELECT 'proposal_references', ${keyOf(schema, "proposal_references", "tied")}, tied.owner_user_id
       FROM rfpilot.proposal_references tied WHERE tied.organization_id = $1`,
    [input.organizationId],
  );
  if (seeded.rowCount) labelled.add("proposal_references");
  for (let added = seeded.rowCount ?? 0, pass = 0; added > 0; pass++) {
    if (pass > 50) throw new Error("Proposal units did not settle after 50 passes");
    added = 0;
    for (const edge of schema.edges) {
      if (STAY_TABLES.has(edge.child) || STAY_TABLES.has(edge.parent) || (input.compositeOnly && !edge.composite)) continue;
      if (labelled.has(edge.parent)) added += await label(edge.child, edge.childColumns, edge.parent, edge.parentColumns);
      if (edge.composite && labelled.has(edge.child) && !ANCHOR_TABLES.has(edge.parent)) added += await label(edge.parent, edge.parentColumns, edge.child, edge.childColumns);
    }
  }
  const several = `SELECT unit_table, unit_key FROM ${UNITS} GROUP BY unit_table, unit_key HAVING count(*) > 1`;
  const byTable: Record<string, number> = {};
  for (const row of (await client.query<{ unit_table: string; rows: string }>(`SELECT unit_table, count(*) AS rows FROM (${several}) tied GROUP BY unit_table ORDER BY 1`)).rows) {
    byTable[row.unit_table] = Number(row.rows);
  }
  const sample = await client.query<{ unit_table: string; unit_key: string; owners: string[] }>(
    `SELECT unit.unit_table, unit.unit_key, array_agg(DISTINCT coalesce(owning_user.external_mongo_id::text, unit.unit_owner::text)) AS owners
       FROM ${UNITS} unit JOIN (${several}) tied USING (unit_table, unit_key)
       LEFT JOIN rfpilot.users owning_user ON owning_user.id = unit.unit_owner AND owning_user.organization_id = $1
      GROUP BY unit.unit_table, unit.unit_key ORDER BY 1, 2 LIMIT $2`,
    [input.organizationId, input.sampleSize],
  );
  return {
    references: seeded.rowCount ?? 0,
    rows: Object.values(byTable).reduce((sum, n) => sum + n, 0),
    byTable,
    sample: sample.rows.map((row) => ({ table: row.unit_table, key: row.unit_key, owners: row.owners })),
  };
};

// Pre-flight for one organization, before any customer moves. Owners in the samples are MongoDB
// user ids. Writes only its own temporary table.
// - crossOwnerCompositeTies: rows the database ties, through foreign keys that include
//   organization_id, to the references of two different owners. Such a row cannot follow both, so
//   both of those customers' moves fail on a foreign key and neither can leave (nothing is
//   misplaced).
// - rowsUnderTwoOwners: every row that hangs off two owners' references by any foreign key (the
//   rows above included). The others move without an error but end up apart from one parent, or
//   stay behind, and the verifier then reports them.
export const findCrossOwnerCompositeTies = async (
  client: PoolClient,
  schema: TenantSchema,
  input: { organizationId: string; sampleSize?: number },
): Promise<CrossOwnerTies> => {
  const sampleSize = input.sampleSize ?? 20;
  const composite = await rowsOfSeveralOwners(client, schema, { organizationId: input.organizationId, compositeOnly: true, sampleSize });
  const { references: _references, ...any } = await rowsOfSeveralOwners(client, schema, { organizationId: input.organizationId, compositeOnly: false, sampleSize });
  void _references;
  const reused = schema.tables.includes("source_extraction_runs")
    ? Number((await client.query<{ rows: string }>(
        `SELECT count(*) AS rows FROM rfpilot.source_extraction_runs run
           JOIN rfpilot.source_extraction_runs reused ON reused.organization_id = run.organization_id AND reused.id = run.reused_from_run_id
           JOIN rfpilot.proposal_references mine ON mine.id = run.proposal_reference_id
           JOIN rfpilot.proposal_references theirs ON theirs.id = reused.proposal_reference_id
          WHERE run.organization_id = $1 AND mine.owner_user_id <> theirs.owner_user_id`,
        [input.organizationId],
      )).rows[0].rows)
    : 0;
  return { crossOwnerCompositeTies: { ...composite, reusedExtractionRunsAcrossOwners: reused }, rowsUnderTwoOwners: any };
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
