# DeepSeek Harness (DSH) 宿主端插件开发 API 研究报告

> 研究范围：`D:\environment\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 下的编译产物（`lib/*.js` + `lib/types/*.d.ts`）。
> 版本：全部为 `0.1.0-rc.7`（`cordis` 为 `4.0.1`，`cordis-plugin-loader` 为 `1.0.2`）。
> 所有代码片段均为原文件逐行摘录（行号标注），无臆测。

---

## 0. 总览：宿主端插件能碰到的三个扩展点

| 扩展点 | 载体 | 用途 |
|---|---|---|
| `ctx.webServer.register(...)` | `dsh-host-webserver`（`ctx.webServer`） | 注册任意 HTTP 路由（`exact`/`prefix`），handler 是**原始 `node:http` (req,res)**，可读 Cookie、可写任意响应头、可返回 302、可做 SSE。 |
| `ctx.connection.rpc.intercept('/api', ...)` | `dsh-client-connection`（`ctx.connection.rpc`） | 在共享 `/api` 通道上、在 API Proxy 回退**之前**抢占一个 endpoint 前缀；handler 是**解码后的 RPC 形式** `(endpoint, payload, signal) => RpcResult`，**不能**控制 HTTP 状态/头。 |
| Typert Remote（`TypertRemoteService` + `@Remote` + `./typert` 清单） | `dsh-typert-protocol` / `dsh-typert-registry` / `dsh-typert-loader` / `dsh-api-gateway` | 一等公民的"新增 /api 方法"路径：`dsh-api-gateway` 的 interceptor 自动把 `/api/<namespace>/<method>` 派发到你 Service 的方法上。 |

三层的关系：`dsh-client-connection` 独占注册 `prefix /api` 路由 → 请求先过 **browser-trust fence** → 桥接成 Fetch → 交给 `createSharedFetchHandler`（interceptor 优先，未命中回退 `ctx.apiProxy`）→ `dsh-host-apiproxy` 的 `ApiProxyService` 实现全部内置方法（`host.pickDirectory` 等），`dsh-api-gateway` 的 `TypertGatewayService` 是注册在 `/api` 上的那个 interceptor，把 `namespace/method` 派发给 Typert Remote。

---

## 1. `dsh-host-webserver` —— `ctx.webServer` 服务

### 1.1 包形态（package.json 关键字段）

```jsonc
// dsh-host-webserver/package.json
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": ..., "default": "./lib/index.js" }, "./invariant": ..., "./src/*": "./src/*" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-invariants": "^0.1.0-rc.7" }
}
```

`lib/index.js` 只有 217 行：`WebServer extends Service`，默认导出。`constructor` 里 `super(ctx, "webServer")`（lib/index.js:21-38），即注册为 `ctx.webServer`。

### 1.2 完整 API（lib/types/index.d.ts，逐条摘录）

```ts
// dsh-host-webserver/lib/types/index.d.ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;            // 'exact' 逐字匹配 pathname；'prefix' 匹配 p 与 p/<anything>
    path: string;                  // 绝对 pathname，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>; // 拥有完整响应生命周期（可挂起，如 SSE）
}
export interface WebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
export interface Config {
    host: '127.0.0.1' | '0.0.0.0'; // 只允许这两个值（Config 是 z.union，见 lib/index.js:23-26）
    port: number;                  // 0 = 系统分配端口
}
export declare class WebServer extends Service {
    get port(): number;                          // 实际监听端口（port:0 时为 OS 分配值）
    get host(): Config['host'];
    register(route: WebRoute): () => void;       // 返回移除该路由的 disposer；重复 (kind,path) 抛错
    registerUpgrade(route: WebUpgradeRoute): () => void;
    registerFallback(handler: WebRoute['handler']): () => void;  // 全表未命中时的唯一兜底；二次注册抛错
    tapIndex(transform: (html: string) => string): () => void;   // index.html 变换；按注册顺序执行
    [Service.init](): Promise<void>;             // 激活即 listen
    applyIndexTaps(html: string): string;
}
```

### 1.3 路由匹配顺序（lib/index.js:194-203，`match()`）与分发（lib/index.js:104-131）

```
exact 表命中 → 最长 prefix 命中（pathname !== prefix 且 startsWith(prefix + '/')）→ fallback handler → 无 fallback 时 404
```

handler 抛异常时：头部未发出 → `res.writeHead(400)`；头部已发出 → `res.destroy()`；一律 `ctx.logger.warn`，**不会弄死进程**（lib/index.js:121-131）。

### 1.4 用户关心的几个具体问题的答案

- **是否支持 Fetch API 风格**：**不支持**。`register` 的 handler 拿到的是裸 `node:http` 的 `IncomingMessage`/`ServerResponse`（类型即 `import type { IncomingMessage, ServerResponse } from 'node:http'`）。Fetch 风格只存在于 `/api` 桥内部（`bridge()` 把 node 请求转成 `Request`，见 `dsh-client-connection` lib/index.js:38-87）。
- **能否注册中间件/前置钩子**：**没有中间件概念**。路由表就是一个 Map，每个请求只会命中一个 handler；要"前置钩子"只能自己包一层（例如自己注册 `prefix` 路由后转调其他 handler），或者用 `registerFallback` 唯一座位（已被 `dsh-host-frontend-static` 占用，见下）。`tapIndex` 是唯一的"链式"钩子，但只作用于 fallback 渲染 index.html 的场景。
- **能否读取/设置 Cookie**：**可以**。handler 内 `req.headers.cookie` 读取（`IncomingHttpHeaders` 的原始头），`res.setHeader('set-cookie', [...])` / `res.writeHead(200, {'set-cookie': ...})` 写入。仓库内现无任何包使用 cookie（全树 grep `set-cookie|cookie` 无命中），但这是裸 node:http 语义，没有任何限制。
- **能否拦截 "/" 根路径返回自定义页面**：**可以**。注册 `{ kind: 'exact', path: '/' }` 即可——exact 表优先于 prefix 表和 fallback。注意：SPA 的 index.html 由 fallback 座位渲染（`frontend-static`），而 fallback 只有**一个**座位（二次注册抛错 `"webserver: fallback already registered"`，lib/index.js:83），所以不要尝试自己注册第二个 fallback；用 `exact '/'` 或 `tapIndex` 更合适。
- **route.path 语法**：无通配符、无参数段，纯字符串路径。`prefix` 匹配 `p` 与 `p/<anything>`（lib/index.js:199）。
- **listen 失败**（EADDRINUSE 等）：在 `[Service.init]` 抛错 → Loader 组合失败，该 fiber 被 dispose（README.md:9）。
- **配置**：`Config = z.object({ host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(), port: z.natural().max(65535).required() })`（lib/index.js:23-26）。

### 1.5 现实用法示例（哪个插件怎么用）

- `dsh-client-connection`：注册 `{kind:'prefix', path:'/api', handler: 信任围栏+bridge}`（lib/index.js:550-562）。
- `dsh-client-modules`：注册 `{kind:'prefix', path:'/plugins', handler: this.serveBundle}` + `tapIndex(injectBootManifest)`（lib/index.js:158-163）。
- `dsh-client-hmr`：注册 `{kind:'exact', path:'/plugins/events', handler: SSE 推送}`（lib/index.js:133-144）。
- `dsh-host-frontend-static`：`registerFallback(...)` 独占兜底座位，SPA 语义（index.html 回退、403 越界、405 非 GET/HEAD），每个 index 响应过 `applyIndexTaps`（lib/index.js:69-83）。

---

## 2. `dsh-client-connection` —— `/api` 通道与 interceptor

### 2.1 包形态

```jsonc
// dsh-client-connection/package.json
{
  "main": "lib/index.js",
  "exports": { ".": ..., "./client": ..., "./invariant": ..., "./src/*": ... },
  "dsh": { "client": { "inject": [], "platform": "web", "immediately": true } },  // 双面包：node 半 + 浏览器半
  "peerDependencies": { "@deepseek-ai/dsh-invariants": ..., "@deepseek-ai/dsh-host-webserver": ..., "@deepseek-ai/cordis": "^4.0.1" }
}
```

宿主端入口：`export const name = "client-connection"; export const inject = ["webServer"]; export const Config = z.object({ trustedHosts: ..., maxRequestBodyBytes: ... }); export function apply(ctx, config)`（lib/index.js:467-586）。

### 2.2 interceptor 的确切签名（lib/types/rpc.d.ts，原文）

```ts
/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback';
/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler =
    (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>;
/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean;

export interface HostConnectionRpc {
    // 注册一个独占 channel（绝对前缀，如 /rpc）：会自己挂一条 webServer prefix 路由 + 信任围栏
    handle(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>;
    // 在共享 /api 通道上、fallback 之前拦截属于你的 endpoints
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler,
              options: ConnectionRpcHandlerOptions): () => Promise<void>;
}
export interface ConnectionRpcHandlerOptions {
    readonly authority: ConnectionRpcAuthority;   // loopback: 强制 loopback（isTrustedApiRequest(request, [])）
}
```

`ctx.connection` 在 `rpc-host.d.ts` 里声明为 `HostConnectionHandle { rpc: HostConnectionRpc }`。

**关键实现事实**（lib/index.js:259-273 `registerInterceptor`）：

```js
registerInterceptor(owner, channel, matches, handler, options) {
    if (channel !== "/api") throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`);
    const interceptor = { matches, fetchHandler: rpcFetchHandler(channel, handler), options };
    return owner.effect(() => {
        if (this.interceptors.has(channel)) throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`);
        this.interceptors.set(channel, interceptor);
        return () => { this.interceptors.delete(channel); };
    }, `client-connection: ${channel} rpc interceptor`);
}
```

- **`/api` 通道上同时只允许一个 interceptor**（`this.interceptors` 是 `Map<channel, interceptor>`，二次注册抛错）。生产中这个座位被 `dsh-api-gateway` 的 `TypertGatewayService` 占用（见 §3）。
- 匹配与派发（lib/index.js:232-240 `createSharedFetchHandler`）：

```js
createSharedFetchHandler(channel, fallback) {
    return { fetch: (request) => {
        const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
        const interceptor = this.interceptors.get(channel);
        if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint)) return fallback.fetch(request);
        if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, []))
            return Promise.resolve(new Response("forbidden", { status: 403 }));
        return interceptor.fetchHandler.fetch(request);
    } };
}
```

- endpoint 从 pathname 提取：`/api/<endpoint>`，endpoint 段必须匹配 `/^[A-Za-z0-9_$.-]+$/`，禁止空段/`.`/`..`（lib/index.js:310-315）。
- **你的 handler 返回什么**（lib/index.js:275-301 `rpcFetchHandler`）：请求必须是 `POST` + `content-type: application/json`，body 解析成 `clientRequestSchema`（`{type:'client-request', rpcId, method, payload}`，见 `dsh-host-apiproxy/lib/types/api/rpc.schema.d.ts`），`message.method` 必须等于 endpoint，然后调用你的 `handler(endpoint, message.payload, request.signal)`，把返回值包成：

```js
function fullResponse(rpcId, result) {
    const body = { type: "server-response", rpcId, result };   // result 就是你的 RpcResult
    return Response.json(body);
}
```

**因此：interceptor handler 返回的是 `RpcResult<unknown>`（`{ok:true, value}` | `{ok:false, error:{code,message,details}}`），不是 `Response`。**
- ❌ **不能**通过 interceptor 返回 302 重定向；
- ❌ **不能**通过 interceptor 设置 `Set-Cookie` 或任何自定义响应头/状态码；
- HTTP 状态被固定为：403（loopback authority 未过围栏）、404（非 POST / endpoint 不合法）、415（非 JSON）、400（body 非 JSON）、500（handler 抛异常），成功一律 200 + `application/json`。
- 想控制状态/头/重定向/Set-Cookie → 走 `ctx.webServer.register` 注册自己的路由（或 `registerUpgrade` 做 WebSocket），不要用 interceptor。

`RpcResult` 精确形状（`dsh-host-apiproxy/lib/types/api/rpc.d.ts:189-195`）：

```ts
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };
export type RpcError = { [C in RpcErrorCode]: { code: C; message: string; details: RpcErrorDetailsMap[C] } }[RpcErrorCode];
// code 是闭联合（'bad-request'|'cancelled'|'session-not-found'|...|'internal'），details 必填
```

### 2.3 `isTrustedApiRequest` 判定逻辑（lib/index.js:184-198，原文）

```js
function isTrustedApiRequest(request, trustedHosts) {
    const host = header(request.headers, "host");
    if (host === void 0) return false;
    const hostUrl = parseAuthority(host);          // new URL(`http://${authority}`)，失败返回 undefined
    if (hostUrl === void 0) return false;
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
    if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
    const origin = header(request.headers, "origin");
    if (origin === void 0) return true;
    try { return new URL(origin).host === hostUrl.host; }   // 同源比较：origin 的 host 必须等于 Host 头的 host
    catch { return false; }
}
```

辅助函数：
- `isLoopbackHostname`（lib/index.js:100-104）：`localhost`、`[::1]`、或 4 段十进制且第一段为 `127` 且每段 ≤255。
- `isTrustedAuthority`（lib/index.js:171-177）：对每个 `trustedHosts` 条目做 WHATWG 规范化比较；条目带端口 → 精确 `host:port` 匹配；条目无端口 → 该 hostname 任意端口。**这是 DNS-rebinding 防御**（Host 头伪造不了）。
- `assertTrustedAuthority`（lib/index.js:148-152）：配置里的 `trustedHosts` 条目必须是"裸的、规范化的 `host[:port]`"，否则插件加载直接抛错（防 `harness.internal/path`、`user@host`、零填充端口等静默拓宽授权）。

**结论（与你的已知一致并补充细节）**：① Host 必须是 loopback 或 trustedHosts 条目；② `sec-fetch-site: cross-site` 显式拒绝；③ Origin 存在时必须与 Host 同源；④ 无 Origin（纯 HTTP 的图片/导航读）只要 Host 过围栏即放行（README.md:8 说明：明文 HTTP 下浏览器不挂 Origin/Fetch-Metadata，Host 是唯一不可伪装的防线）。

### 2.4 `/api` 的 fallback 与特权方法（lib/index.js:535-549）

fallback 依次做：特权方法集 `PRIVILEGED_METHODS`（`host.pickDirectory`、`host.openPath`、`settings.*`、`credentials.*`、`agentPreset.read/copy/openDocument/remove`、`llm.discoverModels`，见 lib/index.js:504-520）用**空 trustedHosts** 再过一次围栏（即钉死在 loopback）；`GET /api/events.mux|host` 回 426 Upgrade；然后交给 `ctx.apiProxy`（`toFetchHandler(apiProxy)`）。

---

## 3. `dsh-host-apiproxy` 与 `dsh-api-gateway`：/api 方法怎么组织、插件怎么加

### 3.1 `dsh-host-apiproxy`（API 网关实现，`ctx.apiProxy`）

- `ApiProxyService extends Service`（lib/index.js:5529-5585），`static inject = ["agentDefaultModel","agents","attachments","directoryPicker","llm","sessions","subagents","sessionQuery","tools","userQuestions","workspaceRegistry"]`，`static Config = z.object({nativeOpen, sessionExportCompressionLevel, coldBlankProbeMaxBytes})`。构造时 `super(ctx, "apiProxy")`，用 `createApiProxy(ctx, defaults)` 构建整个域对象，再 `this.sessions = api.sessions; ... this.host = api.host; ... this.respond = api.respond.bind(api)`。
- 方法注册 = `UNARY_ROUTES` 大表（lib/index.js:4608-4817），每行 `"session.list": { schema: ..., invoke: (api, r, signal) => api.sessions.list(r) }`。`methodFor(path)` 做查表（:4819-4821）。`handleUnary`（:4855-4871）先 schema 校验 payload，再 invoke，包成 `ServerResponse`。`host.pickDirectory` 一行在 :4677-4680。
- `host.pickDirectory` 的业务实现（:3152-3173）：读 `ctx.directoryPicker.capability()`，`kind !== "native"` 返回 `directory-picker-unavailable`；否则 `ok(request, { path: await capability.pick(signal) })`。**注意**：这个域是"合并式"的——`ApiProxy` 接口注释（api/index.d.ts:19）写明"New client-request domain = one new file pair + one field here + one map row"，即想给内置网关加方法是**改 dsh-host-apiproxy 源码**，不是插件扩展点。
- **该包不注册任何 HTTP 路由**（lib/index.js 注释 :5517-5518："Transport-agnostic by design: this package registers no routes — physical carriers wrap `ctx.apiProxy` themselves"）。它只是 `toFetchHandler(api)`（:4922）这个 Fetch handler 的宿主。
- 导出：`AbstractApiClient`、`InProcessApiClient`、`RpcId`、`createApiProxy`、`toFetchHandler`、`ApiProxyService`；子路径 `./api`（合同层类型+schema，零 Node 依赖，浏览器可导入）。

### 3.2 `dsh-api-gateway`（Typert Remote 网关，`ctx.typertGateway`）

`TypertGatewayService extends Service`（lib/index.js:49-256）：
- `static inject = ["typert"]`；构造时 `super(ctx, "typertGateway")`，然后**把自己注册为 `/api` 的 interceptor**：

```js
ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept("/api",
        (endpoint) => this.claimsEndpoint(endpoint),          // matches
        (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal),  // handler
        { authority: "trusted-host" });                        // options
});
```

- `claimsEndpoint(endpoint)`（:65-71）：`namespace/method` 两段，且在 `ctx.typert.local` 有严格定义 / 见过 / 或 SRC 标记（遍历 `ctx.reflect.props` 里带 `typertRemote` 绑定的 Service，用 `remoteMethods()` 收集）。
- `dispatchRpc`/`invokeRpc`（:114-135）：校验 `payload = { args: {...} }`（恰好一个 args 字段），按描述符解析参数（`source: "json"` 直传 / `source: "lookup"` 走 lookup provider）、可选的 `signal` 取消参数、Context 接收者解析，最后调用 receiver 的方法，结果解码，包装成 `{ok:true, value}` / `rpcFailure(error)`。
- **插件新增 /api 方法的途径（一等路径）** = Typert Remote：
  1. Service 继承 `TypertRemoteService`（`dsh-typert-protocol`，构造时绑定 `this.typertRemote = {service, serviceKey, namespace}`，lib/types/index.js:48-61）；
  2. 方法加 `@Remote('exportName')` 装饰器（lib/types/index.js:62-72）；
  3. 包导出 `./typert`（`typert.host.js`，内含生成器产出的 `TYPERT` 清单：invocations/namespace/method/schema/codec）；
  4. `dsh-typert-loader` 插件自动发现 Loader 条目包的 `exports["./typert"]`，校验后 `ctx.typert.register(manifest)`（lib/index.js:218-327），装载/卸载自动增删；
  5. 于是 `POST /api/<namespace>/<method>` 就由 gateway 派发到你的 Service 方法。
- 完整最小范例就是 `dsh-host-plugin-inventory`（见 §4）和 `dsh-message-feedback`（带 `./typert` + `./remote` 双面）。

### 3.3 其它两条非一等路径（供参考）

- **直接注册 interceptor**：`ctx.connection.rpc.intercept('/api', matches, handler, {authority})` —— 但 `/api` 的 interceptor 座位已被 `dsh-api-gateway` 占用（重复注册抛错），除非你的部署不挂 `dsh-api-gateway`。
- **注册自己的 channel**：`ctx.connection.rpc.handle('/myrpc', handler, {authority})` —— 会自建 `prefix /myrpc` 路由 + 围栏（lib/index.js:241-258）。`assertChannel` 拒绝 `/api`（:330-332）。注意 `handle` 的 handler 同样是 `RpcResult` 形式，不能控制 HTTP 状态。

---

## 4. 最小宿主端插件示例

### 4.1 最简 `apply` 型插件：`dsh-host-frontend-static`（85 行，强烈推荐作为模板）

文件：`dsh-host-frontend-static/lib/index.js`（完整可抄）：

```js
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "frontend-static";            // Cordis 插件名
export const inject = ["webServer"];              // 声明必需服务（数组 = 全部必填）
export const Config = z.object({ distIndex: z.string().required() });  // schemastery 配置 schema

export function apply(ctx, config) {              // apply(ctx, 已校验 config)
    const distIndex = config.distIndex;
    const distRoot = dirname(distIndex);
    const renderIndex = async () => ctx.webServer.applyIndexTaps(await readFile(distIndex, "utf8"));
    ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
        const rawPath = new URL(req.url ?? "/", "http://x").pathname;
        await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex);
    }), "frontend-static: fallback seat");        // ctx.effect(disposer, label) 负责生命周期
}
```

（`serveStatic` 是纯函数：越界 403、命中 index 200、未知扩展名 octet-stream、任何 miss 回退 index.html。）

### 4.2 其它可参考的最小宿主插件

| 包 | 文件 | 形态 | 亮点 |
|---|---|---|---|
| `dsh-host-directory-picker` | `lib/index.js`（44 行） | 抽象 Service | `class DirectoryPicker extends Service { constructor(ctx){ super(ctx,"directoryPicker") } }` + 导出 `DirectoryPickerError` |
| `dsh-host-directory-picker-native` / `-browse` | `lib/index.js` | Service 子类 | `class NativeDirectoryPicker extends DirectoryPicker`，实现 `capability()`；`static Config = z.object({...})` |
| `dsh-host-plugin-inventory` | `lib/index.js`（118 行） | Typert Remote Service | `class PluginInventoryGateway extends TypertRemoteService`，`static inject = ["loader"]`，`@Remote("list") list()`；这是**最小 Typert Remote 宿主插件** |
| `dsh-message-feedback` | `lib/index.js` + `lib/typert.host.js` + `lib/typert.remote-client.js` | 完整双面 Typert 插件 | `extends TypertRemoteService`，`static inject`、`static Config`、`[Service.init]`，`@Remote("list"/"put"/"delete")` |
| `dsh-client-hmr` | `lib/index.js` | apply 型 + 路由 | `inject = ["clientModules","webServer"]`，`webServer.register({kind:'exact', path:'/plugins/events', handler: SSE})` |
| `dsh-client-modules` | `lib/index.js` | Service + 路由 + tapIndex | 构造器里 `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/plugins', ...}))` + `tapIndex` |

### 4.3 `dsh-message-feedback` 的 package.json 关键字段（“完整最小 Typert 宿主插件” 的清单）

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": ..., "./types": ..., "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
    "./src/*": "./src/*", "./package.json": "./package.json"
  },
  "peerDependencies": { "@deepseek-ai/dsh-brand": ..., "@deepseek-ai/dsh-invariants": ..., "@deepseek-ai/dsh-llm": ...,
                        "@deepseek-ai/dsh-storage-domain": ..., "@deepseek-ai/dsh-typert-protocol": ...,
                        "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-session": ..., "@deepseek-ai/dsh-session-persistence": ... },
  "dependencies": { "zod": "^4.4.3", "@deepseek-ai/schemastery": "^3.18.1" }
}
```

`typert.host.js` 顶部即生成器注释 `/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */`，`export const TYPERT = { package, face:'host', schemas, invocations:[{id, service:'messageFeedback', namespace:'messageFeedback', method:'list'|'put'|'delete', invocation:{kind:'direct'}, parameters:[{name:'request', wire:'request', source:'json', codec:{mode:'strict', typeSymbol, schema}}], result:{mode:'strict',...}, sourceLocation}], model:{services:[...]} }`（lib/typert.host.js:98-306）。`dsh-typert-loader` 自动 import 这个清单并 `ctx.typert.register(manifest)`（见 §3.2-4）。

---

## 5. 插件声明的形态（Cordis 约定）

### 5.1 插件 = 函数 / 类 / `{apply}` 对象（cordis/lib/index.js:1526-1537）

```js
resolve(plugin) {
    try {
        if (typeof plugin === "function") return plugin;
        if (isApplicable(plugin)) return plugin.apply;   // isApplicable: object && typeof object.apply === "function"
    } catch {}
}
// plugin(plugin, config) 里：
//   runtime = { name: plugin.name, callback, Config: plugin.Config }
//   fiber = new Fiber(ctx, config, Inject.resolve(plugin.inject), runtime)
```

执行方式（cordis/lib/index.js:1066-1070 `_runner.execute`）：

```js
if (isConstructor(runtime.callback)) {
    const instance = new runtime.callback(this.ctx, this.config);   // 类插件：new Service(ctx, config)
    for (const hook of instance?.[symbols.initHooks] ?? []) hook();
    return instance?.[symbols.init]?.();                             // 然后跑 [Service.init]()（异步）
} else return runtime.callback(this.ctx, this.config);               // 函数插件：apply(ctx, config)
```

### 5.2 约定的静态字段

- `name`：插件名（运行时标识）。
- `inject`：依赖声明，数组（每项必填）或 `name → config` 映射；`@Inject(name, config)` 装饰器可挂在类/方法上（cordis/lib/index.js:1459-1480）。**没有 "optional" 关键字**——`inject` 里列的都是必填；可选服务用 `ctx.get('name')` 运行时读取（返回 `undefined`），DSH 全仓库都这么干：`ctx.get("apiProxy")`（client-connection lib/index.js:546）、`ctx.get("attachments")`（:474）、`ctx.get("agentPresets")`（apiproxy lib/index.js:1784）等。
- `Config`：schemastery（`@deepseek-ai/schemastery`）schema 对象；加载时 `runtime.Config["~standard"].validate(config)`，有 issues 抛 `ValidationError`（cordis/lib/index.js:955-961）。
- `apply(ctx, config)`：`config` 是已按 `Config` 校验/应用默认值后的对象。清理用 `ctx.effect(() => disposer, label)`（DSH 各包的统一写法）。
- `Service` 类：`constructor(ctx, name)` 里 `super(ctx, name)` 自动 `ctx.reflect.provide(name, this)`（cordis/lib/index.js:1769-1783）；`static inject` / `static Config` 同上；实例方法 `[Service.init]()` 在构造后执行；类插件默认导出类即可。

### 5.3 Loader 行（cordis.yml / cordis.patch.yml）形态

`dsh-web-app/cordis.patch.yml` 就是实际生产组合（节选）：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]                       # 行级 inject：在插件自身 inject 之上叠加
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'   # !!js 表达式，config 树求值
    port: !!js ctx.webStartup.port ?? 3080

- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webRuntime]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts

- id: message-feedback
  name: '@deepseek-ai/dsh-message-feedback'
  config:
    maxNoteBytes: 8192
```

