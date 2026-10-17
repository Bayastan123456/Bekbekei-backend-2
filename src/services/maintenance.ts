import type { Database, SQL } from '../db.js';

export const jobAttemptLimit = 10;
export async function jobHealth(db: SQL) {
  return (
    await db.query<{ failed: number; overdue: number; oldestDueAt: Date | null }>(
      `SELECT count(*) FILTER (WHERE attempts >= $1)::int failed,
      count(*) FILTER (WHERE attempts < $1 AND run_at < now() - interval '5 minutes')::int overdue,
      min(run_at) FILTER (WHERE attempts < $1 AND run_at <= now()) AS "oldestDueAt"
      FROM jobs WHERE completed_at IS NULL`,
      [jobAttemptLimit],
    )
  ).rows[0];
}

// Fixed table names; each deletion is bounded to avoid a long transaction on a busy database.
// Business records, payment deduplication keys and audit logs are deliberately retained.
export async function cleanupTechnicalData(db: Database, batchSize = 500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('Invalid cleanup batch size');
  const policies = {
    events: "created_at < now() - interval '7 days'",
    sessions: "refresh_expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'",
    otp_challenges: "expires_at < now() - interval '1 day'",
    jobs: "completed_at < now() - interval '30 days'",
  };
  const deleted: Record<string, number> = {};
  for (const [table, condition] of Object.entries(policies)) {
    const result = await db.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${condition} LIMIT $1)`,
      [batchSize],
    );
    deleted[table] = result.rowCount;
  }
  return deleted;
}
