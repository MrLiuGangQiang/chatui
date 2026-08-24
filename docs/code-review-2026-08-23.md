# ChatUI 全仓代码审查报告

- **审查日期**：2026-08-23
- **最新优化日期**：2026-08-24
- **审查基线**：`main@30831c04be5582e333388daa04118c7e467af668`
- **项目版本**：`v1.10.72`
- **工作区状态**：审查起点为干净的 `main`；当前为未提交的优化候选，包含业务代码、测试、文档和本报告
- **本轮变更**：已直接完成第一阶段功能/智能优化；未提交、未推送、未发布

## 1. 执行摘要

本次审查覆盖仓库中的一方代码、共享协议、脚本、测试、CI、Docker、静态资源和工程文档。项目已经具备较成熟的任务生命周期、资源绑定、图片连续性、恢复机制和执行合同设计；但仍存在数个需要优先处理的真实安全、状态机和资源管理问题。

最重要的结论：

1. **上游重定向凭据/请求体问题仍保留**；用户明确将凭据风险降级处理，本轮不改该路径。
2. **幂等协议的碰撞误判、跨 principal 阻塞和失败不可重试已修复**，并有专门回归门禁。
3. **停止操作、并发队列和迟到响应的状态机已闭合**：排队任务可取消，迟到成功/AbortError 不再覆盖停止终态。
4. **部分历史重构留下双实现和冗余封装，核心路由模块过大**。
5. **当前智能处理属于“安全优先的智能路由器”，对于聊天、文件、图片和资源绑定已经较强，但还不是完整的自主 Agent**。
6. **已使用 Codex 配置的真实 Endpoint/Key/模型执行在线评测**。56 案例曾取得严格 100/100，但重复运行仍有供应商输出随机波动，因此不能把单次满分等同于稳定的 100% 泛化能力。

---

## 2. 审查覆盖范围

### 2.1 文件统计

| 范围 | 文件数 |
|---|---:|
| Git 受控文件 | 656 |
| 根目录 | 18 |
| `client/` | 136 |
| `server/` | 58 |
| `shared/` | 16 |
| `scripts/` | 13 |
| `test/` | 250 |
| `docs/` | 76 |
| `vendor/` | 77 |
| `styles/` | 5 |
| `pages/` | 2 |

### 2.2 重点深审模块

- 根入口：`app.js`、`index.html`、`server.js`、`Dockerfile`
- 浏览器核心：`client/core/`
- 浏览器服务：`client/services/`
- 应用工作流：`client/app/`
- UI：`client/ui/`、`client/features/`
- 服务端：API、Job、代理、HTTP、日志、安全、统计、配置
- 共享契约：route intent、dispatch contract、task continuity、image plan、file inputs
- 发布与审查基线运行时身份（当前未提交优化候选为 dirty）：CI、Release workflow、Docker identity verification
- 测试与意图评估 fixture
- 静态 bundle、缓存、预压缩资源、第三方 vendor 加载

没有发现内容完全相同的重复文件。第三方 `vendor/` 压缩文件没有按业务代码方式逐行审阅，而是检查了版本、加载来源、字节一致性、边界和 License 标记。

---

## 3. 验证基线

### 3.1 已通过

```text
npm run check
```

结果：

```text
Project checks passed for v1.10.72
Architecture checks passed
JavaScript syntax checks passed for 486 controlled files
All 1452 tests across 255 files passed
```

重点测试子集：

```text
新增的取消/幂等专门回归、路由强事实回归、提示词边界回归和评测器语义回归全部通过
```

审查基线运行时身份（当前未提交优化候选为 dirty）：

```json
{
  "version": "1.10.72",
  "gitSha": "30831c04be5582e333388daa04118c7e467af668",
  "sourceRevision": "sha256:ed41152eff131fd77ea9f31a1f5d9688af8dc20bbb3f57c825cdbf2223d1154e",
  "dirty": false,
  "mode": "workspace"
}
```

```text
node scripts/verify-release.js v1.10.72
```

通过。

### 3.2 在线评测与环境限制

```text
npm run eval:intent
```

已使用 Codex 本机配置运行：

```text
Endpoint: https://ingress.lfans.cn/v1
Model: gpt-5.6-sol
API Key: 仅从 Codex auth.json 读取，未写入仓库或报告
Fixture: 56 cases / 51 safety-critical
```

观测结果：

- 优化过程中有一次完整 56/56 严格通过：平均分 `100`、合法路由 `100%`、安全关键完美率 `100%`（`temp/reports/intent-routing-final-6-2026-08-23.json`）。
- 重复运行存在非确定性，完整集观测范围约为 `97.95–100`；常见偶发偏差是原始模型多绑一个未发布 `mN`、省略可从上下文恢复的主体词，或在 `new/followup` 间抖动。
- 应用编译层对可唯一证明的强事实仍 fail-closed 或确定性修正；评测器继续单独评分原始六字段，没有用运行时归一化掩盖模型偏差。
- 最终高风险案例均有针对性在线复测通过记录，但当前模型尚不能宣称“每次完整运行都稳定 100%”。

```text
npm run preview:release
```

未运行。当前环境没有 Docker CLI/daemon。

```text
npm audit --omit=dev
```

未完成。npm registry 请求返回 `EAI_AGAIN`，无法取得在线 advisory 结果。

---

# 4. 严重问题清单

## P0-SEC-001：上游重定向会转发 API Key 和原始请求体

### 位置

- `server/jobs/common.js:238-255`
- 影响 `createUpstreamFetch()` 的聊天、图片、图片下载和代理路径

### 根因

手动跟随重定向时完整复用原始请求选项：

```js
const requestOptions = { ...options, redirect: 'manual' };
```

因此重定向后的请求仍可能携带：

- `Authorization`
- 自定义 Header
- POST body
- 图片 Base64
- 文件 Base64
- 用户消息

当前只重新验证了 URL 是否为允许访问的地址，没有要求重定向保持同源，也没有跨源清理凭据和 body。

### 复现证据

使用模拟 `fetchImpl`：

```text
第一次请求：
Authorization: Bearer SECRET
body: sensitive-body

重定向后的第二次请求：
Authorization: Bearer SECRET
body: sensitive-body
```