- `name` 支持包子路径（`'@deepseek-ai/dsh-web-app/startup'`）；`- insert:` 块批量插入；`disabled: true` 停用；patch 覆盖同 id 行的整个 config。行级 `inject` 会并入 fiber 的依赖映射（loader lib/index.js:699：`Inject.resolve(fiber.entry.options.inject, fiber.inject)`）。
- 模块导出归一化：`unwrapExports`（loader lib/index.js:736-741）`exports = exports.default ?? exports`，兼容 ESM/CJS。

---

## 6. 最小可用宿主端插件骨架（完整可复制）

下面的包注册一条 HTTP 路由（读 Cookie、回 302、可加 Set-Cookie 演示）并注册一个 `/api` RPC endpoint（演示 `RpcResult` 返回与权威选择）。挂到组合里即可（`dsh web --profile ...` 的 cordis.yml 或 patch 加一行 `- id: <id> / name: '<pkg>'`）。

```
my-dsh-host-plugin/
├── package.json
└── lib/index.js
```

**package.json**：

```jsonc
{
  "name": "my-dsh-host-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./src/*": "./src/*", "./package.json": "./package.json" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-host-webserver": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-client-connection": "^0.1.0-rc.7"
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1" }
}
```

**lib/index.js**（apply 型插件；`inject` 里 `webServer`、`connection` 都是必填）：

