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
| GET | `/api/config/public` | 下发 `ui/features/context/modelRecommendation` 公共配置；运行期文件变化按 `no-store` 每次读取 |
| GET | `/api/changelog` | 版本化更新日志 |
| GET | `/api/announcements` | 固定文件 `announcement.md` 中的公告快照；每次请求读取，`no-store` |
| GET | `/api/announcements/events` | 公开只读公告 SSE；连接即发送当前快照，内容指纹变化时推送同一结构 |
| POST | `/api/image` | 图片生成/编辑代理入口 |
| POST | `/api/chat-stream-jobs` | 注册聊天流式任务 |
| POST | `/api/client-execution-trace` | 客户端拒绝执行时上报受限诊断事件 |

## 3. 任务端点（chat / image / image-batch）

基础路径：`/api/chat-jobs`、`/api/image-jobs`、`/api/image-batches`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | 基础路径 | 创建任务，返回公开任务视图 |
| GET | `/{id}` | 查询任务（本人） |
| GET | `/{id}/events?contentLength=&reasoningLength=` | 单 Job SSE；每个会话只订阅自己的当前 Job，帧内不重复任务 ID，支持正文/思考 offset 续传 |
| POST | `/{id}/abort` | 停止任务 |
| DELETE | `/{id}` | 释放任务 |

任务响应注入 `server/jobs/http-contract.js` 的头；未找到与非本人任务统一 404。

图片任务创建被参数、归属或执行协议校验拒绝时，服务端必须按 `trace_id + validation stage + error code` 写入脱敏诊断日志；客户端收到明确 4xx 后必须释放该次本地任务快照，不能把未创建的 job 留作刷新恢复目标。

## 4. Presence 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/presence` | `{count, timestamp}` 快照；count 为去重后的在线浏览器/设备数（同一浏览器多标签页计 1） |
| GET | `/api/presence/stream?clientId=...` | SSE 在线人数流；每 30s 心跳，默认 120s TTL 清理 |
| POST | `/api/presence/heartbeat` | 刷新心跳，body `{clientId}` |

## 5. 使用统计与反馈端点

`/api/usage/overview`、`/api/usage/rankings`、`/api/usage/personal`、`/api/usage/department/verify|summary|rankings|users|export`、`/api/usage/feedback`。未配置数据库时显式返回不可用状态。 `/api/usage/feedback` 提交前由当前聊天模型审核：内容可以简短，但问题描述、复现描述、期望结果三项均需存在，空泛、占位、广告或胡言乱语仍会被拒绝。

## 6. 代理契约（OpenAI 兼容）

POST 代理方法仅 `GET/POST`，路径白名单固定：

- `/models`、`/chat/completions`、`/responses`
- `/images/generations`、`/images/edits`、`/openai/image_edit`

`UPSTREAM_TIMEOUT_MS` 定义上游**有效输出空闲超时**：从新建上游请求开始，并在每次解析到可见正文或思考增量后重新计算空闲间隔；连续 `UPSTREAM_TIMEOUT_MS` 没有有效输出即中止。SSE 注释、keepalive、空事件和其他不产生正文/思考的协议帧不得续期。持续产生有效输出的长流不受总时长截断；用户停止、连接错误和上游 HTTP 错误仍按原有取消/错误路径处理。

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

托管 Job 的 HTTP 拒绝错误同时保留 `statusCode` / `status` / `code` / `retryable` 机器字段；`408`、`425`、`429` 和 `5xx` 可重试，其余 `4xx` 不可重试。原始诊断只用于日志，用户气泡必须使用平实、可操作的归一化文案。

意图控制请求可以使用 `intent_understanding`、`intent_recognition`、`intent_critic`、`route_repair`、`route_fallback`、`multi_task_planning` 和 `image_planning` 等独立 `requestPurpose`；它们均禁止携带执行合同，且最终执行仍必须通过 `dispatch_contract.v1`。

### 7.1 `image_instruction.v1` 空伴生字段归一化（2026-09-13）

