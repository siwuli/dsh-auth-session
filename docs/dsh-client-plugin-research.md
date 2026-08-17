# DSH Web GUI 客户端插件机制研究报告

> 研究基于 DSH 安装目录 `node_modules\@deepseek-ai\` 下各包的 `lib/` 编译产物逐行核实
> （版本 0.1.0-rc.7 / cordis 4.0.1）。本文件是子代理研究报告的完整存档。

## ① 客户端插件最小包结构

- 声明"客户端插件" = `package.json` 的 `dsh.client` 字段（`platform: "web"` 必填，
  `inject` 为依赖的 peer 包名数组，`immediately` 可选布尔）。无 cordis.yml。
- client 入口 = `exports["./client"]` → `lib/client.js`（tsdown 编译产物）。
- 产物格式：`window.__ModuleLoader__.load({id, factory})`，模块导出 `{apply, inject}`。

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-message-feedback",
  "type": "module",
  "exports": {
    ".":        "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "…"] } }
}
```

## ② 加载链（三段分工）

1. **编译**：包自己的 tsdown 把 `src/client/` 打成 `lib/client.js`。
2. **服务**：`dsh-client-modules` 的 node half 扫描声明 `dsh.client` 的包，
   `rev = sha1(内容).slice(0,12)` 作缓存破坏参数，服务 `/plugins/<id>/client.js?rev=…`；
   经 `tapIndex` 把 `window.__DSH_BOOT__` 注入 index.html `<head>` 最前。
3. **注册**：`dsh-client-web` 的 AppWebEntry 两阶段 boot —— 解析 `__DSH_BOOT__` →
   `ClientModuleSystem`（静态模块表 10 个平台词：react、react-dom、
   @deepseek-ai/cordis、dsh-client-ui-slots、dsh-client-web-react、
   dsh-client-ui-primitives 等）→ vendored cordis Loader → 按图建 fiber → `apply(ctx)`。
4. **HMR**：`dsh-client-hmr` 经 SSE `/plugins/events` 收 `rebuilt` 帧 → 热换 fiber
   （改 client 插件无需刷新页面，需 `pnpm run dev:web` 在跑）。

## ③ UI 挂载 API（Slot 系统）

- `ctx.slots.register(options, component)`：`{name, key|id|order, inject, children…}`
- `ctx.slots.inject(key, cb)`：等 slot 声明后运行
- `ctx.slots.renderSlot("root", owner)`：ctx 级唯一渲染入口
- 4 种 kind：single / keyed / list / chain；3 种 scope：root / session / session-maybe
- React 标准 kit props：`useSessions`、`t`、`useStore`、`renderSlot`、
  `SessionProvider`、`useSession`、`useProjection` 等

## ④ 全屏/登录阻断的现成模式

1. **`shell.overlay` slot**（AppFrame 预留，kind list / scope root）：z-index:20 全屏
   覆盖层，当前无任何 shipped 插件占用 —— 登录页可直接注册。
2. **OnboardingSurface**（`dsh-client-ui-primitives`）：body portal + `#root.inert =
   true` 阻断式 —— "登录页阻断 UI"最贴切先例。**本项目 client 采用此方式。**
3. `Modal` / `RiskConfirmation`：body portal 模态框。

## ⑤ 客户端 ↔ 服务端通信

- `ctx.connection.rpc.call(channel, endpoint, payload, signal)`：POST 信封
  `{type:"client-request", rpcId, method, payload}` → `{rpcId, result}`
- `ctx.connection.api`：类型化 API client（sessions/workspace/host/…）
- `ctx.remote.<ns>.<method>(args)`：TYPERT Remote（→ rpc.call）
- 事件：宿主经 SSE host 流推 `host/remote-event` → `ctx.remote.$on(event, listener)`
- `ctx.emit("connection/reset")`：连接重建立时触发

## 参考示例包路径

`node_modules\@deepseek-ai\` 下：
- 最小 client 插件：`dsh-client-ui-message-feedback\`
- __DSH_BOOT__ 组合/服务：`dsh-client-modules\lib\index.js`
- 两阶段 boot：`dsh-client-web\lib\index.js`
- React 渲染约定：`dsh-client-web-react\lib\index.js`
- SlotRegistry：`dsh-client-runtime\lib\client.js`
- AppFrame + shell.overlay：`dsh-client-ui-layout\lib\client.js`
- 阻断/模态先例：`dsh-client-ui-primitives\lib\index.js`
- ctx.connection + rpc.call：`dsh-client-connection\lib\client.js`