```js
import z from "@deepseek-ai/schemastery";

export const name = "my-host-plugin";
export const inject = ["webServer", "connection"];       // 声明依赖服务（全必填；可选服务用 ctx.get()）
export const Config = z.object({ greeting: z.string().default("hi") });  // schemastery schema，加载时校验

export function apply(ctx, config) {
  const { greeting } = config;

  // ── 1) 一条裸 HTTP 路由：exact "/hello" —— 原始 node:http 语义 ─────────────
  //    可读 Cookie（req.headers.cookie）、可 302 重定向、可 Set-Cookie、可 SSE。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/hello",
    handler: (req, res) => {
      const cookie = req.headers.cookie ?? "(none)";          // 读 Cookie 头
      res.writeHead(302, {
        location: "/",
        "set-cookie": [`dsh_plugin_greeting=${encodeURIComponent(greeting)}; Path=/`],  // 写 Set-Cookie
      });
      res.end();
      void cookie;                                            // 演示用
    }
  }), "my-host-plugin: /hello route");

  // ── 2) 在共享 /api 通道上抢占一个 endpoint（若部署未挂 dsh-api-gateway）──
  //    handler 返回 RpcResult，不是 Response：不能设状态码/头/302。
  //    authority: "loopback" = 只放行 loopback+同源（围栏用空 trustedHosts 再过一遍）；
  //    "trusted-host" = 放行 loopback + 部署声明的 trustedHosts。
  // 注意：/api 的 interceptor 只有一个座位，生产中已被 dsh-api-gateway 占用；
  // 这条演示路径适合"未挂 gateway 的最小组合"，或改用 ctx.connection.rpc.handle("/myrpc", ...)。
  ctx.effect(() => ctx.connection.rpc.intercept(
    "/api",
    (endpoint) => endpoint === "myPlugin/hello",             // matches：同步判定
    async (endpoint, payload, signal) => {
      void signal;
      const name = (payload && typeof payload === "object" && "name" in payload)
        ? String(payload.name) : "world";
      if (name.length > 100) {
        return { ok: false, error: { code: "bad-request", message: "name too long", details: { issues: [] } } };
      }
      return { ok: true, value: { text: `${greeting}, ${name}!` } };
    },
    { authority: "loopback" }                                // ConnectionRpcHandlerOptions
  ), "my-host-plugin: /api/myPlugin/hello interceptor");
}
```

