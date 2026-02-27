// ─── Database Helpers ────────────────────────────────────────
// Functions that interact with PostgreSQL databases.
// Each function creates its own connection, does its work, then cleans up.
// This makes them safe to call from any workflow without worrying about
// shared connection state.

import postgres from 'postgres';
import { isLocalUrl } from './utils.js';
import type { TableInfo } from './types.js';

// Creates a PostgreSQL connection using the `postgres` library.
// Automatically handles SSL: enabled for remote DBs, disabled for localhost.
// max:1 because these are short-lived query connections, not connection pools.
export function createSql(url: string) {
  return postgres(url, {
    ssl: isLocalUrl(url) ? false : { rejectUnauthorized: false },
    max: 1,
    connect_timeout: 10,
  });
}

// Tests if a database is reachable and returns the PostgreSQL version.
// Used before any heavy operations to fail fast with a clear message.
export async function testConnection(url: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const sql = createSql(url);
  try {
    const res = await sql`SELECT version()`;
    const version = res[0].version.split(',')[0];
    await sql.end();
    return { ok: true, version };
  } catch (err: any) {
    try { await sql.end(); } catch {}
    return { ok: false, error: err.message };
  }
}

// Gets metadata about all public tables in a database:
// name, exact row count, column count, and size on disk.
export async function getTableInfo(url: string): Promise<TableInfo[]> {
  const sql = createSql(url);

  const tables = await sql`
    SELECT t.tablename,
           (SELECT COUNT(*) FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tablename)::int as col_count,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.tablename))) as size
    FROM pg_tables t
    WHERE t.schemaname = 'public'
    ORDER BY t.tablename
  `;

  const info: TableInfo[] = [];
  for (const row of tables) {
    const countRes = await sql.unsafe(`SELECT COUNT(*)::int as count FROM "${row.tablename}"`);
    info.push({
      name: row.tablename,
      rows: countRes[0].count,
      columns: row.col_count,
      size: row.size,
    });
  }

  await sql.end();
  return info;
}

// Gets the total size of the database in a human-readable format (e.g., "42 MB").
export async function getDbSize(url: string): Promise<string> {
  const sql = createSql(url);
  const res = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;
  await sql.end();
  return res[0].size;
}

// Finds the primary key column for a given table so we can use it to match rows
// between two databases. Without a PK, we can't tell which row is "the same" row
// in both DBs. Falls back to a UNIQUE constraint if no PK exists.
export async function getPrimaryKeyColumn(url: string, tableName: string): Promise<string | null> {
  const sql = createSql(url);
  try {
    // First, look for a PRIMARY KEY constraint on this table.
    // We join table_constraints (which knows the constraint type) with
    // key_column_usage (which knows the actual column name).
    // LIMIT 1 because we only need the first PK column (composite PKs
    // are rare and we keep it simple for now).
    const pkResult = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
      LIMIT 1
    `;
    if (pkResult.length > 0) {
      await sql.end();
      return pkResult[0].column_name;
    }

    // No PK found — try a UNIQUE constraint as a fallback.
    // A unique column can also uniquely identify rows, so it works
    // as an alternative for matching rows between databases.
    const uniqueResult = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
        AND tc.constraint_type = 'UNIQUE'
      ORDER BY kcu.ordinal_position
      LIMIT 1
    `;
    await sql.end();
    return uniqueResult.length > 0 ? uniqueResult[0].column_name : null;
  } catch (err: any) {
    // If anything goes wrong (e.g., permissions), just return null
    // and let the caller handle the "no PK found" case gracefully
    try { await sql.end(); } catch {}
    return null;
  }
}

// Gets the list of column names for a table, in their original order.
// We use this to decide which columns to show in the diff output.
// ordinal_position ensures columns come back in the order they were defined.
export async function getTableColumns(url: string, tableName: string): Promise<string[]> {
  const sql = createSql(url);
  const result = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  await sql.end();
  return result.map((r: any) => r.column_name);
}

// Quick check: does this table exist in the given database?
// We need this because the user picks a table from DB1's table list,
// but that table might not exist in DB2 (schema drift).
export async function tableExistsInDb(url: string, tableName: string): Promise<boolean> {
  const sql = createSql(url);
  const result = await sql`
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = ${tableName}
  `;
  await sql.end();
  return result.length > 0;
}
