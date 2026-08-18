/**
 * dsh-auth-session — 宿主端 (Host) 插件入口
 *
 * 认证模型: Cookie 会话登录
 *   - GET  /api/auth-check  -> {authenticated: bool} (exact 路由)
 *   - GET  /login           -> 登录页 (exact 路由)
 *   - POST /login           -> 校验凭据, 种签名Cookie, 302 -> /
 *   - 前缀路由 /api/<域>      -> 影子覆盖连接插件的 "/api" 路由(最长前缀优先):
 *                              ① 浏览器信任围栏(与 client-connection 一致)
 *                              ② 会话门(无有效Cookie -> 401)
 *                              ③ 通过后桥接回 client-connection 的共享 RPC 链
 *                                 (createSharedFetchHandler: typert 端点走
 *                                 api-gateway dispatchRpc, 其余走 apiProxy)
 *   - tapIndex              -> index.html 注入认证检查脚本(未登录跳 /login)
 *
 * 域枚举: typert 注册表(local.list, 动态) + apiProxy 静态域 + config.extraDomains
 *
 * 为什么不用 /api interceptor: 该座位全局唯一且已被 dsh-api-gateway 占用,
 * 禁用它会破坏 Remote API; 前缀"/api"也被连接插件占用(重复注册抛错)。
 * 按域注册更长前缀是兼容的替代。
 *
 * 桥接目标说明 (v0.1.3 修复):
 *   - 旧版直接把认证后的请求交给 apiProxy (toFetchHandler)。apiProxy 只认
 *     点分端点 (UNARY_ROUTES, 如 settings.describe), 不认识 typert 命名空间
 *     端点 (namespace/method, 如 pluginInventory/list), 导致插件列表等
 *     Remote 调用全部 404。
 *   - 现在复用 client-connection 的 createSharedFetchHandler('/api', fallback):
 *     与 DSH 原生 /api 路由同一条分诊链 —— typert 端点由 api-gateway 的
 *     dispatchRpc 处理, 点分端点回退到 apiProxy, 行为与未装本插件时一致。
 *
 * 已知边界:
 *   - WebSocket 升级走 registerUpgrade 表(与 HTTP 路由分离), 无法拦截;
 *     /api/events.* 的 SSE GET 会走会话门(需Cookie), WS 升级保持原行为(只读事件流)。
 *   - /api/respond 与未知端点仍由连接插件原路由处理(respond 是受校验的特殊协议)。
 *   - 未来第三方插件新增 /api/<新域> 时, 若未在 typert 注册, 需在
 *     config.extraDomains 里补充。
 */

import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  loadSecret,
  makeToken,
  parseToken,
  tokenFromCookieHeader,
  sessionCookieHeader,
  safeEqual,
  createRateLimiter,
} from './auth-core.js';

/* ------------------------------------------------------------------ */
/* 浏览器信任围栏 (复刻 @deepseek-ai/dsh-client-connection)             */
/* ------------------------------------------------------------------ */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}
function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}
function isTrustedApiRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = headerValue(req.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** 与 client-connection 一致: 即使可信部署也锁定 loopback 的特权方法 */
const PRIVILEGED_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
]);

/** apiProxy 的点分端点 (从 @deepseek-ai/dsh-host-apiproxy 的 UNARY_ROUTES 提取) */
const DOT_ENDPOINTS = [
  // agentPreset
  'agentPreset.copy', 'agentPreset.list', 'agentPreset.openDocument', 'agentPreset.read',
  'agentPreset.remove', 'agentPreset.select',
  // credentials
  'credentials.describe', 'credentials.set', 'credentials.unset',
  // goal
  'goal.clear', 'goal.complete', 'goal.create', 'goal.edit', 'goal.pause', 'goal.resume',
  // host
  'host.createDirectory', 'host.describe', 'host.listDirectory', 'host.openPath', 'host.pickDirectory',
  // llm
  'llm.discoverModels', 'llm.models', 'llm.providers',
  // session
  'session.attachment', 'session.cancel', 'session.create', 'session.fork', 'session.history',
  'session.list', 'session.models', 'session.prompt', 'session.rename', 'session.search',
  'session.selectModel', 'session.updateQueue',
  // settings
  'settings.describe', 'settings.mutate', 'settings.openDocument', 'settings.replace', 'settings.update',
  // skill
  'skill.list',
  // subagent
  'subagent.history', 'subagent.interrupt', 'subagent.list', 'subagent.prompt',
  // workspace
  'workspace.archiveSession', 'workspace.create', 'workspace.delete', 'workspace.insertBefore',
  'workspace.insertSessionBefore', 'workspace.list', 'workspace.rename',
  // 特殊端点 (由 toFetchHandler 特殊处理, 同样需要会话)
  'session.export', 'events.mux', 'events.host', 'respond',
];

