import { randomInt, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, type Database, type SQL, type Row } from '../db.js';
import { assert, equal, otpHash, passwordValid, phone, sha, token, type Config } from '../core.js';
export type Actor = Row & { id: string; role: 'CUSTOMER' | 'PICKER' | 'COURIER' | 'ADMIN'; session_id: string };
declare global {
  namespace Express {
    interface Request {
      actor: Actor;
    }
  }
}
export function authentication(db: Database): RequestHandler {
  return async (req, _res, next) => {
    const raw = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    assert(raw, 401, 'UNAUTHENTICATED', 'Требуется вход');
    const actor = await one<Actor>(
      db,
      `SELECT u.id,u.role,u.phone,u.first_name,u.last_name,s.id session_id
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>now() AND u.active`,
      [sha(raw)],
    );
    assert(actor, 401, 'UNAUTHENTICATED', 'Сеанс истёк');
    req.actor = actor;
    next();
  };
}
export function roles(...allowed: Actor['role'][]): RequestHandler {
  return (req, _res, next) => {
    assert(allowed.includes(req.actor.role), 403, 'FORBIDDEN', 'Недостаточно прав');
    next();
  };
}
export async function newSession(tx: SQL, userId: string) {
  const accessToken = token(),
    refreshToken = token();
  await tx.query(
    `INSERT INTO sessions(id,user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '30 days')`,
    [randomUUID(), userId, sha(accessToken), sha(refreshToken)],
  );
  return { accessToken, refreshToken, expiresIn: 900, tokenType: 'Bearer' };
}
export function authRoutes(db: Database, cfg: Config) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Слишком много попыток входа' } },
  });
  router.use(limiter);
  router.post('/otp/request', async (req, res) => {
    const body = z
      .object({ phone, consent: z.literal(true) })
      .strict()
      .parse(req.body);
    // Ensure no role upgrade through OTP. Staff accounts use password login only.
    const user = await one(db, 'SELECT role FROM users WHERE phone=$1', [body.phone]);
    assert(!user || user.role === 'CUSTOMER', 403, 'STAFF_LOGIN_REQUIRED', 'Используйте вход сотрудника');
    const code = String(randomInt(0, 10000)).padStart(4, '0');
    const accepted = await db.transaction(async tx => {
      const result = await tx.query(
        `INSERT INTO otp_challenges(phone,code_hash,expires_at,retry_at)
        VALUES($1,$2,now()+interval '5 minutes',now()+interval '60 seconds')
        ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,retry_at=excluded.retry_at,attempts=0,consumed_at=NULL
        WHERE otp_challenges.retry_at<=now() RETURNING phone`,
        [body.phone, otpHash(cfg.otpSecret, body.phone, code)],
      );
      return result.rowCount > 0;
    });
    assert(accepted, 429, 'OTP_COOLDOWN', 'Повторный запрос доступен через 60 секунд');
    cfg.logger({ type: 'development.otp', phone: body.phone, code, expiresIn: 300 });
    res.status(202).json({ data: { expiresIn: 300, retryAfter: 60 } });
  });
  router.post('/otp/verify', async (req, res) => {
    const body = z
      .object({ phone, code: z.string().regex(/^\d{4}$/) })
      .strict()
      .parse(req.body);
    // Failure is returned from the transaction so attempts are committed before throwing.
    const result = await db.transaction(async tx => {
      const challenge = await one(tx, 'SELECT * FROM otp_challenges WHERE phone=$1 FOR UPDATE', [body.phone]);
      if (
        !challenge ||
        challenge.consumed_at ||
        +new Date(challenge.expires_at) <= Date.now() ||
        challenge.attempts >= 5
      )
        return null;
      await tx.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE phone=$1', [body.phone]);
      if (!equal(challenge.code_hash, otpHash(cfg.otpSecret, body.phone, body.code))) return null;
      await tx.query('UPDATE otp_challenges SET consumed_at=now() WHERE phone=$1', [body.phone]);
      await tx.query('INSERT INTO users(id,phone) VALUES($1,$2) ON CONFLICT(phone) DO NOTHING', [
        randomUUID(),
        body.phone,
      ]);
      const user = await one(tx, 'SELECT id,role,active FROM users WHERE phone=$1 FOR NO KEY UPDATE', [body.phone]);
      if (!user?.active || user.role !== 'CUSTOMER') return null;
      return { ...(await newSession(tx, user.id)), user: { id: user.id, role: user.role } };
    });
    assert(result, 400, 'INVALID_OTP', 'Код неверный, использован или истёк');
    res.json({ data: result });
  });
  router.post('/staff/login', async (req, res) => {
    const body = z
      .object({ phone, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const session = await db.transaction(async tx => {
      const user = await one(tx, 'SELECT id,role,password_hash,active FROM users WHERE phone=$1 FOR NO KEY UPDATE', [
        body.phone,
      ]);
      assert(
        user?.active &&
          user.role !== 'CUSTOMER' &&
          user.password_hash &&
          passwordValid(body.password, user.password_hash),
        401,
        'INVALID_CREDENTIALS',
        'Неверный телефон или пароль',
      );
      return { ...(await newSession(tx, user.id)), user: { id: user.id, role: user.role } };
    });
    res.json({ data: session });
  });
  router.post('/refresh', async (req, res) => {
    const body = z
      .object({ refreshToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    const result = await db.transaction(async tx => {
      const lookup = await one(tx, 'SELECT user_id FROM sessions WHERE refresh_hash=$1', [sha(body.refreshToken)]);
      assert(lookup, 401, 'INVALID_REFRESH', 'Сеанс истёк');
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [lookup.user_id]);
      const session = await one(
        tx,
        `SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE refresh_hash=$1 AND revoked_at IS NULL AND refresh_expires_at>now() AND u.active FOR UPDATE OF s`,
        [sha(body.refreshToken)],
      );
      assert(session, 401, 'INVALID_REFRESH', 'Сеанс истёк');
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [session.id]);
      return newSession(tx, session.user_id);
    });
    res.json({ data: result });
  });
  router.post('/logout', authentication(db), async (req, res) => {
    await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [req.actor.session_id]);
    res.status(204).end();
  });
  return router;
}
