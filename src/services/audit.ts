import type { SQL } from '../db.js';
export async function audit(tx: SQL, userId: string, action: string, id: string, payload: unknown = {}) {
  await tx.query('INSERT INTO audit_logs(actor_id,action,entity_id,payload) VALUES($1,$2,$3,$4)', [
    userId,
    action,
    id,
    JSON.stringify(payload),
  ]);
}