/* ------------------------------------------------------------------ */
/* 静态页面与脚本                                                        */
/* ------------------------------------------------------------------ */
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 登录</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#1a1d27;padding:40px;border-radius:12px;width:320px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 24px;text-align:center}
label{display:block;margin:12px 0 6px;font-size:14px;color:#9aa0b5}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #333;border-radius:6px;background:#14161f;color:#fff;font-size:15px}
button{width:100%;margin-top:24px;padding:11px;background:#4f6ef2;border:none;border-radius:6px;color:#fff;font-size:15px;cursor:pointer}
</style></head><body><div class="card">
<h1>DSH 登录</h1>
<form method="post" action="/login">
<label>用户名</label><input name="username" autocomplete="username" required>
<label>密码</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">登 录</button>
</form>
</div></body></html>`;

const AUTH_SCRIPT = `<script>
(function () {
  if (location.pathname === '/login') return;
  try {
    fetch('/api/auth-check', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.authenticated !== true) location.replace('/login');
      })
      .catch(function () {});
  } catch (e) {}
})();
</script>`;

/* ------------------------------------------------------------------ */
/* 插件本体                                                             */
/* ------------------------------------------------------------------ */
export const inject = ['webServer', 'apiProxy'];

export function apply(ctx, config) {
  const username = config?.username ?? 'admin';
  const password = config?.password;
  if (!password) {
    throw new Error('[dsh-auth-session] config.password is required');
  }
  const sessionDays = config?.sessionDays ?? 30;
  const cookieName = config?.cookieName ?? 'dsh_session';
  const maxAge = sessionDays * 86400;
  const trustedHosts = config?.trustedHosts ?? [];
  const secret = loadSecret(config?.secretFile ?? fileURLToPath(new URL('../auth-secret.txt', import.meta.url)));
  const limiter = createRateLimiter(config?.rateLimitMax ?? 8, 60);

  const isAuthed = (req) =>
    parseToken(secret, tokenFromCookieHeader(headerValue(req.headers, 'cookie'), cookieName)) !== null;

  const json = (res, body, status = 200) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': payload.length,
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const clientIp = (req) => {
    const fwd = headerValue(req.headers, 'x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress ?? 'local';
  };

  // ---- 1. GET /api/auth-check ----
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/auth-check',
      handler: async (req, res) => {
        json(res, { authenticated: isAuthed(req) });
      },
    }),
    'dsh-auth-session: /api/auth-check',
  );

  // ---- 2. /login (GET 登录页 / POST 登录) ----
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/login',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const body = Buffer.from(LOGIN_HTML, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
          res.end(body);
          return;
        }
        if (req.method === 'POST') {
          if (limiter(clientIp(req))) {
            json(res, { ok: false, error: 'too-many-attempts' }, 429);
            return;
          }
          let raw = '';
          try {
            for await (const chunk of req) raw += chunk;
          } catch (_) { /* ignore */ }
          const params = new URLSearchParams(raw);
          const u = params.get('username') ?? '';
          const p = params.get('password') ?? '';
          if (safeEqual(u, username) && safeEqual(p, password)) {
            const exp = Math.floor(Date.now() / 1000) + maxAge;
            const token = makeToken(secret, u, exp);
            res.writeHead(302, {
              location: '/',
              'set-cookie': sessionCookieHeader(cookieName, token, maxAge, true),
            });
            res.end();
          } else {
            json(res, { ok: false, error: 'bad-credentials' }, 401);
          }
          return;
        }
        res.writeHead(405);
        res.end();
      },
    }),
    'dsh-auth-session: /login',
  );

  // ---- 3. tapIndex: index.html 注入认证检查 ----
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => html.replace('</head>', AUTH_SCRIPT + '</head>')),
    'dsh-auth-session: index tap',
  );

  // ---- 4. 按域前缀路由: 围栏 + 会话门 + 桥接 apiProxy ----
  const gateHandler = async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname;
    const method = pathname.startsWith('/api/') ? pathname.slice(5) : undefined;

    // ① 浏览器信任围栏 (特权方法额外要求 loopback)
    if (method !== undefined && PRIVILEGED_METHODS.has(method)) {
      if (!isTrustedApiRequest(req, [])) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
    } else if (!isTrustedApiRequest(req, trustedHosts)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    // ② 会话门
    if (!isAuthed(req)) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'login required' } }));
      return;
    }

    // ③ 桥接回原始 RPC 链: 优先复用 client-connection 的共享 fetch handler
    //    (typert 端点 → api-gateway dispatchRpc; 其余 → apiProxy), 与 DSH
    //    原生 /api 路由保持同一分诊逻辑; connection 不可用时退化为直接
    //    桥接 apiProxy (旧行为, 仅保底)。
    const body = req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await (async () => {
          const chunks = [];
          let total = 0;
          const cap = 160 * 1024 * 1024;
          for await (const chunk of req) {
            total += chunk.length;
            if (total > cap) throw new Error('request body too large');
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        })();

    const request = new Request(`http://dsh.local${req.url ?? '/'}`, {
      method: req.method,
      headers: (() => {
        const h = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') h[k] = v;
        }
        return h;
      })(),
      ...(body === undefined ? {} : { body }),
    });

    const api = ctx.get('apiProxy');
    if (api === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const fallbackFetch = { fetch: (request) => toFetchHandler(api).fetch(request) };
    const connection = ctx.get('connection');
    const dispatcher = connection !== undefined && typeof connection.createSharedFetchHandler === 'function'
      ? connection.createSharedFetchHandler('/api', fallbackFetch)
      : fallbackFetch;
    try {
      const response = await dispatcher.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body !== null) {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      res.writeHead(500);
      res.end(`handler failure: ${String(error)}`);
    }
  };

  /** 收集需要门禁的路径并注册路由 (exact 点分端点 + 前缀 typert 命名空间) */
  const registerExactGate = (path) => {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler: gateHandler }),
      `dsh-auth-session: gate ${path}`,
    );
  };
  const registerPrefixGate = (path) => {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path, handler: gateHandler }),
      `dsh-auth-session: gate ${path}`,
    );
  };

  // ① 点分端点 (apiProxy unary + 特殊端点)
  const gated = new Set();
  for (const ep of [...DOT_ENDPOINTS, ...(config?.extraEndpoints ?? [])]) {
    if (!/^[A-Za-z0-9._/-]+$/.test(ep)) continue;
    if (gated.has(ep)) continue;
    gated.add(ep);
    registerExactGate(`/api/${ep}`);
  }

  // ② typert 命名空间 (动态枚举, 覆盖所有 Remote 端点域)
  ctx.inject(['typert'], (typertCtx) => {
    const local = typertCtx.typert?.local;
    if (!local) return;
    try {
      const descriptors = typeof local.list === 'function' ? local.list() : [];
      const namespaces = new Set();
      for (const descriptor of descriptors) {
        const endpoint = descriptor?.namespace !== undefined && descriptor?.method !== undefined
          ? `${descriptor.namespace}/${descriptor.method}`
          : descriptor?.id;
        if (typeof endpoint === 'string') {
          const ns = endpoint.split('/')[0];
          if (ns) namespaces.add(ns);
        }
      }
      for (const ns of namespaces) {
        if (!/^[A-Za-z0-9._-]+$/.test(ns)) continue;
        if (gated.has(`ns:${ns}`)) continue;
        gated.add(`ns:${ns}`);
        registerPrefixGate(`/api/${ns}`);
      }
    } catch (_) { /* 枚举失败不阻塞插件 */ }
  });
}