调用方式：
- 浏览器 `POST http://127.0.0.1:<port>/api/myPlugin/hello`，body `{"type":"client-request","rpcId":"r1","method":"myPlugin/hello","payload":{"name":"DSH"}}`（`clientRequestSchema` 见 `dsh-host-apiproxy/lib/types/api/rpc.schema.d.ts`），响应 `{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"text":"hi, DSH!"}}}`。
- 若已挂 `dsh-api-gateway`，请改用一等路径：`extends TypertRemoteService` + `@Remote("hello")` + `./typert` 清单（照抄 `dsh-host-plugin-inventory` / `dsh-message-feedback`）。

---

## 7. 追加：拦截 /api + 委托 apiProxy 的四个决定性细节

> 场景：宿主端插件想占据 `/api` interceptor 座位，认证自己的端点，把"未认证端点"交给真实 `apiProxy`。

### 7.1 怎么拿到 `ctx.connection.rpc.intercept`（Q1）

**结论：两种写法都行，但推荐在插件上声明 `inject: ["connection"]` 然后直接 `ctx.connection.rpc.intercept(...)`；`ctx.get("connection")?.rpc.intercept` 只是"免 inject 的读"，必须自己保证时序。**

- **直接属性访问要求名字在 fiber 的 inject 里**，否则代理直接抛错（cordis/lib/index.js:675）：

  ```js
  const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
  ```

  插件级 `inject: ["connection", "apiProxy"]` 会让 Cordis **自动等待**这两个服务都 provide 且 ACTIVE 之后才运行你的 `apply(ctx, config)`（fiber 的 epoch 机制：`_refresh` 在任一 inject 未解析时置 `INACTIVE`，服务 provide 时 `notify` → `_checkImpl` → `_reload` → 才执行 `_execute`，见 cordis/lib/index.js:1316-1343、799-851）。所以 apply 里 `ctx.connection` / `ctx.apiProxy` 一定可用。
