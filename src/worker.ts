import { z } from 'zod';
import { cleanupTechnicalData, jobHealth, jobAttemptLimit } from './services/maintenance.js';
import type { Job, Order, Refund } from './models.js';
import { one, type Database } from './db.js';
import { event, type Config } from './core.js';
import { cancelOrder, setStatus } from './services/orders.js';
export async function runJobs(db: Database, cfg: Config, limit = 20, canProcess: () => boolean = () => true) {
  let processed = 0;
  for (let n = 0; n < limit && canProcess(); n++) {
    const didWork = await db.transaction(async tx => {
      const job = await one<Job>(
        tx,
        'SELECT * FROM jobs WHERE completed_at IS NULL AND run_at<=now() AND attempts<$1 ORDER BY run_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
        [jobAttemptLimit],
      );
      if (!job) return false;
      await tx.query('SAVEPOINT job_work');
      try {
        if (job.kind === 'EXPIRE_ORDER') {
          const payload = z.object({ orderId: z.string().uuid() }).parse(job.payload);
          const order = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [payload.orderId]);
          if (order?.status === 'AWAITING_PAYMENT' && order.expires_at && +new Date(order.expires_at) <= Date.now())
            await cancelOrder(tx, order, null);
        } else if (job.kind === 'UNREACHABLE_ORDER') {
          const payload = z.object({ orderId: z.string().uuid() }).parse(job.payload);
          const order = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [payload.orderId]);
          if (order?.status === 'DELIVERING' && order.waiting_until && +new Date(order.waiting_until) <= Date.now())
            await setStatus(tx, order, 'RETURNING', null);
        } else if (job.kind === 'REFUND') {
          const payload = z.object({ refundId: z.string().uuid() }).parse(job.payload);
          // Only simulated provider is supported; no claim of a real bank refund.
          if (cfg.paymentProvider !== 'mock') throw new Error('Refund provider is not configured');
          const refund = await one<Refund>(tx, 'SELECT * FROM refunds WHERE id=$1', [payload.refundId]);
          if (refund && refund.status !== 'COMPLETED') {
            const order = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [refund.order_id]);
            await tx.query("UPDATE refunds SET status='COMPLETED' WHERE id=$1", [refund.id]);
            const pending = await one(tx, "SELECT 1 FROM refunds WHERE order_id=$1 AND status='PENDING'", [
              refund.order_id,
            ]);
            if (order?.payment_status === 'REFUND_PENDING' && !pending)
              await tx.query("UPDATE orders SET payment_status='REFUNDED' WHERE id=$1", [order.id]);
            await event(
              tx,
              'refund.completed',
              { orderId: refund.order_id, refundId: refund.id, amount: refund.amount, testMode: true },
              order?.user_id ?? null,
            );
          }
        } else throw new Error(`Unknown job type: ${job.kind}`);
        await tx.query('RELEASE SAVEPOINT job_work');
        await tx.query('UPDATE jobs SET completed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1', [job.id]);
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT job_work');
        await tx.query(
          "UPDATE jobs SET attempts=attempts+1,last_error=$2,run_at=now()+interval '30 seconds' WHERE id=$1",
          [job.id, String(error).slice(0, 500)],
        );
        cfg.logger({
          type: job.attempts + 1 >= jobAttemptLimit ? 'job.failed' : 'job.error',
          attempts: job.attempts + 1,
          jobId: job.id,
          message: String(error),
        });
      }
      return true;
    });
    if (!didWork) break;
    processed++;
  }
  return processed;
}
export function startWorker(db: Database, cfg: Config) {
  let active: Promise<void> | undefined;
  let stopped = false;
  let nextHealthCheck = 0;
  let nextCleanup = 0;
  const tick = async () => {
    try {
      await runJobs(db, cfg, 20, () => !stopped);
      if (stopped) return;
      const now = Date.now();
      if (now >= nextHealthCheck) {
        nextHealthCheck = now + 60_000;
        const health = await jobHealth(db);
        cfg.logger({ type: health.failed || health.overdue ? 'worker.unhealthy' : 'worker.health', ...health });
      }
      if (!stopped && now >= nextCleanup) {
        nextCleanup = now + 60 * 60_000;
        const deleted = await cleanupTechnicalData(db);
        cfg.logger({ type: 'maintenance.completed', deleted });
      }
    } catch (error) {
      cfg.logger({ type: 'worker.error', message: String(error) });
    }
  };
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = tick().finally(() => {
      active = undefined;
    });
  }, 2000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
