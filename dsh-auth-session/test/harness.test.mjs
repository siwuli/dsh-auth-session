/**
 * 模拟集成测试: 在模拟的 DSH webServer/apiProxy/typert 环境中
 * 完整验证 dsh-auth-session 插件的登录流程。
 *
 * 运行: node test/harness.test.mjs
 */
import assert from 'node:assert';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';

/* ---------------- 模拟 DSH 环境 ---------------- */

function makeMockEnv(apiMethods, typertEndpoints) {
  const exact = new Map();
  const prefixes = new Map();
  let taps = [];

  const webServer = {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes;
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`);
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    tapIndex(fn) {
      taps.push(fn);
      return () => { taps = taps.filter((x) => x !== fn); };
    },
    applyIndexTaps(html) { return taps.reduce((h, f) => f(h), html); },
    // 复刻 webserver.match: exact 优先, 前缀最长优先
    match(pathname) {
      if (exact.has(pathname)) return exact.get(pathname);
      let best;
      for (const [p, route] of prefixes) {
        if (pathname !== p && !pathname.startsWith(`${p}/`)) continue;
        if (!best || p.length > best.path.length) best = route;
      }
      return best;
    },
  };

  const apiProxy = apiMethods;
  const typert = {
    local: {
      list: () => typertEndpoints.map((e) => ({ id: e, namespace: e.split('/')[0], method: e.split('/')[1] })),
    },
  };
  const ctx = {
    webServer,
    apiProxy,
    typert,
    get: (name) => (name === 'apiProxy' ? apiProxy : name === 'typert' ? typert : undefined),
    effect: (fn) => {
      const d = fn();
      return d;
    },
    inject: (names, cb) => cb(ctx),
  };

  return { ctx, webServer, exact, prefixes };
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = Buffer.alloc(0) }) {
  const finalHeaders = { host: '127.0.0.1:3080', ...headers };
  const req = { method, url, headers: finalHeaders, socket: { remoteAddress: '127.0.0.1' } };
  let served = false;
  req[Symbol.asyncIterator] = async function* iterator() {
    if (!served) {
      served = true;
      yield body;
    }
  };
  return req;
}

function fakeRes() {
  const out = { status: 0, headers: {}, chunks: [], done: false };
  const res = new Writable({
    write(chunk, enc, cb) { out.chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.on('finish', () => { out.done = true; });
  res.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {}; };
  Object.defineProperty(res, 'result', {
    get() {
      return { status: out.status, headers: out.headers, body: Buffer.concat(out.chunks).toString('utf8') };
    },
  });
  return res;
}

async function hit(webServer, req) {
  const route = webServer.match(new URL(req.url ?? '/', 'http://dsh.local').pathname);
  assert.ok(route, `no route matched for ${req.url}`);
  const res = fakeRes();
  await route.handler(req, res);
  if (!res.result.body.length || !res.done) {
    try { await once(res, 'finish'); } catch (_) { /* ignore */ }
  }
  return res.result;
}

/* ---------------- 测试 ---------------- */

const SECRET_FILE = fileURLToPath(new URL('../auth-secret.txt', import.meta.url));
const env = makeMockEnv(
  {
    'session/list': async () => ({ ok: true, value: [{ id: 's1' }] }),
    'host.describe': async () => ({ ok: true, value: { version: 'mock' } }),
  },
  ['session/list', 'conversation/list'],
);
// extraEndpoints 覆盖第三方插件的自定义端点
apply(env.ctx, {
  username: 'admin',
  password: 'test-pass-123',
  secretFile: SECRET_FILE,
  extraEndpoints: ['extra/thing'],
});

// ---- 1. /api/auth-check 未登录 ----
let r = await hit(env.webServer, fakeReq({ url: '/api/auth-check' }));
assert.strictEqual(r.status, 200);
assert.deepStrictEqual(JSON.parse(r.body), { authenticated: false });
console.log('✓ 1. auth-check 未登录 = false');

// ---- 2. POST /login 错误密码 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/login',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: Buffer.from('username=admin&password=wrong'),
}));
assert.strictEqual(r.status, 401);
console.log('✓ 2. 错误密码 -> 401');

// ---- 3. POST /login 正确密码 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/login',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: Buffer.from('username=admin&password=test-pass-123'),
}));
assert.strictEqual(r.status, 302);
const setCookie = r.headers['set-cookie'];
assert.ok(setCookie && setCookie.includes('dsh_session='), '应种下会话Cookie');
const cookie = setCookie.split(';')[0];
console.log('✓ 3. 正确密码 -> 302 + Set-Cookie');

// ---- 4. 带Cookie访问 /api/auth-check ----
r = await hit(env.webServer, fakeReq({ url: '/api/auth-check', headers: { cookie } }));
assert.deepStrictEqual(JSON.parse(r.body), { authenticated: true });
console.log('✓ 4. 带Cookie auth-check = true');

// ---- 5. 未登录访问 typert 端点 -> 401 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/session/list', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '1', method: 'session/list', payload: { args: {} } })),
}));
assert.strictEqual(r.status, 401);
assert.ok(r.body.includes('unauthorized'));
console.log('✓ 5. 未登录 /api/session/list -> 401');

// ---- 6. 已登录访问 typert 端点 -> 委托到 apiProxy ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/session/list', headers: { cookie, 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '2', method: 'session/list', payload: { args: {} } })),
}));
assert.strictEqual(r.status, 200);
const enveloped = JSON.parse(r.body);
assert.strictEqual(enveloped.rpcId, '2');
assert.deepStrictEqual(enveloped.result, { ok: true, value: [{ id: 's1' }] });
console.log('✓ 6. 已登录 /api/session/list -> 委托成功, rpcId保留');

// ---- 7. apiProxy 域端点 (host.describe) 未登录 -> 401 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/host.describe', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '3', method: 'host.describe', payload: {} })),
}));
assert.strictEqual(r.status, 401);
console.log('✓ 7. 未登录 /api/host.describe -> 401');

// ---- 8. 已登录 host.describe -> 委托成功 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/host.describe', headers: { cookie, 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '4', method: 'host.describe', payload: {} })),
}));
assert.strictEqual(r.status, 200);
assert.deepStrictEqual(JSON.parse(r.body).result, { ok: true, value: { version: 'mock' } });
console.log('✓ 8. 已登录 /api/host.describe -> 委托成功');

// ---- 9. 特权方法 (host.pickDirectory) 未登录 -> 401 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/host.pickDirectory', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '5', method: 'host.pickDirectory', payload: {} })),
}));
assert.strictEqual(r.status, 401);
console.log('✓ 9. 未登录特权方法 -> 401');

// ---- 10. 围栏: 非loopback Host -> 403 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/session/list', headers: { host: 'evil.example', 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '6', method: 'session/list', payload: { args: {} } })),
}));
assert.strictEqual(r.status, 403);
console.log('✓ 10. 非信任Host -> 403 (围栏生效)');

// ---- 11. tapIndex 注入认证脚本 ----
const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
const outHtml = env.webServer.applyIndexTaps(html);
assert.ok(outHtml.includes('/api/auth-check'), '应注入auth-check脚本');
assert.ok(outHtml.includes('location.replace(\'/login\')'), '应包含跳转逻辑');
console.log('✓ 11. tapIndex 注入认证脚本');

// ---- 12. GET /login 页面 ----
r = await hit(env.webServer, fakeReq({ url: '/login' }));
assert.strictEqual(r.status, 200);
assert.ok(r.body.includes('DSH 登录'));
console.log('✓ 12. /login 登录页');

// ---- 13. 伪造Cookie -> 401 ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/session/list', headers: { cookie: 'dsh_session=forged.fake', 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '7', method: 'session/list', payload: { args: {} } })),
}));
assert.strictEqual(r.status, 401);
console.log('✓ 13. 伪造Cookie -> 401');

// ---- 14. extraEndpoints 也生效 (第三方自定义端点) ----
r = await hit(env.webServer, fakeReq({
  method: 'POST', url: '/api/extra/thing', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '8', method: 'extra/thing', payload: { args: {} } })),
}));
assert.strictEqual(r.status, 401);
console.log('✓ 14. extraEndpoints 自定义端点同样被门禁');

// ---- 15. 登录限速 ----
let limited = false;
for (let i = 0; i < 10; i++) {
  const rr = await hit(env.webServer, fakeReq({
    method: 'POST', url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from('username=admin&password=bad'),
  }));
  if (rr.status === 429) { limited = true; break; }
}
assert.ok(limited, '连续错误应触发429限速');
console.log('✓ 15. 登录限速生效(429)');

console.log('\n🎉 全部 15 组集成测试通过');