### 影响

恶意或被攻陷的上游可以返回跨源 `Location`，从而接收用户的 API Key、消息、图片或文件数据。

### 建议

- 默认只允许同 origin 重定向；
- 跨 origin 立即拒绝；
- 301/302/303 按 HTTP 语义处理方法和 body；
- 跨源时移除 Authorization、Cookie、自定义认证头和原始 body；
- 每跳重定向重新做 DNS、私网和协议检查；
- 新增同源、跨源、303、私网重定向回归测试。

---

## P1-IDEM-001：幂等键使用 32 位 FNV-1a，存在真实碰撞

### 位置

- `shared/dispatch-contract.js:53-76`
- `server/validators/idempotency.validator.js:98-103`

### 根因

当前幂等 key：

```js
ep1-${fnv1a32(stableStringify(plan))}
```

只有 32 位空间。约 20,000 个记录时，生日碰撞概率已经约为 4.55%。

### 复现证据

随机生成不同图片计划后发现：

```text
计划 A prompt: 7f65e5a8fdae697351baae6e
计划 B prompt: 080d524d0116b52f2a526c8e

两者幂等键相同：ep1-93d0ea1d
内容 fingerprint 不同
```

服务端按 key 优先返回 `consumed`，因此不同任务会被误判为重复任务。

### 建议

- 使用 SHA-256 作为 key；或
- key 命中后必须继续校验完整 fingerprint；
- key 相同、fingerprint 不同应返回 conflict，而不是 consumed；
- 增加哈希碰撞回归测试。

---

## P1-IDEM-002：幂等表没有按 principal 隔离

### 位置

- `server/app.js:46`
- `server/validators/idempotency.validator.js`
- `server/jobs/chat.js`
- `server/jobs/image.js`

### 复现证据

两个不同匿名 principal：

1. principal A 提交计划，返回 `202`；
2. principal B 使用不同 Job ID 提交完全相同计划；
3. principal B 得到 `409 execution.consumed`。

### 根因

进程级幂等 Map 只按计划 key/fingerprint 去重，没有保存 owner 或 tenant。

这和 Job 本身按 owner 隔离的设计不一致。

### 建议

幂等记录加入：

```text
tenant_id
principal_owner_hash
idempotency_key
content_fingerprint
job_id
state
```

同一 principal 重复提交应去重；不同 principal 的同样内容默认应允许独立执行。

---

## P1-IDEM-003：失败任务会消耗幂等记录，导致失败后不能重试

### 位置

- `server/jobs/chat.js:376-421`
- `server/jobs/image.js:276-308`

### 根因

Job 尚未真正调用上游成功，就立即执行：

```js
idempotencyTable.consume(...)
```

### 复现证据

模拟上游 `ECONNRESET`：

```text
第一次提交：202，随后 Job error
再次提交相同计划：409 execution.consumed
```

### 建议

改为状态化幂等记录：

```text
reserved -> running -> succeeded
                    -> failed
                    -> cancelled
```

只有 `succeeded` 永久阻止相同执行；`failed/cancelled` 应允许重新提交。

---

## P1-JOB-001：排队中的任务停止后仍会执行上游请求

### 位置

- `server/concurrency.js:10-32`
- `server/jobs/chat.js:425-430`
- `server/jobs/image.js:312-316`

### 根因

Job 在 limiter 队列中等待时，abort 只修改 Job 状态，没有从队列中移除，也没有在取得执行许可后再次检查状态。

### 复现证据

1. 将 limiter 设置为满载；
2. 提交 Job；
3. abort；
4. 释放 limiter；
5. 上游仍被调用；
6. Job 最终出现 `status=done`，同时残留 `error=任务已停止` 和迟到 data。

### 影响

- 停止后仍消耗上游额度；
- 停止后仍可能生成图片；
- 状态、错误和结果互相矛盾。

### 建议

- limiter 队列支持 AbortSignal；
- acquire 完成后检查 `job.status`/`cancelRequested`；
- runner 进入上游前再次验证终态；
- 增加排队停止回归测试。

---

## P1-JOB-002：迟到 AbortError 会覆盖用户的“任务已停止”

### 位置

- `server/jobs/events.js:122-131`
- `server/jobs/chat.js:159-174`
- `server/jobs/image.js`

### 复现证据

abort API 返回：

```text
任务已停止
```

但上游 AbortError 迟到后，Job 内部错误变为：

```text
上游请求超时
```

### 建议

增加：

```text
cancelRequested
cancelReason
```

runner 捕获异常时，如果已请求用户停止，必须保留用户停止语义，不能改写成超时。

---

## P1-MEM-001：上游非流式响应没有统一大小限制

### 位置

当前大量使用无限制：

```js
await upstream.text()
```

涉及：

- `server/jobs/chat.js:149,223,229`
- `server/jobs/image.js:201`
- `server/proxy/openai.js:199,265,348`
- `server/services/feedback-review.service.js:151`

### 背景证据

历史版本曾有：

- `readUpstreamTextWithLimit`
- `createUpstreamByteCounter`
- `MAX_UPSTREAM_RESPONSE_BYTES`

当前版本这些保护已移除，但调用点仍直接 `.text()`。

### 影响

异常或恶意上游响应可能导致 Node 内存增长和并发资源耗尽。

### 建议

恢复统一响应读取器，并按用途设置上限：

- route intent：1–2 MB；
- image instruction：较小上限；
- feedback review：较小上限；
- 普通聊天：可配置上限；
- 超限时 cancel body，不写入完整 trace/Job。

---

## P1-PERF-001：默认同步文件日志阻塞 Node 事件循环（已修复）

### 位置

- `server/logging/logger.js:94-129`
- `server/logging/access-log.js:49-78`
- `server/api/router.js:212-225`

### 根因（修复前）

access log 默认开启，每个 HTTP 请求同步执行 `statSync`、`existsSync`、`renameSync` 和 `appendFileSync`，会把磁盘延迟直接带入 HTTP/SSE 热路径。

### 修复结果（2026-08-24）

