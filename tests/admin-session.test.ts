import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function setup(fetch: typeof globalThis.fetch) {
  const storage = new Map([['bekbekei_admin_refresh_token', 'saved-refresh']]);
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: id === 'shell', textContent: '', reset() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    fetch,
    console,
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: { getElementById: element },
  });
  // Isolate session handling from table rendering; keep the real startup restore logic.
  const start = source.indexOf('(async function restoreSession()');
  vm.runInContext(
    source.slice(0, start) +
      '\nenterDashboard = async () => { $("shell").hidden = false; };\n globalThis.restored = ' +
      source.slice(start),
    context,
  );
  return { context, storage, element };
}
const reply = (status: number, data: unknown) =>
  new Response(JSON.stringify(status >= 400 ? { error: { message: 'failure' } } : { data }), { status });

test('admin reload restores the session and saves the rotated refresh token', async () => {
  const state = setup(((url: string) =>
    Promise.resolve(
      url.endsWith('/refresh')
        ? reply(200, { accessToken: 'access', refreshToken: 'rotated' })
        : reply(200, { role: 'ADMIN' }),
    )) as typeof fetch);
  await state.context.restored;
  assert.equal(state.storage.get('bekbekei_admin_refresh_token'), 'rotated');
  assert.equal(state.element('shell').hidden, false);
  assert.equal(state.element('login').hidden, true);
});

test('admin reload keeps the saved session on network and server errors', async () => {
  for (const response of [() => Promise.reject(new Error('offline')), () => Promise.resolve(reply(503, null))]) {
    const state = setup(response);
    await state.context.restored;
    assert.equal(state.storage.get('bekbekei_admin_refresh_token'), 'saved-refresh');
    assert.match(state.element('login-message').textContent, /Не удалось восстановить/);
  }
});

test('admin reload clears an expired refresh token', async () => {
  const state = setup(() => Promise.resolve(reply(401, null)));
  await state.context.restored;
  assert.equal(state.storage.size, 0);
  assert.equal(state.element('login').hidden, false);
});

test('parallel unauthorized requests share one refresh', async () => {
  let refreshes = 0;
  const state = setup((async (url: string, options: RequestInit) => {
    if (url.endsWith('/refresh')) {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return reply(200, { accessToken: `access-${refreshes}`, refreshToken: `refresh-${refreshes}` });
    }
    if (url.endsWith('/me')) return reply(200, { role: 'ADMIN' });
    return (options.headers as Record<string, string>).Authorization === 'Bearer access-1'
      ? reply(401, null)
      : reply(200, []);
  }) as typeof fetch);
  await state.context.restored;
  await vm.runInContext('Promise.all([api("/first"), api("/second"), api("/third")])', state.context);
  assert.equal(refreshes, 2); // One restore and one shared refresh.
  assert.equal(state.storage.get('bekbekei_admin_refresh_token'), 'refresh-2');
});
