# ChatUI AI 工程导览

这份文档给后续 AI / 开发者快速理解 ChatUI 的工程结构、关键链路和定位入口。修改代码前仍以现场文件为准；本文件用于减少搜索成本，不替代测试和 diff 检查。

## 项目定位

ChatUI 是一个轻量的 OpenAI 兼容 Web 工具，核心能力包括：

- 常规聊天与流式 Job 恢复
- 文本生图
- 上传图片编辑
- 基于最近返回/生成图片继续编辑
- 多附件上传、文本/PDF/Office 解析
- Markdown、数学公式、Mermaid、代码复制
- 会话、本地持久化、IndexedDB 图片缓存

## 顶层入口

| 文件 / 目录 | 作用 |
| --- | --- |
| `index.html` | 页面结构、模板、配置弹窗、消息模板 |
| `styles.css` | 全局样式、响应式布局、消息/图片/配置面板样式 |
| `app.js` | 浏览器端主逻辑；当前仍是主要运行入口和业务编排点 |
| `server.js` | Node HTTP 启动入口，兼容部署入口 |
| `server/` | 服务端模块化代码：路由、代理、Job、附件解析、静态资源 |
| `client/` | 从前端主逻辑拆出的可测试模块：core / services / ui / app |
| `test/` | Node 单元测试、API 测试、冒烟测试 |
| `vendor/` | 本地前端第三方资源，例如 markdown-it、KaTeX、Mermaid |

## 前端模块分层

### `app.js`

`app.js` 是浏览器端实际业务编排中心，重点包含：

- 全局 `state`
- 配置读取/保存
- 会话管理
- 附件上传与预览
- 图片缓存与 IndexedDB 恢复
- 消息渲染与滚动控制
- 自动意图识别路由
- 聊天 / 生图 / 图片编辑请求调度
- Job 创建、SSE 订阅、刷新恢复

如果一个问题涉及真实 UI 行为，通常先在 `app.js` 搜索对应函数，再看 `client/` 中是否已有可测试拆分模块。

### `client/core/`

纯逻辑工具层，适合写单元测试。常见入口：

| 文件 | 关注点 |
| --- | --- |
| `attachments.js` | 附件类型判断、图片上下文归一化、图片编辑意图辅助、路由附件元数据 |
| `messages.js` | 消息内容、排序、去重、展示文本等纯逻辑 |
| `models.js` | 模型分类、模型元数据 |
| `reasoning.js` | reasoning 字段提取与展示逻辑辅助 |
| `storage.js` | localStorage/JSON 安全读写辅助 |
| `http.js` | 前端请求错误处理辅助 |

### `client/services/`

服务调用和 payload 处理逻辑，偏请求/任务层：

| 文件 | 关注点 |
| --- | --- |
| `chat-service.js` | 聊天响应解析、聊天 payload 辅助 |
| `image-service.js` | 图片接口结果解析、图片 Job 文件 payload |
| `job-service.js` | Job id、Job 请求封装、SSE/轮询辅助 |
| `model-service.js` | 模型列表加载与归一化 |

### `client/ui/`

UI 片段或交互辅助，目标是让纯 UI 逻辑可测试：

| 文件 | 关注点 |
| --- | --- |
| `message-renderer.js` | 消息 Markdown/HTML 渲染辅助 |
| `image-actions.js` | 图片操作按钮、下载、预览等辅助 |
| `message-actions.js` | 复制、重试等消息操作辅助 |
| `scroll-controller.js` | 滚动、锁定、恢复按钮相关辅助 |
| `realtime-renderer.js` | 流式更新展示辅助 |
| `file-actions.js` | 文件下载/命名等辅助 |

### `client/app/`

应用状态和持久化拆分模块：

