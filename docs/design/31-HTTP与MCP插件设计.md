# 31 HTTP 与 MCP 插件设计

> 状态：已实现（2026-09-21）。本设计只新增默认关闭的插件旁路，不改变未选择插件时的既有聊天 payload、流式 Job、意图路由协议或图片链路。

## 1. 范围与目标

- 支持两类服务端受控插件：
  1. **HTTP 接口插件**：管理员为每个工具声明方法、路径、JSON Schema、风险等级和认证环境变量；
  2. **远程 MCP 插件**：通过 Streamable HTTP JSON-RPC 完成 `initialize`、`tools/list`、`tools/call`，并只暴露显式允许的工具。
- 浏览器输入区提供插件面板；用户勾选的自动工具保存在本地。
- 已选择插件时，聊天使用非流式 managed Chat Job 执行受限 function-calling 循环；模型返回的工具调用必须命中本轮服务端白名单，插件结果以 `role=tool` 回传并继续生成。
- 未选择插件时，`chat-workflow` 原样走现有 Responses 流式链路。

非目标：

- 不做插件市场、任意 URL 安装、浏览器直连插件、OAuth 授权管理、逐次审批 UI、远程 MCP 的 OpenAI 代连模式。
- `requiresApproval=true` 或风险不是 `read` 且未显式配置为自动的工具不能被模型自动调用；面板展示但禁用。
- 不把插件工具并入 `route_intent.v3` 或修改 `dispatch_contract.v1` 的既有语义。

## 2. 配置与契约

服务端配置默认读取 `data/plugins.json`，可用 `CHATUI_PLUGINS_FILE` 覆盖；文件不入 Git。协议为 `chatui_plugins.v1`：

- 插件 id：`^[a-z][a-z0-9_-]{1,63}$`，最多 16 个插件；
- 工具名：`^[A-Za-z][A-Za-z0-9_-]{0,63}$`，单插件最多 32 个，且所有插件的工具名全局唯一；
- HTTP/MCP URL 必须 HTTPS，并复用服务端上游 URL 公网/私网策略与重定向校验；
- 认证仅支持 `none` 或从环境变量读取 Bearer token；
- JSON Schema 支持受限子集：object/array/string/number/integer/boolean/null、required、enum、min/max、maxLength、maxItems、additionalProperties=false；
- 配置文件最大 256 KiB；无效配置失败关闭为空插件列表，不部分加载。

公共视图只包含插件 id/type/label/enabled 与工具名、说明、风险、审批策略、输入 Schema，不包含 URL、认证环境变量或 token。

## 3. 执行流程

```text
插件面板 GET /api/plugins
  → 用户勾选自动工具（localStorage: chatui.plugins.selected-tools.v1）
  → sendChat 检测非空选择
  → POST /api/chat-jobs（api=chat，pluginToolIds）
  → 服务端对照插件注册表编译 function tools
  → Chat Completions 返回 tool_calls
  → 参数 JSON Schema 校验
  → HTTP 工具或 MCP tools/call
  → role=tool 结果回传模型
  → 最多 6 轮，返回最终正文
```

约束：

- 只接受 `api=chat`；Responses 流式 Job 携带 `pluginToolIds` 时返回 `PLUGIN_TRANSPORT_UNSUPPORTED`。
- 模型请求的工具名不在本轮白名单内时返回 `PLUGIN_TOOL_NOT_AUTHORIZED`，禁止执行。
- 单插件调用超时默认 30 秒，可用 `CHATUI_PLUGIN_TIMEOUT_MS` 配置为 1–120 秒。
- 插件结果单次最大 512 KiB；JSON 优先，非 JSON 转为有界文本。
- 插件调用轮数最多 6；超出返回平实错误 `插件调用轮数过多，请缩小问题范围后重试`。
- Job 公开视图只追加 `pluginTrace[{pluginId,toolName,status}]`，不包含参数、结果、URL 或凭据。

## 4. 浏览器与模块边界

- `shared/plugin-contract.js`：双端配置归一化、Schema 校验、公共视图与 Chat function tool 投影；
- `server/services/plugin.service.js`：配置读取、工具选择、HTTP 执行、MCP JSON-RPC、结果上限；
- `server/api/routes/plugins.js`：只读 `GET /api/plugins`，不提供直接调用插件端点；
- `server/jobs/chat.js`：非流式 managed Chat Job 的插件白名单与工具循环；
- `client/services/plugin-service.js`：插件列表、选择持久化、插件 Chat Job 创建与轮询；
- `client/features/plugins/workflow.js`：输入区面板交互；
- `client/app/chat-workflow.js`：仅在本地已选工具非空时切换到插件旁路；
- `styles/plugins.css` 与 `index.html` manifest：新增入口样式与资源装配。

## 5. 安全设计

- 插件请求只能由服务端发起；浏览器不得获得插件 baseUrl、Bearer token 或认证环境变量名。
- HTTP 与 MCP 请求逐跳执行 HTTPS/公网校验、最多 3 次重定向、DNS 解析私网拦截（除非既有 `CHATUI_ALLOW_PRIVATE_UPSTREAM=1` 显式允许）。
- 插件 Authorization 只写入上游请求头，不进入 access/request/error 日志或 Job 公开视图。
- GET 默认 `risk=read`、可自动；非 GET 默认 `risk=write`、`requiresApproval=true`，自动选择被拒绝。管理员必须显式配置 `requiresApproval:false` 才允许服务端代替用户调用。
- MCP 每次调用前执行 `tools/list` 并重新校验远端 Schema；远端新增未授权工具不会进入模型请求。
- 工具结果只是 `role=tool` 的数据，不获得 system 指令地位；最终 Markdown 渲染继续走既有消毒策略。

## 6. 验收标准

1. 未选择插件时，现有聊天测试全部保持通过，请求仍走 Responses 流式链路。
2. HTTP 插件按 Schema 校验 query/body，拒绝额外字段，Bearer token 不出现在返回值或日志。
3. MCP 插件按 `initialize → notifications/initialized → tools/list → tools/call` 调用，只允许配置显式列出的工具。
4. 面板能展示 HTTP/MCP 工具；需审批工具禁用，不能被自动选择。
5. 插件 Chat Job 使用 `api=chat`、`stream=false`、`pluginToolIds`；Responses 传输被明确拒绝。
6. `test/unit/plugins.test.js` 覆盖以上行为并接入自定义 runner；提交前 `npm run check` 必须全绿。

## 7. 演进边界

- 逐次审批可扩展为 `awaiting_tool_approval` Job 子状态与独立 approve/reject API，但必须先新增设计。
- OAuth、每 principal 插件授权、插件市场、远程 OpenAI MCP 代连均不在本版承诺内。
- 若要支持流式插件输出，必须扩展 compact SSE 协议并保留非流式回退，不得复用正文 delta 伪造工具状态。
