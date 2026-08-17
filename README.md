# dsh-auth-session

DSH (DeepSeek Harness) Web GUI 登录认证插件。

## 解决的问题

DSH Web GUI 本身没有登录验证（面向本机 localhost 使用）。通过反向代理暴露到
公网后，需要一层认证。本插件提供 **Cookie 会话登录**：

- 首次访问显示登录页，输入用户名密码
- 登录成功后签发签名会话 Cookie（默认 30 天）
- 之后所有请求（页面 / API / WebSocket）自动携带 Cookie，**不再反复弹登录框**
  （解决了 HTTP Basic 认证在 iOS 浏览器 WebSocket 上的已知缺陷）

## 特性

- 宿主端认证：拦截 `/api` 与页面请求，未登录跳转登录页
- 签名会话令牌：HMAC-SHA256，防篡改、防伪造、可过期
- 登录限速：每 IP 每分钟最多 N 次尝试
- 会话密钥持久化（首次自动生成）

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `username` | `admin` | 登录用户名 |
| `password` | 必填 | 登录密码（明文，或配置哈希） |
| `sessionDays` | `30` | 会话有效期（天） |
| `secretFile` | 包目录内 | 签名密钥持久化路径 |
| `cookieName` | `dsh_session` | Cookie 名 |
| `rateLimitMax` | `8` | 每分钟每 IP 最多尝试次数 |

## 开发

```sh
# 单元测试（核心逻辑）
node test/auth-core.test.js
```

## 发布与安装

```sh
# 发布（需 npm 账号）
npm publish

# 用户安装
dsh plugin --profile web add dsh-auth-session
# 然后重启 dsh web
```