| 文件 | 关注点 |
| --- | --- |
| `state.js` | 会话状态创建、busy 状态等 |
| `sessions.js` | 会话 key、标题、排序、元信息 |
| `persistence.js` | display/messages 持久化和恢复 |
| `image-store.js` | IndexedDB 图片缓存 |
| `runs.js` | active run、stop、恢复相关辅助 |
| `runtime.js` | 版本、提示音等运行时辅助 |

## 服务端模块分层

### 入口与装配

- `server.js`：启动 HTTP 服务。
- `server/app.js`：装配 `JobStore`、OpenAI 兼容代理、Job handlers、router、静态资源服务。
- `server/config/index.js`：端口、项目根目录、上游超时、允许代理路径等配置。

### 路由

- `server/api/router.js`：总路由分发。
- `server/api/routes/core.js`：核心 API，例如版本、图片代理、附件解析、聊天流注册。
- `server/api/routes/jobs.js`：聊天 Job 与图片 Job 的 HTTP/SSE 路由。

### Job 与上游调用

- `server/jobs/store.js`：内存 JobStore、过期清理。
- `server/jobs/chat-image.js`：创建聊天/图片 Job handlers 的组合入口。
- `server/jobs/chat.js`：聊天 Job、聊天流式结果处理。
- `server/jobs/image.js`：生图/图片编辑 Job。
- `server/jobs/common.js`：SSE 订阅、通知、abort 等公共逻辑。
- `server/jobs/reasoning.js`：reasoning 字段归一化。
- `server/proxy/openai.js`：OpenAI 兼容代理和图片代理。
- `server/proxy/headers.js`：请求头规范化和透传控制。

### 附件解析与安全

- `server/extract/`：附件文本提取，包含 PDF、Office、OpenXML ZIP 等。
- `server/security/url-policy.js`：上游 URL 安全策略，避免 SSRF 等风险。
- `server/http/`：请求 body、响应、安全头、静态文件服务。

## 核心请求链路

### 1. 用户提交入口

浏览器端从 `app.js` 的 `onSubmit` 进入：

1. 复制当前附件列表。
2. 准备附件预览。
3. 保存用户消息和 display 记录。
4. 创建临时 assistant pending 节点。
5. 调用 `getEffectiveRoute(...)` 做一次意图识别。
6. 根据返回结果分发：
   - `chat` → `sendChat(...)`
   - `image` → `sendImage(..., editMode=false)`
   - `edit_image` → `sendImage(..., editMode=true, editTarget=...)`

### 2. 意图识别路由

关键函数在 `app.js`：

- `buildRouteContext(...)`：构造给路由模型看的文字上下文和图片元数据。
- `latestImageReferenceMeta(...)`：只汇总最近图片引用的目标、数量和默认整组选择元数据，不判断用户意图。
- `buildRouteAttachmentMetadata(...)`：只提取附件元数据，不传附件正文、base64 或图片文件内容。
- `hasImageAttachments(...)`：判断本次附件中是否包含图片。
- `getEffectiveRoute(...)`：只调用一次意图识别模型，返回 `mode / target / usePreviousImage`。

路由原则：

- 常规聊天：`mode=chat,target=none`。
- 全新生图：`mode=image,target=new`。
- 图片编辑：`mode=edit_image`，并一次性识别目标：
  - `target=uploaded`：用户上传图。
  - `target=previous`：最近返回/生成图。
- 多图场景：
  - 路由上下文要保留图片组数量，例如 `count` / `imageCount`。
  - 用户明确指“第一张 / 第二张 / 左边 / 右边 / 全部”等时，应由意图识别阶段在文字层面识别选择范围；当前默认策略是 `selection=all`，即未明确单张时整组图片一起作为编辑输入。
  - 不允许为了判断是哪张图而把图片文件、base64 或附件正文发给意图识别模型；只能用消息顺序、文件名、类型、数量、图片组元数据和用户文字指代。
