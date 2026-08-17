# dsh-plugins 工作区

DeepSeek Harness (DSH) 第三方插件开发工作区。

## 目录

| 包 | 说明 | 状态 |
|---|---|---|
| [dsh-auth-session](./dsh-auth-session) | DSH Web GUI 登录认证插件（Cookie 会话登录） | 开发中 |

## 环境

- DSH 安装位置: `D:\environment\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\`
- Node: v24 (DSH 自带 node)
- 插件系统: Cordis 服务插件（宿主端 + 客户端双面）

## 工作流

1. 开发（`dsh-auth-session/`）
2. 单元测试: `node dsh-auth-session/test/auth-core.test.js`
3. 发布: `git` + `npm`（发布命令见各包 README）
4. 用户安装: `dsh plugin --profile web add <包名>`