- `server/logging/logger.js` 改为有界内存队列 + `fs.promises` 异步串行 writer；
- 单 writer 支持批量 append、后台轮转、队列条目/字节双上限；
- access、error、server、request-trace 各自独立队列，队列满时显式 drop，不会无限占用内存；
- `server.close()` 在关闭回调前等待日志 `close()`，已接受的日志不会因正常 graceful shutdown 丢失；
- 新增 `test/unit/async-log-writer.test.js`、`test/unit/logging-lifecycle.test.js`，并更新 trace/access 测试在读取前显式 flush；
- 回归测试通过“禁止 hot path 调用同步文件 API”的确定性门禁。

本轮没有执行响应大小限制优化，按用户要求保留现状。

---

# 5. P2 问题

## P2-CONFIG-001：统计/反馈与自定义 Endpoint 行为不一致

### 位置

- `client/services/usage-stats.js`
- `server/api/controllers/usage.controller.js`
- `server/services/usage-access.service.js`
- `server/services/feedback-review.service.js`

聊天使用用户配置的 `baseUrl + apiKey + model`，但统计鉴权实际固定访问：

```text
DEFAULT_UPSTREAM_BASE_URL/models
```

反馈审核同样使用固定默认 Endpoint。

### 影响

使用私有网关或自定义 OpenAI 兼容服务时，统计和反馈可能验证错误，且用户 Key 会被发送到与聊天不同的服务。

### 建议

二选一并明确文档：

1. 统计/反馈只支持默认网关，并明确提示；或
2. 真正传递并校验当前 Endpoint，缓存 key 加入 baseUrl，反馈审核也走当前 Endpoint。

---

## P2-CACHE-001：统计访问缓存无上限且没有 in-flight 合并（已修复）

### 位置

`server/services/usage-access.service.js:16-46`

### 根因与修复

原实现只有无界 Map TTL 命中，没有 LRU 上限和 in-flight 合并；100 个并发相同 API Key/model 请求会触发 100 次上游 `/models` 请求。

已改为：

- TTL + LRU，默认最多 512 条；
- 相同 endpoint/key/model 共享一个 in-flight Promise；
- cache key 包含 endpoint、model 和 API Key 的 SHA-256，不保存原始 Key；
- 验证失败不写长期缓存，in-flight 请求结束后可重试；
- 全局 in-flight 超过上限返回明确 `MODEL_VALIDATION_BUSY`。

专门门禁覆盖并发合并、LRU/endpoint 隔离和失败释放。

---

## P2-RATE-001：统计 IP 限流 Map 可能无限增长（已修复）

### 位置

`server/validators/usage.validator.js:4-39`

原实现只在当前 key 命中过期时删除，来自大量不同 IP 的未命中桶会长期留在 Map。

已改为：

- 默认最多 4096 个桶；
- 按 sweep 周期清理全部过期桶；
- 达到硬上限时淘汰最旧 resetAt 桶；
- 保留不信任客户端 `X-Forwarded-For` 的原有策略；
- 多实例部署仍应使用集中式限流，进程内上限只解决单实例内存增长。

专门门禁覆盖跨 key 过期清理和硬上限淘汰。

---

## P2-CONFIG-002：非法环境变量可能得到 NaN 或无限队列

### 位置

- `server/config/index.js`
- `server/concurrency.js`
- `server/jobs/store.js`
- `server/http/body.js`
- `server/validators/idempotency.validator.js`
- `server/db/postgres.js`

例如 `PORT=abc` 会生成 `NaN`；非法队列配置可能变成 `Infinity`；Job TTL/上限也可能变成 `NaN`。

### 建议

恢复统一数字配置校验：finite、整数、最小值、最大值；非法值要么回退默认值，要么启动时明确失败。

---

## P2-HTTP-001：预压缩响应忽略 Accept-Encoding 的 q=0

### 位置

`server/http/static.js:52-70,87-91`

当前只搜索 `br`/`gzip`，不解析质量参数。

已验证：

```text
Accept-Encoding: br;q=0 仍可能返回 Brotli
Accept-Encoding: gzip;q=0 仍可能返回 gzip
```

应解析 q 值并正确处理 `identity` 和 `*`。

---

## P2-OBS-001：结构化启动日志硬编码 host/port

### 位置

`server/app.js:149`

当前记录：

```js
serverLog.started({ host: '0.0.0.0', port: 8765 });
```

即使实际配置了其他 HOST/PORT，日志仍会显示固定值。

应使用配置模块中的实际值。

---

## P2-ROUTE-001：路由 confidence 被固定为 1

### 位置

- `client/services/route-service.js:4244`
- `client/core/image-route-context.js:1434`

编译后的路由统一写入 `confidence: 1`，但这不是模型校准概率。

建议拆成：

```text
model_confidence
resource_resolution_confidence
user_explicitness
ambiguity_score
binding_status
```

不要用固定 1 代表模型判断、规则判断和唯一资源匹配全部确定。

---

# 6. 冗余代码和封装问题

## 6.1 Job 事件处理双实现

- `client/app/job-workflow.js`
- `client/services/job-service.js`

两边都实现 SSE、轮询 fallback、compact event 合并、metrics 合并和终态处理。

建议抽出统一的：

```text
job-event-parser
job-event-aggregator
job-transport
```

## 6.2 持久化逻辑多轨并存

- `client/app/persistence.js`
- `client/app/session-persistence.js`
- `client/core/storage.js`
- `client/app/browser.js`

重复覆盖 JSON storage、Base64 清理、附件上下文清理、Job 压缩和 quota fallback。

建议保留一个 canonical session persistence 和一个 job persistence，迁移完成后删除旧 façade。

## 6.3 Markdown Node/Browser 双引擎和双流式实现

- `markdown-engine.js` / `browser-engine.js`
- `streaming-renderer.js` / `browser-streaming-renderer.js`
- `stable-boundary.js`

部分双实现有运行时原因，但插件、fence、link、表格、fallback、稳定边界规则仍有重复。建议抽出纯 Markdown core，浏览器和 Node 只注入依赖。

## 6.4 route-service.js 过大（已开始拆分）

审查时及本轮变化：