- 意图识别阶段不得把图片文件、base64、附件正文作为上下文；只允许文字上下文和附件元数据。
- 如果本次有附件但不包含图片，先完成附件文本解析，然后直接走聊天大模型，不进入意图识别阶段。
- 不要新增本地关键词兜底来替代意图识别；除“非图片附件直接聊天”外，`chat / image / edit_image` 必须来自单次意图识别模型结果。

### 3. 聊天链路

前端：

- `sendChat(...)`
- `buildChatPayload(...)`
- `startChatJob(...)` / `registerChatStreamJob(...)`
- `waitChatJob(...)`

服务端：

- `/api/chat-jobs`
- `server/api/routes/jobs.js`
- `server/jobs/chat.js`
- `server/proxy/openai.js`

### 4. 生图 / 图片编辑链路

前端：

- `sendImage(prompt, options)`
- `imageFilesToJobPayload(...)`
- `startImageGenerationJob(...)`
- `waitImageGenerationJob(...)`
- `imageResultToHtml(...)`
- `persistImageSrc(...)`

图片编辑目标来源：

- `editTarget=uploaded`：从用户上传图上下文恢复附件；如果用户一次上传多张图，默认恢复整组上传图作为编辑输入。
- `editTarget=previous`：从 `lastGeneratedImage.images` / IndexedDB 恢复最近返回图组；如果最近结果包含多张图，默认恢复整组返回图作为编辑输入。
- 后续如果支持单图选择，应只基于文字/元数据识别图片序号或位置，再从已有图片组中筛选；不要把图片内容交给意图识别模型。

服务端：

- `/api/image-jobs`
- `server/api/routes/jobs.js`
- `server/jobs/image.js`
- OpenAI 兼容图片接口。

### 5. 刷新 / 会话切换恢复链路

前端重点函数：

- `persistSessionDisplay(...)`
- `saveSessionMessages(...)`
- `loadImageJob(...)`
- `loadLatestChatJob(...)`
- `resumeImageJob(...)`
- `resumeChatJob(...)`
- `resumeSessionJobs(...)`

图片二进制不直接放 localStorage；生成/上传图片通过 `IndexedDB` 保存，display/messages/lastGeneratedImage 保存 `indexeddb://...` 引用。

## 图片上下文与缓存约定

- 图片二进制：IndexedDB，store 由 `client/app/image-store.js` / `app.js` 中的 image store helper 管理。
- 图片引用：`indexeddb://<key>`。
- 最近生成图：`state.lastGeneratedImage` + session `lastGeneratedImage` + localStorage session key；多图结果保存在 `lastGeneratedImage.images[]`。
- 用户上传图上下文：用户消息的 `imageContext`；多图上传保存在 `imageContext.attachments[]`。
- 图片编辑目标识别依赖文字上下文、消息顺序、`lastGeneratedImage`、`imageContext`、display 元数据；不应读取图片内容。
- 未明确单张时，多图按整组处理，避免误选其中一张。

## 修改建议

1. **先定位链路**：UI 问题看 `app.js` 和 `client/ui`；纯逻辑问题优先看 `client/core` / `client/services`；服务端 API 看 `server/api` + `server/jobs`。
2. **优先补测试**：纯函数改动优先补 `test/unit/*`；服务端路由改动补 `test/api/*`；端到端行为至少跑 `npm test`。
3. **避免大面积格式化 `app.js`**：该文件体积大、压缩风格明显，尽量小范围替换，避免制造噪音 diff。
4. **图片链路要同时考虑**：`messages`、`display`、Job 记录、`lastGeneratedImage`、IndexedDB 引用、刷新恢复。
5. **路由模型不要接触附件内容**：新增路由上下文时只加文字和元数据，不能传图片/base64/附件正文。

## 常用验证命令

```bash
node --check app.js
node --check server.js
node --check client/core/attachments.js
node test/unit/attachments-test.js
npm test
```

修改单个模块时，优先跑对应单测；交付前至少跑一次 `npm test`。
