# dsh-plugins 工作区

DeepSeek Harness (DSH) 第三方插件开发工作区。

## 目录

| 包 | 说明 | 状态 |
|---|---|---|
| [dsh-auth-session](./dsh-auth-session) | DSH Web GUI 登录认证插件（Cookie 会话登录） | ✅ 已发布 npm@0.1.1 + GitHub |

## 环境

- DSH 安装位置: `D:\environment\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\`
- DSH_HOME: `C:\Users\hebin\.dsh`（profiles: web / first）
- Node: v24 / npm 11 / pnpm 可用 / git 已配置

## 工作流

1. 开发（`dsh-auth-session/`）
2. 测试: `node dsh-auth-session/test/auth-core.test.mjs` + `node dsh-auth-session/test/harness.test.mjs`
3. 发布: `cd dsh-auth-session && npm publish`（需先 `npm adduser`）
4. 用户安装: `dsh plugin --profile web add dsh-auth-session` → 重启 `dsh web`

## 插件安装机制备忘

- 插件包需声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 才会被
  `dsh plugin add` 自动加入 `dsh.profile.bundles`
- `cordis.patch.yml` 里 `- insert: [{id, name}]` 注入插件行
- 客户端插件声明: package.json 的 `dsh.client.platform: "web"` + `exports["./client"]`
- 验证: `dsh --profile web --dump-config`（无需重启）