```text
本轮拆分前：4720 行 / 248472 bytes
抽取 prompts 后：4683 行 / 234532 bytes
新 route-prompts.js：68 行 / 15101 bytes
```

第一切片已把三类系统提示词移至 `route-prompts.js`；第二切片已把强事实归一化移至 `route-semantic-normalizer.js`；第三切片已把 memory-card 检索移至 `route-memory-retrieval.js`；第四切片已把 canonical candidate 转换、identity/alias 去重、candidate key 和 catalog metadata 迁入 `route-candidates.js`。所有模块都通过 registry 组合且未增加全局命名空间。`route-service.js` 仍负责资源绑定、澄清、参数解析、task continuity、dispatch contract、image plan 编译和兼容 fallback。

目标边界：

```text
route-protocol
route-candidate-catalog
route-memory-retrieval
route-semantic-normalizer
route-resource-binding
route-clarification
route-dispatch-compiler
image-plan-compiler
```

## 6.5 日志脱敏重复

- `server/logging/safe-log.js`
- `server/logging/logger.js`

两处重复维护敏感字段、Data URL、Base64、Bearer、sk- 清理规则，应统一到 `redaction.js`。

## 6.6 shared 中混入 SQL

`shared/usage/ranges.js` 同时包含浏览器 label 和 PostgreSQL filter/bounds SQL。应拆为 shared range definition 与 server-only SQL。

## 6.7 CSS 覆盖层偏重

扫描结果：

```text
styles.css 约 824 个 selector
重复 selector 约 261 个
```

存在同一规则内重复声明，例如 `:root` 的 `--bg`、`body` 的 background/color。部分是主题覆盖意图，但仍有可以清理的旧值和 cascade 复杂度。

---

# 7. 性能评估

## 已有优点

- JobStore 读取热路径已经避免每次全表 sweep；
- 静态 bundle 有 fingerprint cache 和 metadata TTL；
- 图片对象 URL 有上限并会 revoke；
- KaTeX/highlight/Mermaid 部分延迟加载；
- 前端有 render cache、scheduler、virtualizer；
- 请求体和图片响应有大小限制；
- SSE 关闭时清理 subscriber。

## 当前资源规模

动态 JS bundle：

```text
156 个 entry
原始：2,408,620 bytes
gzip：580,495 bytes
Brotli：502,095 bytes
```

CSS bundle：

```text
原始：490,770 bytes
gzip：74,990 bytes
Brotli：68,731 bytes
```

Mermaid 压缩后仍约 739 KB Brotli，已经正确延迟加载，但低端移动设备仍需关注首次使用成本。

## 性能风险

1. 已修复：日志热路径改为有界异步队列；
2. 首次 bundle Brotli/gzip 同步压缩；
3. 浏览器一次执行约 144 个应用脚本；
4. 路由兼容 fallback 最多可进行多次 provider attempt；
5. 统计校验缓存和限流桶缺少上限；
6. 上游非流式响应大小限制：按用户要求暂不处理。

---

# 8. 智能处理能力评估

## 结论

当前项目是：

> **安全优先、强约束、资源可追溯的智能路由器**

不是：

> **可自主规划、调用多个工具、验证结果并长期记忆的通用 Agent**

## 能力评分

| 能力 | 评价 |
|---|---:|
| 意图协议设计 | 8.5/10 |
| 资源绑定和防误执行 | 8.5/10 |
| 上下文连续性 | 8/10 |
| 任务恢复与持久化 | 7.5/10 |
| Provider 兼容性 | 7.5/10 |
| 真实模型准确率证据 | 已建立：56 案例单次可达 100%，重复运行约 97.95–100 |
| 自主规划能力 | 5.5/10 |
| 多步工具编排 | 5/10 |
| 长期语义记忆 | 5.5/10 |
| 工程成熟度 | 7/10 |

## 已做得好的智能能力

### 8.1 路由协议边界正确

`route_intent.v3` 只允许模型决定：

```text
operation
relation
goal
goal_mode
resource_refs
task_shape
```

模型不能直接决定 API、最终参数、规范资源 ID、context policy、幂等键和 dispatch 权限；应用层负责编译为 `dispatch_contract.v1`。这是正确的安全架构。

### 8.2 资源绑定能力较强

系统已经覆盖：

- 当前图片；
- 历史图片；
- 引用消息；
- 文件；
- target/reference/style_reference/mask；
- `iN/fN/mN` 候选键；
- durable resource identity；
- binding evidence；
- 服务端二次校验。

### 8.3 图片任务连续性明显优于普通聊天应用

`task_continuity.v1` 和 `image_task_lineage.v1` 能防止：

- “继续上一张图”绑定错误；
- 批次中最后完成的 child 覆盖其他任务；
- 刷新后恢复错误分支；
- 损坏结构化状态静默回退旧文本。

### 8.4 倾向澄清而不是盲猜

多图目标不明确、mask 数量错误、资源过期、角色冲突、provider 能力不足时，系统通常会进入 clarification，而不是直接执行猜测结果。

### 8.5 Web Search 授权边界清楚

`web_search` 只有在明确的不可变执行计划授权后才进入最终请求，普通聊天不能随意注入工具。

## 智能能力不足

### 8.6 已建立真实模型基线，但存在非确定性

当前 fixture：

```text
56 个路由案例
51 个 safety-critical 案例
```

已使用 `gpt-5.6-sol` 通过 Codex 配置的 Endpoint 真实调用。完整集曾取得 56/56、平均 100、合法路由 100%、安全关键完美率 100%；但多次复测会在少数边界案例上随机波动，完整集观测范围约为 97.95–100。

因此结论不是“模型已永久 100%”，而是：

- 路由提示词、schema、编译器和安全门禁已经较成熟；
- 大多数失败是原始模型输出的随机语义/资源冗余，不是编译器放行错误执行；
- 仍需要重复采样、稳定性指标和更多真实用户语料，才能评价长期泛化能力。

### 8.7 过度依赖正则和规则

路由核心包含大量中英文规则来识别：

- 继续、刚才、不是这张图、改成、总结、搜索；
- 历史 ordinal；
- 文件动作；
- 图片编辑动作；
- 多图和资源排除。