- `ctx.get(name, strict=true)`（cordis/lib/index.js:762-771）：无 inject 要求，未 provide / provider fiber 非 ACTIVE 时返回 `undefined`。若用 `ctx.get("connection")?.rpc.intercept(...)`，在 connection 尚未提供时拿到 `undefined`，需要自己 defer——那就还是绕回 `ctx.inject(["connection"], cb)`（cordis/lib/index.js:1599-1605，即 `ctx.plugin({inject, apply: cb})`）。
- **所有权细节（重要）**：`HostConnectionService.rpc` getter 捕获 `this.ctx` 作为注册 owner（dsh-client-connection/lib/index.js:219-225）：

  ```js
  get rpc() {
      const owner = this.ctx;
      return {
          handle: (channel, handler, options) => this.register(owner, channel, handler, options),
          intercept: (channel, matches, handler, options) => this.registerInterceptor(owner, channel, matches, handler, options)
      };
  }
  ```

  而 Cordis 的 service 是 traceable proxy：访问 `service.ctx` 时返回**读取方**的上下文（cordis/lib/index.js:123-158，`createTraceable` 里 `if (prop === tracker.property) return ctx`，tracker.property 就是 `'ctx'`）。所以从你的插件里 `ctx.connection.rpc.intercept(...)`，`owner` = **你的 fiber 的 ctx**，interceptor 属于你的插件生命周期，插件卸载自动移除（registerInterceptor 内部就是 `owner.effect(...)`，dsh-client-connection/lib/index.js:266-272）。
