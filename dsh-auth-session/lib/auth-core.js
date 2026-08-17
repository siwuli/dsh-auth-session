/**
 * dsh-auth-session 核心认证逻辑 (纯函数, 无依赖, ESM)
 *
 * 会话令牌格式: <base64url(json{u,exp})>.<hmac-sha256-hex(secret, base64url串)>
 * 设计: 签名基于 base64url 载荷字符串本身, 解析时用同一规则校验。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 生成/读取会话密钥 (首次调用生成, 之后从 secretFile 读取) */
export function loadSecret(secretFile) {
  try {
    if (fs.existsSync(secretFile)) {
      const s = fs.readFileSync(secretFile, 'utf8').trim();
      if (s) return s;
    }
  } catch (_) { /* ignore */ }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, fresh, 'utf8');
  } catch (_) { /* ignore */ }
  return fresh;
}

/** 对 payload 字节做 HMAC-SHA256, 返回 hex 签名 */
export function sign(secret, payloadBytes) {
  return crypto.createHmac('sha256', secret).update(payloadBytes).digest('hex');
}

/** 生成会话令牌 */
export function makeToken(secret, user, expiresAtUnixSeconds) {
  const payload = Buffer.from(JSON.stringify({ u: user, e: expiresAtUnixSeconds }), 'utf8')
    .toString('base64url');
  return payload + '.' + sign(secret, Buffer.from(payload, 'ascii'));
}

/**
 * 校验会话令牌
 * @returns {string|null} 合法返回用户名, 否则 null
 */
export function parseToken(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(secret, Buffer.from(payloadB64, 'ascii'));
  if (payloadB64.length === 0 || sig.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(sig, 'ascii'), Buffer.from(expected, 'ascii'))) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!data || typeof data.e !== 'number' || data.e < Math.floor(Date.now() / 1000)) return null;
  return typeof data.u === 'string' ? data.u : null;
}

/** 从 Cookie 请求头里提取会话令牌 */
export function tokenFromCookieHeader(cookieHeader, cookieName) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const p = part.trim();
    if (p.startsWith(cookieName + '=')) {
      return p.slice(cookieName.length + 1);
    }
  }
  return null;
}

/** 构造 Set-Cookie 响应头值 */
export function sessionCookieHeader(cookieName, token, maxAgeSeconds, secure) {
  return `${cookieName}=${token}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** 常量时间字符串比较 (用于密码校验) */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 简单的每IP登录限速器 (窗口期秒数, 上限次数) */
export function createRateLimiter(maxAttempts, windowSeconds) {
  const hits = new Map();
  return function limited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < windowSeconds * 1000);
    if (list.length >= maxAttempts) return true;
    list.push(now);
    hits.set(ip, list);
    return false;
  };
}
