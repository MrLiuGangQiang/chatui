# 32 MCP 用量统计与问题反馈设计

> 状态：已实现（2026-11-18）。本设计新增一个面向外部 MCP 客户端的无状态服务端点，复用右上角“使用统计/问题反馈”的既有数据与业务能力，不改变浏览器端现有接口和交互。MCP 部门工具只使用用户 API Key 授权，不接收部门密码；用户和部门用量均支持按完整名称精确查询。

## 1. 范围与目标

- 提供 `POST /api/mcp` 的 Streamable HTTP MCP JSON-RPC 入口。
- MCP 访问令牌就是用户当前使用的 API Key：通过 `Authorization: Bearer <API Key>` 传递，兼容 `X-API-Key: <API Key>`。
- 工具覆盖右上角用量统计的全部用户能力：
  1. 获取个人用量与排行榜概览；
  2. 按范围获取个人用量；
  3. 按范围获取用户排行榜；
  4. 按完整用户名精确查询用户聚合用量；
  5. 获取部门统计概览；
  6. 获取部门排行；
  7. 获取指定部门的用户明细；
  8. 按完整部门名精确查询部门聚合用量及部门用户用量；
  9. 导出部门统计 XLSX；
  10. 提交问题反馈。
- 复用既有统计范围：`today`、`yesterday`、`week`、`last_week`、`month`、`last_month`、`total`。

非目标：

- 不提供 MCP 客户端管理、OAuth 授权、动态客户端注册或远程 MCP 代理。
- 不提供浏览器直接调用 MCP 的 UI 集成；MCP 是外部客户端接口。
- 不新增会话历史、反馈查询/撤回、部门密码管理或统计写接口。
- 不把 API Key、部门密码、反馈正文或工具原始参数写入日志。

## 2. 认证与访问控制

- 每个 HTTP 请求都必须携带用户 API Key；`initialize`、`tools/list`、`tools/call` 和 `ping` 均受保护。
- 服务端先按用户密钥查询 `api_keys`，再通过既有 `/models` 校验确认密钥仍有效。任一步失败都失败关闭。
- 个人统计工具只允许查询当前 token 对应的个人数据；排行榜、按用户名查询和按部门名查询按既有产品语义展示其他用户的用户名、部门名与聚合用量，且只返回聚合指标，不返回请求日志或明细。
- 部门工具与个人统计工具一样，只依赖当前用户 API Key；MCP 不接收或校验 `department_password`。浏览器 `/api/usage/department/*` 的部门密码机制保持不变。
- 密钥只接受请求头。请求 body 中的 `api_key`、query string 中的 token 或其他隐式回退一律不用于 MCP 认证。
- MCP 统计工具沿用服务端刷新限流；部门工具共用一个更严格的 MCP 部门查询桶，降低昂贵查询风险。

## 3. MCP 协议契约

服务端实现无状态 Streamable HTTP JSON-RPC：

| 方法 | 请求 | 响应 |
| --- | --- | --- |
| `initialize` | 客户端协议版本、capabilities、clientInfo | 协商后的协议版本、`tools` capability、服务名与版本 |
| `notifications/initialized` | JSON-RPC notification | HTTP 202，无 body |
| `ping` | 空参数 | `{}` |
| `tools/list` | 无参数 | 十个工具的 JSON Schema |
| `tools/call` | `{name, arguments}` | MCP content 数组；工具业务失败使用 `isError:true` |