- **致命前提**：`/api` 的 interceptor 座位全局唯一——`registerInterceptor` 里 `if (this.interceptors.has(channel)) throw ...already has an interceptor`（dsh-client-connection/lib/index.js:267）。生产组合里这个座位被 `dsh-api-gateway` 占用（base 层 `dsh-base/cordis.patch.yml:36-37` 的 `typert-gateway` 行）。因此：
  - 保留 `dsh-api-gateway` 时，你的 `intercept('/api', ...)` 会抛错、你的插件 fiber FAILED；
  - 要自己坐这个座位，必须在 profile patch 里禁用该行（`- id: typert-gateway\n  disabled: true`），并自行承担 Typert Remote 派发（见 7.2）。

### 7.2 `toFetchHandler` 导出与"转发给 apiProxy"的正确姿势（Q2）

**结论：`toFetchHandler` 确实从 `@deepseek-ai/dsh-host-apiproxy` 根导出**（dsh-host-apiproxy/lib/index.js:5587）：

```js
export { AbstractApiClient, ApiProxyService, ApiProxyService as default, InProcessApiClient, RpcId, createApiProxy, toFetchHandler };
```

`dsh-client-connection` 自己就这么用（lib/index.js:2 与 :548：`import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy"`；`return toFetchHandler(apiProxy).fetch(request)`）。其返回形状 = `{ fetch(request: Request): Promise<Response> }`（即 `FetchHandler` 类型，定义在 dsh-client-connection/lib/types/http-bridge.d.ts:12-19；该类型没有公开子路径导出，TS 里用结构类型或 `typeof fetch` 即可）。

