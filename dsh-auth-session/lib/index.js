/**
 * dsh-auth-session — 宿主端 (Host) 插件入口
 *
 * 功能:
 *  - 拦截 /api 通道, 未携带有效会话Cookie的请求返回401/302
 *  - 提供 auth.login / auth.status / auth.logout 三个RPC端点
 *  - 登录成功后签发签名Cookie会话 (30天)
 *  - 每IP限速防止暴力破解
 *
 * 安装后: 通过反向代理暴露 DSH 时, 由本插件提供登录保护,
 * 无需在代理层(Caddy等)再配认证。
 */

'use strict';

const {
  loadSecret,
  makeToken,
  parseToken,
  tokenFromCookieHeader,
  sessionCookieHeader,
  safeEqual,
  createRateLimiter,
} = require('./auth-core');

/** 登录页 HTML (自包含, 无外部资源) */
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 登录</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#1a1d27;padding:40px;border-radius:12px;width:320px}
h1{font-size:20px;margin:0 0 24px;text-align:center}
label{display:block;margin:12px 0 6px;font-size:14px;color:#9aa0b5}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #333;border-radius:6px;background:#14161f;color:#fff;font-size:15px}
button{width:100%;margin-top:24px;padding:11px;background:#4f6ef2;border:none;border-radius:6px;color:#fff;font-size:15px;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:12px;text-align:center}
</style></head><body><div class="card">
<h1>DSH 登录</h1>
<form method="post" action="/api/auth.login">
<label>用户名</label><input name="username" autocomplete="username" required>
<label>密码</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">登 录</button>
</form>
<div class="err" id="err"></div>
</div></body></html>`;

/** 默认插件导出: Cordis 插件 */
function apply(ctx, config) {
  const username = config?.username ?? 'admin';
  const password = config?.password;
  if (!password) {
    throw new Error('[dsh-auth-session] config.password is required');
  }
  const sessionDays = config?.sessionDays ?? 30;
  const cookieName = config?.cookieName ?? 'dsh_session';
  const maxAge = sessionDays * 86400;
  const secret = loadSecret(config?.secretFile);
  const limiter = createRateLimiter(config?.rateLimitMax ?? 8, 60);

  const isAuthed = (request) => {
    const token = tokenFromCookieHeader(request.headers.get('cookie'), cookieName);
    return parseToken(secret, token) !== null;
  };

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const redirect = (location) =>
    new Response(null, { status: 302, headers: { location } });

  const loginPage = (status = 200) =>
    new Response(LOGIN_HTML, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  /**
   * /api 拦截器: 认证检查 + auth.* 端点
   * 未匹配到拦截器(即无 interceptor 认领)的端点仍走原 apiProxy 回退
   */
  const authEndpoints = new Set(['auth.login', 'auth.status', 'auth.logout']);

  const interceptorHandler = {
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const endpoint = pathname.startsWith('/api/') ? pathname.slice(5) : pathname.slice(1);

      // ---- 认证相关端点 ----
      if (endpoint === 'auth.status') {
        return json({ ok: true, authenticated: isAuthed(request) });
      }
      if (endpoint === 'auth.logout') {
        return new Response(null, {
          status: 200,
          headers: {
            'set-cookie': `${cookieName}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
          },
        });
      }
      if (endpoint === 'auth.login') {
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || 'local';
        if (limiter(ip)) {
          return json({ ok: false, error: 'too-many-attempts' }, 429);
        }
        let bodyText = '';
        try { bodyText = await request.text(); } catch (_) { /* ignore */ }
        const params = new URLSearchParams(bodyText);
        const u = params.get('username') || '';
        const p = params.get('password') || '';
        if (safeEqual(u, username) && safeEqual(p, password)) {
          const exp = Math.floor(Date.now() / 1000) + maxAge;
          const token = makeToken(secret, u, exp);
          return new Response(null, {
            status: 302,
            headers: {
              location: '/',
              'set-cookie': sessionCookieHeader(cookieName, token, maxAge, true),
            },
          });
        }
        return json({ ok: false, error: 'bad-credentials' }, 401);
      }

      // ---- 其它端点: 需要会话 ----
      if (!isAuthed(request)) {
        // API 请求: 返回401 (客户端可识别); 页面请求: 302跳登录
        const accept = request.headers.get('accept') || '';
        if (accept.includes('text/html')) return redirect('/login');
        return json({ ok: false, error: 'unauthorized' }, 401);
      }

      // 会话有效: 委托给真正的 API 代理
      const apiProxy = ctx.get('apiProxy');
      if (apiProxy === undefined) return json({ ok: false, error: 'no-api-proxy' }, 404);
      return toFetchHandler(apiProxy).fetch(request);
    },
  };

  // 注册 /api 拦截器 (认领全部端点, 未登录的请求在此拦截)
  const connection = ctx.get('connection');
  if (connection?.rpc?.intercept) {
    ctx.effect(
      () => connection.rpc.intercept('/api', () => true, interceptorHandler, { authority: 'trusted' }),
      'dsh-auth-session: /api auth interceptor',
    );
  }

  // 登录页路由 (GET /login)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/login',
      handler: async (req, res) => {
        const body = Buffer.from(LOGIN_HTML, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        res.end(body);
      },
    }),
    'dsh-auth-session: /login route',
  );
}

module.exports = { apply };
module.exports.default = apply;
