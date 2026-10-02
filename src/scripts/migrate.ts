import 'dotenv/config';
import { readFile,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { postgres,type Database } from '../db.js';
import { assert,sha } from '../core.js';
import { fileURLToPath } from 'node:url';
export async function migrate(db:Database) {
  // The transaction-level lock serializes migration runners on a real PostgreSQL server.
  await db.transaction(async tx=>{
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for(const name of (await readdir(resolve('migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(resolve('migrations',name),'utf8'),checksum=sha(sql);
      const existing=(await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name])).rows[0];
      if(existing){assert(existing.checksum===checksum,500,'MIGRATION_CHANGED',`Не изменяйте применённую миграцию ${name}`);continue;}
      await tx.query(sql);await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
    }
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert(process.env.DATABASE_URL,500,'CONFIG','Задайте DATABASE_URL');const db=postgres(process.env.DATABASE_URL);
  try{await migrate(db);console.log('Миграции применены');}finally{await db.close();}
}