**"委托未认证端点"有三种姿势，按推荐排序：**

1. **不 claim = 自动回退（零代码转发，首选）**。`createSharedFetchHandler` 对 `matches` 返回 false 的请求直接走 fallback（dsh-client-connection/lib/index.js:232-240）：

   ```js
   if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint)) return fallback.fetch(request);
   ```

   fallback 链（lib/index.js:535-549）= 特权方法 loopback 复检 → events 426 → `toFetchHandler(ctx.apiProxy)`。所以你的 `matches` 只 claim 需要认证的端点，其余全部自动落到真实 apiProxy。
2. **claim 后手动转发**（例如"认证通过再放行到 apiProxy"或审计全量）：interceptor handler 是 RPC 形 `(endpoint, payload, signal)`，拿不到原始 Request，需自己重建 envelope 再调 `toFetchHandler(ctx.apiProxy).fetch(...)`，然后取响应里的 `result` 作为你的返回值：

   ```js
   import { toFetchHandler, RpcId } from "@deepseek-ai/dsh-host-apiproxy";
   import { randomUUID } from "node:crypto";

   async (endpoint, payload, signal) => {
       if (!(await authorize(payload))) {
           return { ok: false, error: { code: "bad-request", message: "unauthorized", details: {} } };
       }
       const response = await toFetchHandler(ctx.apiProxy).fetch(new Request(
           new URL(`/api/${endpoint}`, "http://dsh.internal"),
           { method: "POST", headers: { "content-type": "application/json" },
             body: JSON.stringify({ type: "client-request", rpcId: RpcId(randomUUID()), method: endpoint, payload }),
             signal }
       ));
       const body = await response.json();   // { type: "server-response", rpcId, result }
       return body.result;                   // RpcResult<unknown> —— 这就是 interceptor 要求的返回值
   }
   ```

   envelope 必须满足 `clientRequestSchema`（dsh-host-apiproxy/lib/index.js:4109-4114）：`{type:'client-request', rpcId, method, payload}`，且 `method` 必须等于 endpoint（`rpcFetchHandler` 校验，dsh-client-connection/lib/index.js:289-293）。
3. **方法级调用**：`new InProcessApiClient(toFetchHandler(ctx.apiProxy))`（dsh-host-apiproxy 导出）拿到完整类型化客户端，宿主代码里按域直接调 `client.host.pickDirectory(payload, signal)` 等，返回 `RpcResponse`。适合"宿主代码里要调用内置 API"而非"转发浏览器请求"。

**注意**：若禁用 `dsh-api-gateway` 后还想保留 Typert Remote 端点（`messageFeedback/*`、`pluginInventory/*`、`goal/*`、`commands/*` 等），gateway 的 `dispatchRpc(endpoint, payload, signal)` / `invokeRpc(...)` 是**公开方法**（dsh-api-gateway/lib/index.js:114-135），且 `invokeRpc` 直接返回 `RpcResult` 形状——可在你的 interceptor handler 里对 typert 端点 `return ctx.get("typertGateway")?.dispatchRpc(endpoint, payload, signal)` 复刻派发（但此时 typertGateway 服务已随插件禁用而不存在，需自行用 `ctx.typert.local` / `ctx.reflect.props` 复刻 claims 逻辑，工作量不小——所以**默认建议保留 gateway，只在它管不到的端点做认证，或走 7.3 的替代方案**）。

### 7.3 `authority: "trusted-host"` vs `"loopback"` 的后果（Q3）

**结论：会直接影响 `isTrustedApiRequest` 的入参（信任列表），两处实现不同，语义如下。**

interceptor 路径（`createSharedFetchHandler`，dsh-client-connection/lib/index.js:237）：

```js
if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, []))
    return Promise.resolve(new Response("forbidden", { status: 403 }));
```

