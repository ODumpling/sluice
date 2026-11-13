/**
 * Row-level write capture for Postgres. An event trigger attaches an AFTER
 * INSERT/UPDATE/DELETE trigger to every table the app creates, so migrations
 * run by the app at boot are covered automatically.
 */
import type pg from 'pg';
import type { Json } from '@sluice-dev/fakes';

export const AUDIT_SQL = `
CREATE SCHEMA IF NOT EXISTS sluice_audit;
CREATE TABLE IF NOT EXISTS sluice_audit.changes (
  seq bigserial PRIMARY KEY,
  table_name text NOT NULL,
  op text NOT NULL,
  old_row jsonb,
  new_row jsonb
);
CREATE OR REPLACE FUNCTION sluice_audit.capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sluice_audit.changes (table_name, op, old_row, new_row)
  VALUES (
    CASE WHEN TG_TABLE_SCHEMA = 'public' THEN TG_TABLE_NAME ELSE TG_TABLE_SCHEMA || ':' || TG_TABLE_NAME END,
    TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
  );
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION sluice_audit.attach() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands()
           WHERE command_tag = 'CREATE TABLE' AND schema_name NOT IN ('sluice_audit', 'pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER sluice_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION sluice_audit.capture()',
      r.object_identity);
  END LOOP;
END $$;
DROP EVENT TRIGGER IF EXISTS sluice_audit_attach;
CREATE EVENT TRIGGER sluice_audit_attach ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION sluice_audit.attach();
`;

export interface DbChange {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  old: Json;
  new: Json;
}

export async function installAudit(client: pg.Client): Promise<void> {
  await client.query(AUDIT_SQL);
}

export async function auditCursor(client: pg.Client): Promise<number> {
  const r = await client.query<{ s: string | null }>('SELECT max(seq) AS s FROM sluice_audit.changes');
  return Number(r.rows[0]?.s ?? 0);
}

export async function readChanges(client: pg.Client, since: number): Promise<{ cursor: number; changes: DbChange[] }> {
  const r = await client.query<{ seq: string; table_name: string; op: DbChange['op']; old_row: Json; new_row: Json }>(
    'SELECT seq, table_name, op, old_row, new_row FROM sluice_audit.changes WHERE seq > $1 ORDER BY seq',
    [since],
  );
  const changes = r.rows.map((row) => ({ table: row.table_name, op: row.op, old: row.old_row, new: row.new_row }));
  const last = r.rows[r.rows.length - 1];
  return { cursor: last ? Number(last.seq) : since, changes };
}

/** Full dump of application tables (excluding the audit schema), rows ordered by primary key / ctid. */
export async function dumpTables(client: pg.Client): Promise<Record<string, Json[]>> {
  const t = await client.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'sluice_audit') ORDER BY schemaname, tablename`,
  );
  const out: Record<string, Json[]> = {};
  for (const { schemaname, tablename } of t.rows) {
    const pk = await client.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
      [`"${schemaname}"."${tablename}"`],
    );
    const order = pk.rows.length ? pk.rows.map((r) => `"${r.attname}"`).join(', ') : 'ctid';
    const rows = await client.query<{ j: Json }>(
      `SELECT to_jsonb(t) AS j FROM "${schemaname}"."${tablename}" t ORDER BY ${order}`,
    );
    // public tables are keyed by bare name, others as schema:table (no dots, so noise-filter globs stay simple)
    out[schemaname === 'public' ? tablename : `${schemaname}:${tablename}`] = rows.rows.map((r) => r.j);
  }
  return out;
}