这些规则提升了可控性，但长期会产生规则互相覆盖和新表达漏判问题。

### 8.8 没有真正的概率型不确定性

`confidence: 1` 不是经过校准的模型概率。建议增加 operation、relation、resource 和 ambiguity 的独立评分。

### 8.9 路由模型只看元数据

路由不读取图片二进制、Base64 或文件全文。这样安全、便宜，但会降低依赖内容本身才能判断的任务准确率。当前采用“路由看元数据，最终模型看内容”的策略，是合理折中，但不能称为完全内容感知的路由。

### 8.10 非图片多步任务还不能真正自主拆解

`task_shape=multi` 对非图片任务主要用于标记“需要拆分并阻止发送”，还没有完整的 DAG planner、工具依赖图、中间结果 schema、部分成功恢复和人工审批节点。

### 8.11 Web Search 还没有事实核验层

系统能抽取 citation/source，但没有验证每个结论是否被引用支持，也没有来源质量、冲突和过期检测。

## 建议增加的智能指标

```text
operation accuracy
relation accuracy
goal preservation rate
resource binding accuracy
false dispatch rate
unsafe dispatch rate
unnecessary clarification rate
multi-task decomposition accuracy
route latency
provider retry count
route cost per message
```

应按中文/英文、单轮/多轮、有图/无图、有文件/无文件、当前资源/历史资源、明确/模糊指代等维度分组。

---

# 9. 建议实施顺序

## 第一阶段：安全与状态机

1. 跨源重定向凭据/body：**按用户要求暂缓**；
2. 统一上游响应大小限制：**按用户要求跳过**；
3. 排队任务 abort 后仍执行：**已完成**；
4. AbortError 覆盖用户停止语义：**已完成**；
5. 幂等 principal 隔离、SHA-256 fingerprint 冲突和失败可重试：**已完成**；
6. 统计/反馈与自定义 Endpoint 产品策略：**待明确**。

## 第二阶段：运行时稳定性

1. 恢复所有数字环境变量校验；
2. 限制 usage cache；
3. 限制 usage rate-limit buckets；
4. 增加统计校验 in-flight 合并；
5. 修复 Accept-Encoding q 值；
6. 修复启动日志实际 host/port；
7. 将同步日志改为异步队列：**已完成**。

## 第三阶段：维护成本

1. 合并两套 Job event parser；
2. 合并 persistence 双轨；
3. 统一 redaction；
4. 拆分 route-service.js；
5. 抽取 Markdown core；
6. 拆开 shared SQL；
7. 清理 CSS cascade；
8. 自动生成静态资源版本和 vendor manifest；
9. 补充正式 License 文件。

## 第四阶段：智能评估

1. 配置真实 route model；
2. 跑完 56 个 fixture；
3. 增加 200–500 个真实用户表达并人工标注；
4. 统计准确率、误执行率、澄清率和延迟；
5. 校准 confidence/ambiguity；
6. 再扩展非图片任务规划能力。

---

# 10. 最终结论

## 架构

项目已经是有设计、有边界、有测试和发布治理的中大型前后端一体项目，但仍处于旧入口、兼容 facade 和新模块并行迁移阶段。

## 冗余

没有发现完全重复文件，但存在明显的业务逻辑级重复，集中在 Job 事件、持久化、Markdown、日志脱敏、路由编译和图片动作。

## 性能

低并发单用户使用基本可接受；同步日志 I/O 已改为有界异步队列，后续仍需处理统计缓存/限流桶、首次 bundle 压缩和多次路由 fallback。响应大小限制按用户要求暂不纳入本轮。

## 智能

如果目标是轻量聊天、生图、修图、文件问答工作台，当前已经达到比较成熟的安全型智能水平；如果目标是通用自主 Agent，目前还缺少多步规划、工具 DAG、结果验证、长期记忆和真实准确率评估。

**P1 状态机、幂等和日志热路径优化已完成；下一步应处理 usage cache/rate-limit 的边界与路由模块维护成本。**
---

# 11. 本轮直接优化实施结果（以本节为最终状态）

## 11.1 已完成：Job 取消状态机

涉及：

- `server/concurrency.js`
- `server/jobs/cancellation.js`
- `server/jobs/chat.js`
- `server/jobs/image.js`
- `server/jobs/image-batch.js`
- `server/jobs/common.js`
- `server/jobs/events.js`
- `server/jobs/store.js`
- `server/proxy/openai.js`

结果：

1. 并发限制器的排队 waiter 支持 `AbortSignal`；停止排队任务会立即移出队列，之后不会取得槽位调用上游。
2. Job 的取消请求拥有独立、不可枚举的状态；用户停止、运行超时和淘汰都通过统一取消路径传播。
3. 聊天、图片、批量图片和直通代理的上游请求都继承 Job 取消信号。
4. await 前后检查 Job 是否仍可运行，迟到成功响应不能把停止任务改回 `done`。
5. 迟到 `AbortError` 不再把用户看到的“任务已停止”改写为“上游超时”。
6. 批量父任务停止/超时会级联取消 child。

专门门禁：`test/unit/job-cancellation-regression.test.js`。

## 11.2 已完成：幂等正确性

涉及：

- `server/validators/idempotency.validator.js`
- `server/security/job-ownership.js`
- 聊天、图片和批量 Job handler

结果：

1. 保留浏览器兼容的 `ep1-*` 32 位外部键，但服务端使用完整 SHA-256 内容 fingerprint 二次核验。
2. 外部键相同但内容 fingerprint 不同返回 conflict，不再误报 `consumed`。
3. 幂等记录按 principal 与 submission/job 范围隔离，不同用户/提交不互相阻塞。
4. 失败、停止和取消任务释放 reservation，可用同一计划重试。
5. 同一 submission 修改内容仍会被判定为冲突，防止误复用。

专门门禁覆盖已知 32 位碰撞、跨 principal、失败后重试和同 submission 冲突。

## 11.3 已完成：智能路由增强

涉及：

- `client/services/route-service.js`
- `test/fixtures/intent-routing-eval.v3.json`
- `scripts/lib/intent-routing-evaluation.js`
- 路由强事实、提示词和在线评测测试

