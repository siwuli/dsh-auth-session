# dsh-auth-session

[![npm version](https://img.shields.io/npm/v/dsh-auth-session)](https://www.npmjs.com/package/dsh-auth-session)
[![npm downloads](https://img.shields.io/npm/dm/dsh-auth-session)](https://www.npmjs.com/package/dsh-auth-session)
[![license](https://img.shields.io/npm/l/dsh-auth-session)](https://github.com/siwuli/dsh-auth-session)

DSH (DeepSeek Harness) Web GUI **登录认证插件**：Cookie 会话登录，让 DSH 通过反向代理暴露到公网时也有自己的登录保护。

- 📦 npm: [dsh-auth-session](https://www.npmjs.com/package/dsh-auth-session)
- 🐙 GitHub: [siwuli/dsh-auth-session](https://github.com/siwuli/dsh-auth-session)

## 解决的问题

DSH Web GUI 本身没有用户认证（面向本机 localhost 使用）。通过 Caddy/Nginx 反代暴露到公网后，此前只能靠代理层加 HTTP Basic 认证——而 Basic 认证在 **iOS 浏览器(WebKit)的 WebSocket 连接上不会附带凭据**，导致 DSH 界面反复弹出登录框。

本插件把认证做进 DSH 内部，用 **Cookie 会话**（浏览器自动携带，包括 WebSocket/SSE）：

- 访问页面 → 未登录自动跳转登录页（或显示全屏登录遮罩）
- 登录一次 → 签发签名 Cookie（默认 30 天）→ 之后所有请求免登录
- `/api` 全部 RPC 端点受会话门保护（未登录返回 401）
- 浏览器信任围栏保留（防 DNS rebinding / 跨站请求）

## 架构

```
浏览器
  │ ① 加载页面 → 注入的脚本检查 /api/auth-check
  │ ② 未登录 → 显示登录页(/login) 或客户端遮罩
  │ ③ POST /login → 校验凭据 → 种签名Cookie → 302 /
  │ ④ 后续请求(页面/API/SSE)自动携带Cookie → 会话门放行
  ▼
DSH 宿主端插件 (dsh-auth-session)
  ├─ exact 路由: /api/auth-check (状态检查)
  ├─ exact 路由: /login (登录页 + 登录提交)
  ├─ tapIndex: index.html 注入认证检查脚本
  ├─ exact 路由: /api/<端点>  (点分端点, 来自 apiProxy 的 UNARY_ROUTES)
  ├─ prefix 路由: /api/<命名空间> (typert Remote 端点, 动态枚举)
  └─ 桥接: 已登录请求交回 client-connection 的共享 RPC 链
     (createSharedFetchHandler: typert 端点 → api-gateway dispatchRpc,
      点分端点 → apiProxy toFetchHandler)
```

## 配置 (cordis patch)

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中覆盖（`id` 需与安装一致）：

```yaml
- id: auth-session
  config:
    username: admin
    password: '你的强密码'        # 必填
    sessionDays: 30
    cookieName: dsh_session
    rateLimitMax: 8
    # extraEndpoints: ['your/endpoint']   # 第三方插件新增的 /api 端点
```

## 已知边界（设计取舍）

1. **WebSocket 升级**（`/api/events.*` 的 Upgrade 请求）走 `registerUpgrade` 表，与 HTTP 路由分离，无法被本插件拦截；事件流为**只读**，其 SSE GET 形式受会话门保护，WS 升级保持 DSH 原行为。
2. **`/api` 拦截器座位**（`connection.rpc.intercept`）全局唯一且已被 `dsh-api-gateway` 占用（禁用它会导致 Remote API 失效），故本插件采用"**更长前缀 + 精确路由**"方案覆盖 `/api`（webserver 匹配规则：exact 优先，其次最长前缀）。
3. **第三方插件新增的 `/api/<新端点>`**：若不在上述两类枚举内，需在 `extraEndpoints` 配置补充。
4. 登录页表单提交 → 302，重定向由插件自身处理（无需代理层配合）。

## 版本历史

- **v0.1.3** (2026-08-18): 🐛 修复 typert Remote 端点被 404 的桥接缺陷。旧版把认证后的请求一律桥接给 `apiProxy`（只认点分端点），导致 `pluginInventory/list`（设置页插件列表）、`goal.list`、`typert.registry.list` 等 `namespace/method` 形式的端点全部 404。现改为复用 client-connection 的 `createSharedFetchHandler`，typert 端点走 `api-gateway` 的 `dispatchRpc`，点分端点回退 `apiProxy`，与 DSH 原生 `/api` 路由行为一致。新增回归测试 6b 覆盖插件列表端点。
- **v0.1.2** (2026-08-18): 🐛 修复会话密钥文件路径在 Windows 下用 `fileURLToPath`（持久化，重启不失效）；新增客户端加载回归测试。
- **v0.1.1** (2026-08-18): ✨ 首次发布（Cookie 会话登录、`/api` 门禁、限速、信任围栏、登录页）。

## 开发与测试

```sh
# 单元测试 (会话令牌/限速)
node test/auth-core.test.mjs
# 模拟集成测试 (在模拟 DSH webServer 环境验证完整登录流程)
node test/harness.test.mjs
# 全部
npm test
```

## 发布与安装

✅ **已发布**: `dsh-auth-session@0.1.3` (2026-08-18, npm + GitHub)

```sh
# 用户安装 (npm 已发布)
dsh plugin --profile <profile名> add dsh-auth-session
# 本地开发可先用 link: 或 file: 路径, 免发布
dsh plugin --profile <profile名> add link:<插件源码绝对路径>

# 验证组合树 (无需重启)
dsh --profile <profile名> --dump-config

# 配置密码: 编辑 ~/.dsh/profiles/<profile名>/cordis.patch.yml
#   - id: auth-session
#     config:
#       password: '你的强密码'

# 重启 dsh web 生效
```

### 发布新版本

```sh
# 1. 更新 version (package.json), 提交并推送 GitHub
npm version patch
git add -A && git commit -m "v0.1.1"

# 2. 推送 GitHub (工作区仓库, 插件在子目录时用 subtree)
git subtree split -P dsh-auth-session -b plugin-split
git push origin plugin-split:main
git branch -D plugin-split

# 3. 发布 npm (令牌已在 npm 配置中)
cd dsh-auth-session
npm publish
```