- `authority: "loopback"` → **额外**用**空信任列表**再跑一次 `isTrustedApiRequest(request, [])`：`trustedHosts` 为空 ⇒ `isTrustedAuthority` 恒 false ⇒ 只有 loopback Host（localhost/[::1]/127/8）且同源/无 cross-site 才放行。即使部署在 `0.0.0.0` 且配置了 trustedHosts，LAN/trusted 客户端也 403。这正是 `PRIVILEGED_METHODS` 的钉死方式（lib/index.js:538 同样传 `[]`）。
- `authority: "trusted-host"` → **不再加任何检查**。信任完全交给外层 `/api` 路由的围栏（lib/index.js:553-559：`isTrustedApiRequest(req, trustedHosts)`，trustedHosts = connection 插件配置的部署名单 = loopback ∪ trustedHosts 条目）。

自建 channel 路径（`register`，lib/index.js:243-254）语义等价但实现是提前选好列表：

```js
const trustedHosts = options.authority === "loopback" ? [] : this.trustedHosts;
// route handler: if (!isTrustedApiRequest(req, trustedHosts)) { 403 }
```

一句话：`loopback` = 围栏以 `[]` 重跑（只信 loopback）；`trusted-host` = 信外层围栏（loopback ∪ 部署 trustedHosts），interceptor 自身不再判定。**对纯本机（127.0.0.1）部署两者无差别**；差异只在非 loopback（`0.0.0.0` / LAN / `--trusted-host`）场景出现。

### 7.4 `ctx.effect` 是不是正确写法（Q4）

**结论：是，`ctx.effect(execute, label)` 就是 Cordis 注册资源的正解**（cordis/lib/index.js:1168-1278）：立即执行 setup，把 execute 返回的 disposer 收进 fiber 的 disposables，fiber 卸载时**逆序、可异步**地执行清理；支持同步函数 / async 函数 / generator。DSH 全仓库统一用 `ctx.effect(() => registration(), "label")` 包路由/拦截器/回退/监听器注册：

- `dsh-client-connection`：`ctx.effect(() => ctx.webServer.register(route), "client-connection: /api route")`（lib/index.js:562）；
- `dsh-host-frontend-static`：`ctx.effect(() => ctx.webServer.registerFallback(...), "frontend-static: fallback seat")`（lib/index.js:73）；
- interceptor 注册本身就是 `owner.effect(...)`（lib/index.js:266-272），所以你的插件里写 `ctx.effect(() => ctx.connection.rpc.intercept('/api', matches, handler, options), "my-plugin: /api interceptor")` 即可——interceptor 自动跟随你的 fiber 生命周期。

- **`ctx.on("ready")` 不存在**：cordis 核心库 grep `"ready"` 零命中；生命周期事件只有 `internal/plugin`、`internal/service`、`internal/config`、`internal/status`、`internal/get`、`internal/set`、`internal/update`（`notify` 里 emit `internal/service`，cordis/lib/index.js:848；loader 用 `internal/plugin`，loader/lib/index.js:696）。"等所有插件就绪后再做某事"的官方语义是声明式 `inject`（Cordis 自动 defer）+ `apply`，或 `ctx.inject([...], cb)` 的延迟子 fiber。
- 类插件（Service）的补充约定：同步注册放**构造函数**（`dsh-client-modules` lib/index.js:158），异步初始化放 `[Service.init]()`（`dsh-message-feedback` lib/index.js:259-267），二者都可再嵌套 `ctx.effect`。

---

## 8. 关键文件索引（要在哪个包里看什么）

| 你想确认的 | 打开的文件（均相对 `...\@deepseek-ai\dsh\node_modules\@deepseek-ai\`） |
|---|---|
| webServer 全部 API 实现 | `dsh-host-webserver/lib/index.js`（217 行） |
| webServer 类型定义 | `dsh-host-webserver/lib/types/index.d.ts` |
| /api 信任围栏 + bridge + interceptor 实现 | `dsh-client-connection/lib/index.js`（588 行，含 `isTrustedApiRequest`/`registerInterceptor`/`bridge`/`PRIVILEGED_METHODS`） |
| connection 类型（intercept 签名） | `dsh-client-connection/lib/types/rpc.d.ts`、`rpc-host.d.ts`、`api-request-trust.d.ts` |
| ApiProxy 域实现（`host.pickDirectory` 等） | `dsh-host-apiproxy/lib/index.js`（5587 行；`UNARY_ROUTES` 在 :4608，`createApiProxy` 在 :1675，`ApiProxyService` 在 :5529） |
| RPC 合同（`RpcResult`/`RpcError`/消息四象限） | `dsh-host-apiproxy/lib/types/api/rpc.d.ts`、`api/rpc.schema.d.ts`、`api/index.d.ts` |
| Typert Remote 网关（/api interceptor 的实际占用者） | `dsh-api-gateway/lib/index.js`（`TypertGatewayService`，intercept 在 :62） |
| Typert Remote 装饰器/基类 | `dsh-typert-protocol/lib/types/index.js`（`TypertRemoteService`/`Remote`/`remoteMethods`） |
| Typert 注册表（`ctx.typert`） | `dsh-typert-registry/lib/index.js` |
| `./typert` 清单自动装载 | `dsh-typert-loader/lib/index.js` |
| **最小 apply 型宿主插件（模板）** | `dsh-host-frontend-static/lib/index.js` |
| 最小 Typert Remote 宿主插件 | `dsh-host-plugin-inventory/lib/index.js`（+ `lib/typert.host.js`） |
| 完整双面 Typert 插件 | `dsh-message-feedback/lib/index.js`（+ `lib/typert.host.js`） |
| Cordis 插件/Service/依赖语义 | `cordis/lib/index.js`（`plugin()` :1618，`resolve()` :1532，`Service` :1741，`Inject.resolve` :1490，config 校验 :955） |
| Loader 行/patch 组合格式 | `cordis-plugin-loader/lib/index.js`（`unwrapExports` :736）+ `dsh-web-app/cordis.patch.yml` |