新增或修正的能力：

- 多图合并/融合生成一张新图稳定选择 `image_reference_gen`；
- 仅配色/色调参考使用 `style_reference`；
- 明确沿用参考图生成新版本不会误变成 `edit_image target`；
- `target`、`mask`、`reference` 角色在 goal 和资源绑定中保持分离；
- 未交付图片的“图片呢”恢复前序图片任务，不误走普通说明；
- 紧接设计任务的短视觉约束保留前序主体/任务类型；
- 自足文本请求不无谓绑定历史 `mN`；多个历史编辑候选未选定时进入真正的 ambiguous clarification；
- `continuation`、`followup`、`goal_mode=replace|amend` 的正交关系更清楚；
- amendment 只去除高置信重复 base，不再把首个真实增量连同分号前内容一起删除；
- `replace` goal 不再误走 amendment 清理而丢掉完整基础目标；
- evaluator 能识别明确撤销旧约束、中文/阿拉伯数字序号和常见等价表达，且正则概念按字面转义。

路由 system prompt 最终为 `5000` 字符，满足现有有界提示词门禁。

## 11.4 最终验证

```text
npm run check
Project checks passed for v1.10.72
Architecture checks passed
JavaScript syntax checks passed for 486 controlled files
All 1452 tests across 255 files passed
```

真实模型：

```text
Endpoint: https://ingress.lfans.cn/v1
Model: gpt-5.6-sol
完整集最佳观测：56/56，100/100，安全关键 100%
重复完整运行范围：约 97.95–100
```

必须强调：模型输出并非完全确定。单次完整满分证明当前协议可以被模型完整执行，但不能证明每次请求都稳定满分。运行时仍保留 fail-closed、动态候选 enum、资源二次编译和强事实归一化，避免偶发模型偏差直接变成错误执行。

环境限制：没有 Docker CLI/daemon，因此未运行 `npm run preview:release`。本轮没有提交、推送或发布。

## 11.5 当前智能程度结论

如果目标是聊天、文件问答、看图、生图、修图、历史资源选择和多图批处理，本项目现在属于**较强的受控智能工作台**：

- 路由协议和资源追溯：强；
- 图片连续性与纠错：强；
- 错误执行防护：强；
- 原始模型输出稳定性：较强但非完全确定；
- 通用自主 Agent、多工具 DAG、长期语义记忆、事实核验：仍不足。

因此“够不够智能”的答案是：**作为受控多模态 ChatUI 已经足够智能；作为通用自主 Agent 仍不够。**

## 11.6 下一步优先级

第一阶段的功能根因修复已经完成。下一步建议按以下顺序继续：

1. **统一限制上游非流式响应大小**：按你的要求跳过；
2. **继续拆分 `route-service.js`**：下一切片迁移资源绑定与 clarification slot 编译；
3. **增加多次采样稳定性指标**（同一 56 案例重复 N 次，统计每案例通过率）；
4. **建设真正的非图片多步 planner / DAG 和结果核验层**。


凭据转发相关问题按用户要求暂缓，不列入当前功能优先队列。
---

# 12. 2026-08-24 继续优化：日志异步化

你明确不需要响应大小限制，因此本轮跳过该项，继续处理下一项性能问题：同步日志 I/O。

## 12.1 实现内容

- `server/logging/logger.js`：新增有界异步 NDJSON writer；
- `server/logging/access-log.js`、`server/logging/server-log.js`、`server/logging/request-trace.js`：统一使用异步 writer；
- `server/logging/index.js`：提供统一 `flush`、`close`、`stats` 生命周期；
- `server/app.js`：正常 `server.close()` 前等待所有日志队列关闭；
- `test/unit/async-log-writer.test.js`：验证无同步 FS API、队列上限、批量写入、异步轮转；
- `test/unit/logging-lifecycle.test.js`：验证四类日志在 close 前完整落盘；
- 更新 `README.md`、`docs/development.md`、`docs/architecture.md` 和手工验收用例，记录队列配置和 flush 语义。

## 12.2 行为变化

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 普通请求写 access log | 请求结束同步 stat/rotate/append | 只做脱敏、序列化和入队 |
| 日志洪峰 | 阻塞请求并可能无限积压 | 每类 writer 有条目/字节上限，满载显式 drop |
| 多条日志 | 每条单独文件写入 | 后台串行批量 append，保持顺序 |
| 文件轮转 | 请求热路径执行 | 后台 drain 执行 |
| 正常关闭 | 未明确等待日志落盘 | `server.close()` 回调前 flush/close |

## 12.3 验证结果

```text
Focused logging suites: 28 tests passed
npm run check: 1452 tests across 255 files passed
```

本机受控微基准（10,000 条约 700 KB NDJSON，队列上限调高以避免主动 drop）：

```text
同步入队阶段：13.63 ms
入队吞吐：约 733,417 records/s
包含异步落盘的总 flush 时间：40.36 ms
```

该数字不是生产吞吐承诺，但能证明 HTTP 热路径已经从逐条同步磁盘 I/O 变为纯内存有界入队；实际磁盘写入在后台批量完成。

本轮未运行 Docker preview；没有提交、推送或发布。
---

# 13. 2026-08-24 继续优化：usage 缓存与限流边界

本轮继续完成下一项运行时稳定性优化：usage/feedback 的上游访问校验与统计刷新限流。

## 13.1 已完成

- `server/services/usage-access.service.js`
  - TTL + LRU 有界缓存，默认 512 条；
  - key 纳入 endpoint、model 和 API Key 的 SHA-256；
  - 相同校验请求 in-flight Promise 合并；
  - in-flight 全局上限与明确忙碌错误；
  - outage 不写长期缓存，失败后可重试；
  - 提供 `stats/clear/sweep` 诊断与测试边界。
- `server/validators/usage.validator.js`
  - 默认最多 4096 个 IP/route 桶；
  - 周期性全局过期 sweep；
  - 达到上限淘汰最旧桶；
  - 保持不信任客户端 `X-Forwarded-For` 的原有策略。
- 新增 `test/unit/usage-runtime-bounds.test.js`，覆盖并发合并、LRU、endpoint 隔离、失败释放、过期清理和硬上限。

