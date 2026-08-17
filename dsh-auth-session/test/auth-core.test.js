'use strict';
/* auth-core 单元测试: node test/auth-core.test.js */
const assert = require('assert');
const {
  makeToken, parseToken, tokenFromCookieHeader,
  sessionCookieHeader, safeEqual, createRateLimiter,
} = require('../lib/auth-core');

const SECRET = 'test-secret-1234567890';

// 1. 生成->解析 往返
const exp = Math.floor(Date.now() / 1000) + 3600;
const tok = makeToken(SECRET, 'admin', exp);
assert.strictEqual(parseToken(SECRET, tok), 'admin', '合法token应解析出用户名');

// 2. 过期令牌
const old = makeToken(SECRET, 'admin', Math.floor(Date.now() / 1000) - 10);
assert.strictEqual(parseToken(SECRET, old), null, '过期token应无效');

// 3. 错误密钥
assert.strictEqual(parseToken('wrong-secret', tok), null, '错误密钥应无效');

// 4. 篡改载荷
const parts = tok.split('.');
const tampered = Buffer.from(JSON.stringify({ u: 'attacker', e: exp })).toString('base64url') + '.' + parts[1];
assert.strictEqual(parseToken(SECRET, tampered), null, '篡改载荷应无效');

// 5. 伪造签名
assert.strictEqual(parseToken(SECRET, parts[0] + '.' + 'f'.repeat(64)), null, '伪造签名应无效');

// 6. 垃圾输入
assert.strictEqual(parseToken(SECRET, null), null);
assert.strictEqual(parseToken(SECRET, ''), null);
assert.strictEqual(parseToken(SECRET, 'no-dot'), null);
assert.strictEqual(parseToken(SECRET, 'YWJj.zzzz'), null);

// 7. Cookie 提取
const cookieHeader = 'other=x; dsh_session=' + tok + '; foo=1';
assert.strictEqual(tokenFromCookieHeader(cookieHeader, 'dsh_session'), tok);
assert.strictEqual(tokenFromCookieHeader(null, 'dsh_session'), null);
assert.strictEqual(tokenFromCookieHeader('a=b', 'dsh_session'), null);

// 8. Set-Cookie 构造
const sc = sessionCookieHeader('dsh_session', tok, 2592000, true);
assert.ok(sc.includes('HttpOnly') && sc.includes('Secure') && sc.includes('SameSite=Lax'), 'cookie属性齐全');

// 9. 常量时间比较
assert.ok(safeEqual('abc', 'abc'));
assert.ok(!safeEqual('abc', 'abd'));
assert.ok(!safeEqual('abc', 'abcd'));

// 10. 限速器
const limiter = createRateLimiter(3, 60);
assert.ok(!limiter('1.2.3.4'));
assert.ok(!limiter('1.2.3.4'));
assert.ok(!limiter('1.2.3.4'));
assert.ok(limiter('1.2.3.4'), '第4次应被限制');
assert.ok(!limiter('5.6.7.8'), '不同IP不受影响');

console.log('✓ 全部 10 组测试通过 (auth-core)');
