/**
 * 回归测试: 模拟浏览器加载 lib/client.js (window.__ModuleLoader__.load)
 *
 * 背景: v0.1.0 的 client.js 在 factory 里直接用了 module.exports, 但 DSH 的
 * 客户端加载器只注入 require, 不提供全局 module —— 浏览器端执行时报
 * "module is not defined", 导致 DSH 启动失败。本测试用最小 ModuleLoader
 * 模拟执行 client.js, 拦截这类加载期错误。
 *
 * 运行: node test/client-load.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let registered = null;
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry;
    },
  },
};
// 浏览器全局: document / location / fetch 在 apply 时才用到, 加载期不需要,
// 但 factory 内可能引用, 补最小桩
const sandbox = {
  window: windowStub,
  document: {
    readyState: 'complete',
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
    body: { appendChild() {} },
  },
  location: { pathname: '/' },
  fetch: async () => ({ json: async () => ({ authenticated: false }) }),
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

// 1. 注册成功
assert.ok(registered, 'client.js 应调用 window.__ModuleLoader__.load 注册');
assert.strictEqual(registered.id, 'dsh-auth-session');

// 2. factory 可执行且导出 apply (模拟加载器调用 factory)
const moduleShim = { exports: {} };
const factory = registered.factory;
// 注意: factory 内部自己声明了 module/exports 垫片, 我们传入 require 桩即可
const result = factory(() => { throw new Error('此 bundle 不应 require 外部模块'); });
assert.ok(result && typeof result.apply === 'function', 'factory 应导出 apply 函数');
assert.strictEqual(result.apply, result.apply);

// 3. apply 可调用且不抛错 (未登录场景: 会挂载遮罩到 document)
const ctxStub = {
  effect(fn) { const d = fn(); return d; },
  on() {},
  get() { return undefined; },
};
let overlayAdded = false;
sandbox.document.body.appendChild = () => { overlayAdded = true; };
sandbox.document.getElementById = () => null; // 无已存在遮罩
sandbox.document.createElement = () => ({
  id: '', style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
});
result.apply(ctxStub);
await new Promise((r) => setTimeout(r, 20));
assert.ok(overlayAdded, '未登录时应挂载登录遮罩(appendChild到body)');

console.log('✓ 回归测试通过: client.js 可在模拟 ModuleLoader 环境加载并导出 apply');