## 13.2 结果

- 100 个相同校验请求从最多 100 次上游 `/models` 降为 1 次；
- cache 和 rate-limit Map 都有明确内存上限；
- 不会把原始 API Key 放入 cache key 或诊断结构；
- 原有 usage API 契约和限流响应头保持不变。

本轮没有处理响应大小限制，符合你的要求。

验证：

```text
usage focused suites: 36 tests passed
npm run check: 1452 tests across 255 files passed
```
---

# 14. 2026-08-24 继续优化：拆分 route-service 提示词边界

本轮开始处理维护成本最高的 `client/services/route-service.js`，先抽取依赖最少、回归覆盖最完整的系统提示词边界。

## 14.1 已完成

- 新增 `client/services/route-prompts.js`；
- 集中维护：
  - `ROUTE_SYSTEM_PROMPT`；
  - `IMAGE_PLAN_SYSTEM_PROMPT`；
  - `IMAGE_INSTRUCTION_SYSTEM_PROMPT`；
- image-plan 绝对任务上限通过 `createRoutePromptSet()` 参数注入，不在新模块复制协议常量；
- `route-service.js` 通过模块注册表/Node require 组合 prompts，并继续导出原有公共常量，调用方无需修改；
- `index.html` 在 route-service 前加载 route-prompts；
- 新模块只注册到 module registry，不增加 `window.*`/`globalThis.*` 浏览器全局；
- 新增 `test/unit/route-prompts-module.test.js`，防止提示词重新内嵌回主文件；
- 静态 bundle 测试固定加载顺序。

## 14.2 结果

```text
route-service.js: 248472 -> 234532 bytes
route-service.js: 4720 -> 4683 lines
route-prompts.js: 15101 bytes / 68 lines
browser global exports: 168（没有增长）
npm run check: 1452 tests across 255 files passed
```

这是第一切片的历史说明；第二切片已经完成 semantic-normalizer 抽取。下一切片建议处理 memory-card 检索与候选目录的历史双实现。
---

# 15. 2026-08-24 继续优化：拆分 route semantic normalizer

本轮完成 `route-service.js` 的第二个拆分切片，把可确定强事实归一化与 amendment 清理迁到独立模块。

## 15.1 已完成

- 新增 `client/services/route-semantic-normalizer.js`；
- 迁移：
  - 未交付图片追问恢复；
  - 短视觉约束 relation 修正；
  - 明确参考图复用；
  - 任务替换的 followup 语义；
  - plain-chat 未发布候选键清理；
  - amend 重复 base 检测与安全裁剪；
- task continuity、图片 operation 集合、goal 长度和 generation pattern 通过工厂参数注入；
- `route-service.js` 只在编译边界调用 normalizer，不再内嵌这些规则；
- `index.html` 固定 normalizer 在 route-service 前加载；
- 不增加浏览器全局命名空间；
- 新增 `test/unit/route-semantic-normalizer-module.test.js`，并继续复用全部 route strong-facts/intent fixture 回归。

## 15.2 结果

```text
第二切片前 route-service.js：234532 bytes / 4683 lines
第二切片后 route-service.js：227201 bytes / 4556 lines
route-semantic-normalizer.js：9812 bytes / 177 lines
browser global exports：168（没有增长）
JavaScript syntax checks：486 controlled files
npm run check：1452 tests across 255 files passed
```

semantic-normalizer 之后，memory-card 检索和 canonical candidate catalog 两个切片也已完成。下一步迁移 model resource refs 到 canonical bindings 的解析和 clarification 编译。
---

# 16. 2026-08-24 继续优化：拆分 route memory retrieval

本轮完成 `route-service.js` 的第三个拆分切片，把历史图片 memory-card 的结构化和语义检索迁到独立模块。

## 16.1 已完成

- 新增 `client/services/route-memory-retrieval.js`；
- 迁移：
  - 中文/数字 ordinal 解析；
  - 第 N 次生成、倒数第 N 次生成；
  - 第 N 张历史图、倒数第 N 张图；
  - 最早/很早历史切片；
  - semantic token 匹配、排序和发布预算；
  - clarification 已选/已建立资源保护；
  - `resource_catalog.v1` 的 total/eligible/published/truncated/strategy metadata；
- `sharedCandidateTokens` 通过工厂注入，模块不拥有候选文本算法；
- `route-service.js` 保留 canonical candidate 转换、identity alias 去重和最终目录组装；
- `index.html` 和 static-bundle 门禁固定加载顺序；
- 新增 `test/unit/route-memory-retrieval-module.test.js`，继续复用全部 ordinal/catalog 集成测试；
- 不增加浏览器全局命名空间。

## 16.2 结果

```text
第三切片前 route-service.js：227201 bytes / 4556 lines
第三切片后 route-service.js：219886 bytes / 4397 lines
route-memory-retrieval.js：9959 bytes / 214 lines
browser global exports：168（没有增长）
JavaScript syntax checks：486 controlled files
npm run check：1452 tests across 255 files passed
```

canonical candidate catalog 切片已经完成。下一步建议迁移 model resource refs 到 canonical bindings 的解析、missing/ambiguous/unavailable slot 生成和 clarification choice 编译。
---

# 17. 2026-08-24 继续优化：迁移 canonical candidate catalog

本轮完成 `route-service.js` 的第四个拆分切片，增强既有 `route-candidates.js` 并让它接管 canonical candidate 主路径。

## 17.1 已完成

- `route-candidates.js` 新增 `createCanonicalCandidateDirectory()`；
- 迁移：
  - resource type/source/index 规范化；
  - native/canonical resource ID；
  - identity aliases 与 index aliases；
  - available/unavailable 判定；
  - 当前上传图片安全标签；
  - restored alias 去重；
  - sibling reference group 防误合并；
  - image/file/message candidate key 分配；
  - memory retrieval 结果合入 canonical catalog；
  - 非枚举 `resource_catalog.v1` metadata；
