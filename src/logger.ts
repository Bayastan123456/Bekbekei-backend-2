type Level = 'debug' | 'info' | 'warn' | 'error';
const priorities: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitive =
  /^(authorization|cookie|set-cookie|password|password_hash|passwordHash|access_token|refresh_token|api_key|apiKey|otp|accessToken|refreshToken|access_hash|refresh_hash|token|secret|otpSecret|webhookSecret|phone|code|body|query)$/i;

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string')
    return value
      .replace(/\+996\d{9}/g, '[REDACTED]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]')
      .replace(
        /(\b(?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key|otp|code)\b["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@');
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error)
    return sanitize({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, seen);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : sanitize(item, seen)]),
  );
}

export function createLogger(
  minimum: string = 'info',
  write: (line: string) => void = line => {
    process.stdout.write(line + '\n');
  },
) {
  if (!Object.hasOwn(priorities, minimum)) throw new Error('LOG_LEVEL must be debug, info, warn or error');
  return (data: Record<string, unknown>) => {
    const level: Level =
      typeof data.level === 'string' && Object.hasOwn(priorities, data.level) ? (data.level as Level) : 'info';
    if (priorities[level] < priorities[minimum as Level]) return;
    write(
      JSON.stringify({ ...(sanitize(data) as Record<string, unknown>), timestamp: new Date().toISOString(), level }),
    );
  };
}