- `ready` 的语义必需字段是 `instruction`；`needs_clarification` 的语义必需字段是 `clarification`。当 JSON-mode 供应商省略由 `status` 唯一要求为空的伴生字段时，客户端协议边界可补为 `''`：即 `ready` 可省略 `clarification`，`needs_clarification` 可省略 `instruction`。
- 该归一化只发生在 `shared/image-instruction.js` 的传输解析边界；缺失语义必需字段、错误版本、未知/额外字段、两个字段同时有值或同时为空仍返回 `image_instruction_invalid`，不得授权执行。
- `dispatch_contract.v1` 仍是唯一执行授权；只有归一化后的 `image_instruction.v1` 才能进入 `applyMaterializedImageInstruction`。

## 8. 缓存与安全头

- 入口 HTML、可执行模块与 `/api/announcements`：`no-store`，确保运行期公告文件更新后不会被共享缓存钉死。
- 内容匹配的 bundle：`public, max-age=31536000, immutable`。
- 字体/图片/SVG 等静态资源：短缓存。
- 所有响应注入 `X-Content-Type-Options`、`Referrer-Policy`、CSP 与 `nosniff`。

## 9. SSE 事件契约

`data:` JSON 事件 + 注释帧 keepalive；服务端关闭前先结束 SSE 再退出。客户端断线重连复用 job event offset，避免重复处理。

公告 SSE 默认每 5 分钟发送注释 keepalive，固定使用 `event: announcement`，`data` 与 `GET /api/announcements` 相同。每次连接先发送当前快照；`announcement.md` 内容指纹变化时向全部订阅者广播，重复事件和其他文件变化不广播。服务端以目录 watcher 驱动，客户端不再实施 5 分钟轮询；EventSource 重连和页面 focus/pageshow/visibility/online 事件以当前快照收敛。

浏览器运行时按会话建立 `GET /api/chat-jobs/:jobId/events?contentLength=&reasoningLength=`：一个会话同一时刻最多一条 Chat Job EventSource，不同会话绝不共用连接。服务端只发送当前 Job 的最小帧，compact chat 使用默认 SSE message；正文/思考为 `d/r`，首 Token 耗时只发一次 `ft`，终态才发 `done/e/rt`，offset 越界才发 `z`，不发送任务 id、`status` 或重复 `error`。同一会话/Job 的多个 waiter 共享 canonical aggregate；终态只关闭本会话连接。

## 10. 内部路由修复契约（2026-08-30）

`route_repair.v1` 仅用于 `/responses` 的 `requestPurpose=route_repair`，不是公开执行 API，也不携带 `dispatch_contract.v1`。它以 `base_route_intent` 为基线，返回完整字段镜像和 `changed_fields`；本地仅接纳原因授权字段的声明性变化。兼容供应商若返回完整 `route_intent.v3`，客户端必须先推导受限差异，随后执行相同校验；不得把该输出直接当作最终路由。

任何越权字段变化、未声明变化、无效资源候选或资源绑定丢失都会被视为 `invalid_model_output`，且不会创建 dispatch contract。
## 11 默认聊天输出边界（2026-08-30）

当会话和全局配置没有显式 System Prompt，且当前请求包含个性化或“只保留/仅输出”等输出边界时，聊天执行请求由客户端附加一份通用输出边界策略：

- 个性化、适合本人或量身定制的建议缺少关键条件时，先只询问最少必要信息，不在同一轮编造具体方案；
- 用户要求筛选、删除、压缩或只保留某个优先级/部分时，只输出筛选后保留的内容，不自动补回被排除项目、相邻项目或新的阈值、附录和解释；该通用策略不注入发布、值班、监控等特定领域规则；
- 显式配置的全局或会话 System Prompt（包括显式清空的会话覆盖）保持优先，不被默认策略静默覆盖。

该策略只约束聊天模型的自然语言输出，不改变路由、执行合同、资源绑定或服务端授权；对应行为由 test/unit/chat-output-policy.test.js 和聊天场景实测验证。