- `route-service.js` 通过工厂注入 resource-identity、attachments、memory selector 和 metadata Symbol；
- 原有 `createRouteCandidateDirectory()` API 保持不变；
- 新增 `test/unit/route-candidates-module.test.js`，并继续运行完整资源注册、历史图片、多图和 clarification 集成测试；
- 不增加浏览器全局命名空间。

## 17.2 结果

```text
第四切片前 route-service.js：219886 bytes / 4397 lines
第四切片后 route-service.js：204131 bytes / 4090 lines
增强后 route-candidates.js：26938 bytes / 536 lines
browser global exports：168（没有增长）
JavaScript syntax checks：486 controlled files
npm run check：1452 tests across 255 files passed
```

资源 binding/clarification 切片已经完成。下一步建议处理 route-service 的最终 dispatch compiler 与 image-plan compiler 边界。
---

# 18. 2026-08-24 继续优化：拆分 resource binding 与 clarification

本轮完成 `route-service.js` 的第五个拆分切片，将模型资源引用到 canonical binding 的转换和基础 clarification slot 编译迁移到独立模块。

## 18.1 已完成

- 新增 `client/services/route-resource-binding.js`；
- 迁移：
  - binding role alias canonicalization；
  - image/file/message/text 角色规范化；
  - `canonicalPlanBindings`；
  - `bindingForCandidate`；
  - candidate choice 投影；
  - missing/ambiguous/unavailable 基础 issue；
  - clarification slot/candidate key 重排；
  - plan binding 到 canonical resource 的解析；
- `route-service.js` 通过工厂注入 resource identity、source normalization、candidate catalog 和字符串/index helpers；
- 保留最终执行 compiler、业务澄清组合和特殊 route invariants 在主服务中，避免过度拆分导致行为变化；
- 新增 `test/unit/route-resource-binding-module.test.js`，覆盖角色、slot、candidate resolution 和 unavailable 资源；
- 静态加载顺序固定，未增加浏览器全局命名空间。

## 18.2 结果

```text
第五切片前 route-service.js：204131 bytes / 4090 lines
第五切片后 route-service.js：194805 bytes / 3876 lines
route-resource-binding.js：11483 bytes / 259 lines
browser global exports：168（没有增长）
JavaScript syntax checks：486 controlled files
npm run check：1452 tests across 255 files passed
```

下一拆分切片建议处理最终 dispatch compiler 与 image-plan compiler 的边界，把 `compileLocalRoute` 周围的合同物化和批量计划编译拆成独立、可测试的模块。

---

# 19. 2026-08-24 继续优化：拆分 image-plan compiler

本轮完成 `route-service.js` 的第六个拆分切片，将多图第二阶段规划结果到可执行单图 route 的编译迁移到独立模块。

## 19.1 根因

多图规划协议虽然已经由 `shared/image-plan.js` 校验，但 operation 映射、候选绑定恢复、图片参数覆盖、单任务折叠、批量组装、任务上限和 fail-closed 判断仍内嵌在 `route-service.js`。这造成三个问题：

1. 第二阶段规划逻辑与主 route 编译流程耦合，维护者难以判断修改影响的是协议解析、资源绑定还是 dispatch；
2. compiler 只能通过完整 route-service 间接测试，边界条件不容易独立覆盖；
3. 浏览器没有显式的 image-plan compiler 加载边界，后续继续拆分 `compileLocalRoute` 时容易重新形成循环依赖或重复实现。

## 19.2 已完成

- 新增 `client/services/route-image-plan-compiler.js`；
- 迁移并集中维护：
  - generate 无输入图 → `text_to_image`；
  - generate 有输入图 → `image_reference_gen`；
  - edit → `edit_image`；
  - `iN` / `fN` typed ordinal fallback；
  - task 级 quality/background/output_format 结构化覆盖；
  - product task limit；
  - meta instruction / 未解析图片引用 fail-closed；
  - 单任务折叠和 batch 结果组装；
- compiler 通过工厂注入 image-plan validator、候选目录、binding builder、最终 local route compiler 和安全检查函数，不直接依赖 DOM、session 或 provider；
- `route-service.js` 仅负责组合该模块并保持 `shouldRequestImagePlan`、`compileImagePlan` 公共 API 不变；
- `index.html` 明确在 resource binding 之后、route-service 之前加载 compiler；
- `docs/architecture.md` 和 static bundle 门禁同步记录该边界；
- 新增 `test/unit/route-image-plan-compiler-module.test.js`，覆盖 9 项独立回归场景，并继续复用现有多图 workflow、over-limit、reference routing 和 execution projection 集成测试；
- 未修改上游响应大小策略，也未改变凭据转发行为。

## 19.3 正确性与性能边界

- planning task 的自然语言 prompt 仍只作为 provider 内容，`parameterInput=''`，不会被二次解析成图片参数；
- structured task controls 覆盖 UI 默认值，显式 `auto` 不会错误回退到历史设置；
- catalog 重建后仍可按同类型序号恢复 `iN` / `fN`，防止 durable candidate key 变化导致资源丢失；
- 任一 child route 需要澄清、缺少 dispatch contract、包含 meta instruction 或未解析会话引用时，整个 plan 失败关闭，不执行部分批次；
- 产品上限在协议编译前返回专用 `IMAGE_PLAN_OVER_LIMIT`，不会把 6–50 项合法结构输出误报成 generic invalid plan；
- compiler 不增加新的浏览器全局，仅注册到私有 module registry。

## 19.4 结果

```text
第六切片前 route-service.js：194805 bytes / 3876 lines
第六切片后 route-service.js：189096 bytes / 3754 lines
route-image-plan-compiler.js：7386 bytes / 167 lines
本切片主服务减少：5709 bytes / 122 lines
从最初拆分点累计减少：59376 bytes / 966 lines
browser global exports：168（没有增长）
Focused image-plan/module suites：73 tests across 7 files passed
JavaScript syntax checks：490 controlled files
npm run check：1461 tests across 256 files passed
```

当前 `route-service.js` 最大的剩余单体边界是约 413 行的 `compileLocalRoute`。下一切片应先拆最终 dispatch compiler：把 capability/parameter/resource projection/dispatch-contract 物化收敛成独立、可注入、可独立回归的 compiler，同时保留主服务中的语义归一化与业务协调职责。

