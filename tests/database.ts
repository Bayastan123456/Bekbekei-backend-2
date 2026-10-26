import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgres, type Database, type SQL } from '../src/db.js';
export async function testDatabase(databaseUrl = process.env.TEST_DATABASE_URL): Promise<Database> {
  if (databaseUrl) {
    const schema = `test_${randomUUID().replaceAll('-', '')}`,
      pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const db = postgres(url.toString());
    return {
      ...db,
      async close() {
        await db.close();
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      },
    };
  }
  const pgLite = new PGlite();
  await pgLite.waitReady;
  const adapt = (client: Pick<Transaction, 'query' | 'exec'>): SQL => ({
    async query<T extends object>(sql: string, args: unknown[] = []) {
      if (!args.length && sql.split(';').filter(x => x.trim()).length > 1) {
        const result = await client.exec(sql);
        const last = result.at(-1);
        return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? 0 };
      }
      const result = await client.query<T>(sql, args);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  return { ...adapt(pgLite), transaction: fn => pgLite.transaction(tx => fn(adapt(tx))), close: () => pgLite.close() };
}
