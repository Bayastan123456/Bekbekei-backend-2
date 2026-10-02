import pg from 'pg';
export type Row = Record<string, any>;
export interface SQL { query<T extends Row = Row>(sql: string, args?: any[]): Promise<{ rows: T[]; rowCount: number }> }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void> }
export function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const adapt = (client: pg.Pool | pg.PoolClient): SQL => ({ async query<T extends Row>(sql: string, args: any[] = []) {
    const raw = await client.query(sql, args); const result=Array.isArray(raw)?raw.at(-1)!:raw;
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  } });
  return { ...adapt(pool), async transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(adapt(client)); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }, close: () => pool.end() };
}
export async function one<T extends Row = Row>(db: SQL, sql: string, args: any[] = []): Promise<T | undefined> {
  return (await db.query<T>(sql, args)).rows[0];
}
