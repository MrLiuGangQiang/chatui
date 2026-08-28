# 04 API 与服务契约设计

> 端点以 `server/api/` 为唯一实现。所有响应经过 `server/http/response.js` 注入安全头。

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 基础路径 | `/api/*`，URL 中不引入版本号 |
| 方法 | GET / POST / DELETE / OPTIONS |
| 响应 | JSON；SSE 接口使用 `text/event-stream` |
| CORS | `Access-Control-Allow-Origin: *`，允许 `Content-Type, Authorization` |
| 身份 | principal cookie（无登录态）；任务按 principal 隔离，非本人返回 404 |
| 缓存 | 敏感/执行接口一律 `no-store`；bundle 遵循 02 的指纹缓存规则 |

## 2. 核心端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/version` | 返回 version、Git SHA、runtime source fingerprint |
| GET | `/api/config/public` | 下发 `ui/features/context` 公共配置 |
| GET | `/api/changelog` | 版本化更新日志 |
| GET | `/api/announcements` | 累计公告 |
| POST | `/api/image` | 图片生成/编辑代理入口 |
| POST | `/api/chat-stream-jobs` | 注册聊天流式任务 |
| POST | `/api/client-execution-trace` | 客户端拒绝执行时上报受限诊断事件 |

## 3. 任务端点（chat / image / image-batch）

基础路径：`/api/chat-jobs`、`/api/image-jobs`、`/api/image-batches`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | 基础路径 | 创建任务，返回公开任务视图 |
| GET | `/{id}` | 查询任务（本人） |
| GET | `/{id}/events` | SSE 事件流，支持断点续传 offset |
| POST | `/{id}/abort` | 停止任务 |
| DELETE | `/{id}` | 释放任务 |

任务响应注入 `server/jobs/http-contract.js` 的头；未找到与非本人任务统一 404。

## 4. Presence 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/presence` | `{count, timestamp}` 快照 |
| GET | `/api/presence/stream?clientId=...` | SSE 在线人数流；每 30s 心跳，默认 120s TTL 清理 |
| POST | `/api/presence/heartbeat` | 刷新心跳，body `{clientId}` |

## 5. 使用统计与反馈端点

`/api/usage/overview`、`/api/usage/rankings`、`/api/usage/personal`、`/api/usage/department/verify|summary|rankings|users|export`、`/api/usage/feedback`。未配置数据库时显式返回不可用状态。

## 6. 代理契约（OpenAI 兼容）

POST 代理方法仅 `GET/POST`，路径白名单固定：

- `/models`、`/chat/completions`、`/responses`
- `/images/generations`、`/images/edits`、`/openai/image_edit`

不在白名单内的 `/api/*` 一律 405。`/api/models` 由浏览器携带 `{baseUrl, apiKey}` 发起服务端转发。

## 7. 路由结果分类（失败关闭）

结果只允许：

| 结果 | 含义 | 用户可见行为 |
| --- | --- | --- |
| `ready` | 可执行 | 正常调度 |
| `business_clarification` | 业务歧义 | 创建澄清，继续原语义路由 |
| `configuration_error` | 配置错误 | 失败，不伪装成澄清 |
| `transient_error` | 网络/超时/限流/5xx | 失败，可重试 |
| `invalid_model_output` | 协议无效或语义矛盾 | 失败，文案用平实语言引导重试/换模型 |
| `cancelled` | 用户停止 | 立即结束，不误报超时 |

## 8. 缓存与安全头

- 入口 HTML 与可执行模块：`no-store`。
- 内容匹配的 bundle：`public, max-age=31536000, immutable`。
- 字体/图片/SVG 等静态资源：短缓存。
- 所有响应注入 `X-Content-Type-Options`、`Referrer-Policy`、CSP 与 `nosniff`。

## 9. SSE 事件契约

`data:` JSON 事件 + 注释帧 keepalive；服务端关闭前先结束 SSE 再退出。客户端断线重连复用 job event offset，避免重复处理。