支持协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`；客户端请求未知版本时返回服务端最高支持版本。端点不签发 session，也不提供 GET SSE 或 DELETE 会话清理。

HTTP 语义：

- 仅接受 `POST`；其他方法返回 405 和 `Allow: POST`。
- 请求体上限 1 MiB，响应固定 `Cache-Control: no-store`，并使用无 Cookie 的 `Access-Control-Allow-Origin: *` 以支持浏览器型 MCP 客户端。
- JSON-RPC 语法/结构错误使用标准负错误码；未知工具返回 `-32602`。
- 无效或缺失 token 返回 HTTP 401；密钥验证上游不可用返回 HTTP 503；响应不包含 token。
- MCP 业务错误返回 JSON-RPC 成功响应中的 `isError:true` content，并只给用户可行动的简短说明。

## 4. 工具契约

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `usage_get_overview` | 可选 `ranking_range`、`personal_range` | 当前用户个人统计与所选范围排行榜 |
| `usage_get_personal` | 可选 `range` | 当前用户个人统计 |
| `usage_get_rankings` | 可选 `range` | 用户排行榜 |
| `usage_get_user_by_name` | `username`、可选 `range` | 指定完整用户名的聚合用量；未找到时 `found:false` |
| `usage_get_department_summary` | 可选 `range` | 部门统计概览与部门排行 |
| `usage_get_department_ranking` | 可选 `range` | 部门排行 |
| `usage_get_department_users` | `department_id`、可选 `range` | 部门用户明细 |
| `usage_get_department_by_name` | `department_name`、可选 `range` | 指定完整部门名的聚合用量与用户用量；未找到时 `found:false` |
| `usage_export_department` | 可选 `range` | XLSX 元数据与 embedded resource（base64 blob） |
| `usage_submit_feedback` | `problem_description`、`reproduction_description`、`expected_result`、可选 `chat_model`/`route_model` | 审核并投递反馈 |

所有统计结果保留完整 token 指标：`total_tokens`、`prompt_tokens`、`completion_tokens`、`prompt_cached_tokens`、`completion_reasoning_tokens`。按用户名和按部门名查询都使用大小写不敏感的完整名称精确匹配；同名 API Key 合并统计，同名部门分别返回并附带其用户用量，未找到时返回 `found:false`。部门导出最大 8 MiB，超过上限时返回可行动错误，不返回截断文件。

`usage_submit_feedback` 先按问题描述/复现描述/期望结果拼成与浏览器一致的反馈正文，再调用既有审核服务；审核通过后才解析反馈用户名并投递。反馈模型按以下顺序选择第一个可用项：调用参数 `chat_model`、`CHATUI_MCP_FEEDBACK_MODEL`、运行时推荐聊天模型、该 API Key 的模型列表首项。没有可用模型时要求调用方显式传入 `chat_model`。

## 5. 执行流程

```text
MCP client POST /api/mcp
  -> 提取 Bearer / X-API-Key token
  -> api_keys 查询用户
  -> 上游 /models 校验密钥（有界 TTL/LRU + in-flight 合并）
  -> JSON-RPC initialize / tools/list / tools/call
  -> MCP tool dispatcher
     -> usage.service -> PostgreSQL
     -> usage validator -> 范围校验与 MCP 限流
     -> feedback.service -> reviewer -> DingTalk sender
  -> no-store JSON response
```

## 6. 模块边界

- `server/mcp/contract.js`：MCP 版本、工具名、说明和输入 Schema 的唯一事实来源。
- `server/services/mcp-usage.service.js`：把 MCP 工具参数映射到既有统计、部门、导出和反馈用例。
- `server/services/feedback.service.js`：浏览器 HTTP 与 MCP 共用的反馈审核、用户名解析和投递用例。
- `server/api/routes/mcp.js`：HTTP/JSON-RPC 传输、token 提取、认证、限流和错误映射。
- `server/services/usage-access.service.js`：在既有 `validate(apiKey, model)` 之外增加仅校验密钥的 `validateKey(apiKey)`。
- `server/api/router.js`：挂载 `/api/mcp`，分类为 `mcp`，不得落到通用 `/api/*` 代理。

## 7. 安全约束

- 不记录 Authorization、X-API-Key、工具参数、反馈正文或导出 base64；认证失败时排空未读请求体，保持连接语义一致。
- 不接受 query string 或 JSON body 中的 token，避免 URL/请求追踪泄漏。
- 所有 MCP 响应 no-store；错误与工具结果不包含密钥、反馈正文或导出内容。
- 工具 Schema 拒绝未知字段和越界字符串；按用户名或部门名查询只接受完整名称并只返回聚合指标及部门用户聚合；MCP 部门工具不接受 `department_password`，部门 ID、名称、范围和反馈字段均在进入业务层前校验。
- MCP 不改变现有 ChatUI principal、Job ownership 或插件白名单语义。

## 8. 验收标准

1. 无 token、仅 body token 或仅 query token 均返回 401；正确 Bearer token 或 `X-API-Key` 可完成 `initialize` 和 `tools/list`，且响应可跨域读取。
2. `tools/list` 恰好暴露上述十个工具及完整范围 enum。
3. 统计、个人、排行榜、按用户名查询、部门排行、部门用户、按部门名查询和导出结果与既有 `/api/usage/*` 同源；名称查询只返回聚合指标。
4. 统计未配置、反馈审核拒绝和导出过大均以 `isError:true` 返回平实说明。
5. 反馈审核通过前不解析反馈用户名、不投递；拒绝后不产生外部发送。
6. token、反馈正文和导出 base64 不出现在 access/error 日志或公开结果文本中；MCP 部门工具不接受部门密码。
7. `/api/mcp` 不会被通用 `/api/*` proxy 接管，所有响应带 `no-store`。

## 9. 回归测试

- `test/unit/mcp-usage.test.js` 覆盖 Bearer/X-API-Key 认证、body/query token 拒绝、CORS/no-store、JSON-RPC 生命周期、十个工具、按用户名和部门名查询、无部门密码的部门统计、导出、反馈、日志脱敏和错误边界。
- `test/unit/usage-data-layer.test.js` 覆盖 `validateKey` 不要求 model、缓存隔离、无效密钥与上游故障，以及按完整用户名和部门名的参数绑定和聚合查询。
- `test/unit/api-contract.test.js` / `test/unit/server-router-access-log.test.js` 的既有契约必须保持全绿。
