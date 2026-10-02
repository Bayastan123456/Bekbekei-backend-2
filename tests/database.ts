import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgres, type Database, type SQL, type Row } from '../src/db.js';
export async function testDatabase(): Promise<Database> {
  if (process.env.TEST_DATABASE_URL) {
    const schema = `test_${randomUUID().replaceAll('-', '')}`,
      pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
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
  const adapt = (client: any): SQL => ({
    async query<T extends Row>(sql: string, args: any[] = []) {
      if (!args.length && sql.split(';').filter(x => x.trim()).length > 1) {
        const result = await client.exec(sql);
        const last = result.at(-1);
        return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
      }
      const result = await client.query(sql, args);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  return { ...adapt(pgLite), transaction: fn => pgLite.transaction(tx => fn(adapt(tx))), close: () => pgLite.close() };
}
