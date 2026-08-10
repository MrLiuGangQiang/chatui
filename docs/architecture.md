# ChatUI 架构与模块边界

本文描述当前仓库的运行结构、依赖方向和演进约束。它既是新增代码的边界说明，也是评审根静态入口、浏览器模块、服务端模块和共享代码时的基准。

## 1. 运行形态

ChatUI 没有独立的前端构建步骤。Node.js 服务同时承担两类职责：

1. 提供根 HTML、动态静态 bundle、模块、样式和 vendor 资源；
2. 提供配置、版本、任务、使用统计和 OpenAI 兼容代理 API。

浏览器通过 `index.html` 启动应用。`server/services/static-bundle.service.js` 读取 `index.html` 中的 `chatuiAssetManifest`，按清单顺序组合 JavaScript 与 CSS，并由 `server/http/static.js` 以 `/assets/chatui.bundle.js` 和 `/assets/chatui.bundle.css` 提供。入口响应会把 bundle URL 重写为基于内容 ETag 的版本。

Docker 镜像直接复制运行所需的根文件和目录，不会从 `dist/` 启动，也不会在镜像构建时生成另一套应用源码。

根目录 `version.json` 是唯一版本事实来源；服务端通过 `server/version-source.js` 读取它。`package.json` 与 `package-lock.json` 只保留 npm 安装所需的同步镜像，发布脚本会自动维护这些镜像。

## 2. 根静态入口与独立页面

以下文件是受保护的运行入口与独立页面：

- `index.html`：主页面、模板和静态资源装载清单；
- `pages/route.html`：意图识别流程图页面；
- `pages/files.html`：支持的文件格式与上传约束说明页面；
- `app.js`：现有浏览器兼容启动与编排入口；
- `styles.css`：根样式入口；
- `favicon.svg`：站点图标；
- `server.js`：Node.js 进程入口。

这些文件由项目检查、静态服务器、Dockerfile、runtime identity 和测试共同依赖。修改、移动或删除任一根静态入口或独立页面时，必须一起检查：

- `server/http/static.js` 的公开路径和缓存策略；
- `server/services/static-bundle.service.js` 与 `index.html` 的清单顺序；
- `Dockerfile` 的 `COPY` 范围；
- `server/build-identity.js` 的运行文件范围；
- unit、smoke 和 Exact Docker runtime 测试；
- README 与本文档。

不要在根目录再增加一套与 `client/` 重复的业务实现。新业务逻辑应进入下面定义的所属模块，根 `app.js` 只保留兼容启动、装配和逐步迁移所必需的代码。

## 3. 浏览器代码

### 3.1 `client/core/`

`client/core/` 保存可独立测试的领域规则和纯逻辑，例如消息、模型、附件、上下文预算、图片引用、执行资源、任务状态和输入保护。

约束：

- 不直接操作 DOM；
- 不直接发起网络请求；
- 不依赖服务端目录、数据库、文件系统或凭据；
- 输入和输出应是普通数据或显式传入的依赖；
- `client/core/browser.js` 是把 core 能力注册到浏览器命名空间的兼容适配层，不代表 core 逻辑可以依赖浏览器全局。

### 3.1.1 稳定原语与协议模块

以下模块是跨工作流复用的浏览器侧稳定原语。它们应保持输入/输出明确、可在 Node 测试中独立加载，并通过兼容注册表提供给浏览器工作流：

- `shared/route-intent.js`：作为模型边界最小协议 `route_intent.v1` 的严格 schema 与校验事实来源；模型输出固定为 `operation`、`relation`、`goal`、`resource_refs` 四个字段，`goal` 表达消歧后的用户目标，协议版本由 schema 名称承载而不在每次结果中重复；图片、文件和历史消息统一使用 `iN`、`fN`、`mN` 候选键，该协议不包含 API、最终执行参数、上下文策略、幂等键或规范资源身份；
- `client/services/route-service.js`：负责把 canonical route context 投影为模型输入；当前用户消息不得重复进入历史候选，路由窗口内的既有文字消息与经过结构预算裁剪的图片/文件候选全部可见，超限时按明确的容量策略淘汰。引用消息、会话焦点、上一执行资源组和历史候选都只是模型证据，本地不得再按关键词、焦点或 lineage 隐藏候选并替模型判断语义；图片/文件正文和规范资源身份始终保持本地。路由输入长度必须复用 `client/core/preflight-guards.js` 的 `MAX_USER_MESSAGE_CHARS`，不得在 service 或 workflow 中复制另一套阈值。
- `shared/dispatch-contract.js`：作为 `dispatch_contract.v1` 的最终执行计划、绑定字段、上下文策略、稳定幂等键和 payload 一致性校验事实来源；
- `shared/capability-registry.js`：作为操作、API、参数类型、参数冲突、资源类型/角色/数量约束，以及“当前轮明确请求”的非执行性路由指令（操作、关系、资源作用域）的能力注册表；确定性图片参数解析只使用与原文等长的 analysis view 做全半角语法归一化，provider prompt 保留原文。候选必须保留 span、原文 evidence 与否定极性，同一参数的重叠命中按最长 span 优先；常见中英文否定后只有一个合法补集时才可确定性选择，否则进入澄清，不能回落到可能违背否定的 `auto`，澄清选项也不得重新提供已排除值；
- `client/core/resource-identity.js`：作为图片、文件和消息的稳定资源身份事实来源；
- `client/core/message-primitives.js`：统一上下文解析、消息稳定身份和 reasoning 引用文本清理；
- `client/core/image-execution.js`：校验图片生成/编辑的角色映射、执行资源和 multipart 位置，确保 `target`、`reference`、`style_reference` 与 `mask` 不在工作流之间漂移；
- `client/core/text-hash.js`：统一渲染缓存、性能统计和使用量视图的文本哈希实现，调用方只能通过公开格式使用哈希，不能再复制 FNV-1a 变体。

这些模块不应直接依赖 DOM、`fetch`、应用 session 状态或上游 API；浏览器注册只属于装配层。

### 3.2 `client/services/`

`client/services/` 负责浏览器侧 API 调用、请求 payload 组合和响应解析，包括模型、聊天、路由、图片、Job、运行时版本和使用统计服务。

约束：

- 可以依赖 `client/core/` 和 `shared/` 的契约；
- 网络、副作用和序列化边界应集中在 service 中并允许注入 `fetch` 等依赖；
- 不直接渲染 DOM，不拥有会话 UI 状态；
- 不绕过 core 契约自行推断资源身份、任务状态或路由语义。

`client/services/browser.js` 和 `composition.js` 是现有浏览器命名空间的组合适配层。

### 3.2.1 路由与请求服务的拆分边界

`client/services/route-service.js` 保留路由服务的公共兼容 API，但内部职责已经按以下边界拆分：

- `route-service.js`：从当前附件和有界上下文建立有序候选资源目录，构造路由请求，解析模型返回的 `route_intent.v1`，并把模型选择的短候选键映射回规范资源；本地只做 schema、候选存在性、角色、数量、可用性与执行契约校验，再生成最终、不可变的 `dispatch_contract.v1`，不得重新解释用户文本并覆盖模型的 operation、relation、goal 或 resource refs；
- `request-compatibility.js`：仅在上游明确不支持 Structured Output 时按 `json_schema` → `json_object` → 移除 `response_format` 的顺序做协议能力降级；普通网络错误不得触发重复请求，原始 payload 不得被修改；
- `server/validators/dispatch-contract.validator.js`：在服务端最终执行边界再次校验计划、资源证据、参数和上下文策略。

路由模型输出的 `route_intent.v1` 是唯一语义裁决结果：`operation`、`relation`、`goal` 与 `resource_refs` 都由模型负责。`resource_refs` 非空时，`goal` 必须是已完成资源消解后的自足执行指令，执行层不得再次把原始位置描述交给下游模型重新选择附件。本地编译器只从模型实际看到的候选目录重建绑定，以共享能力注册表校验资源类型、角色、数量和可用性，并生成最终、不可变的 `dispatch_contract.v1`；它不能用正则、关键词、会话焦点或资源顺序覆盖模型结果。上下文策略固定为：有消息绑定时 `bound_only`，`relation=new` 且无绑定时 `none`，其他无精确绑定的情况为 `conversation`。最终发送受模型窗口约束，超限时先丢弃最早的非绑定历史，不生成摘要；精确绑定消息与当前消息必须保留，否则失败关闭。未配置意图模型、模型超时、所有模型不可用或输出不符合协议时一律阻止执行，不得降级为本地路由或普通聊天。

意图管线的可靠性边界如下：
- 意图识别是延迟敏感路径，`route-service.js` 的 `buildRoutePayload` 对 gpt-5 系列路由模型统一附加浅推理档 `reasoning_effort: low`（`INTENT_REASONING_EFFORT`），历史消息与引用消息内容在 wire 层截断到 240 字符；这些是请求层延迟约束，不改变"路由模型是唯一语义裁决者"的边界，本地不得增加第二套语义系统。

- `client/app/submit-workflow-policy.js` 是 60 秒意图预算和取消错误工厂的唯一事实源。提交、重生成、primary 模型、fallback 模型、Structured Output 兼容调用以及同步响应校验共同消费同一个绝对 `deadlineAt`；相对 deadline 只能缩短、不能延长已有绝对预算。即使底层 request adapter 忽略 `AbortSignal`，外层 race 也必须按截止时间结算，且兼容层每次实际请求前必须重新校验预算，禁止迟到失败在 deadline 后触发下一次 provider 调用。
- 用户停止与超时是不同终态：停止抛出 `AbortError` / `ROUTE_INTENT_CANCELLED`，超时使用 `ROUTE_INTENT_TIMEOUT`。工作流在持久化澄清、准备 handoff 和提交终态前必须重新检查取消；handoff 与完成/失败/停止事件都必须幂等，同一尝试只能提交一个终态。
- 核心上下文的构建、裁剪或结构校验失败统一为 `ROUTE_CONTEXT_BUILD_FAILED`，模型调用前失败关闭为 `route_context_unavailable`；只有本地、非执行必需的图片 memory cards 可以独立降级。日志只记录错误 name/code，不记录对话原文。
- HTTP 请求错误必须保留 status、provider code 与 retryable 身份。401、403、429 和其他 4xx 不切换第二模型；只有 5xx、明确网络故障或无 4xx status 的明确可重试错误可以尝试模型 fallback。输出非法仍可尝试独立 fallback 模型，但最终仍须通过严格 schema 与执行契约。

### 3.3 `client/ui/` 与 `client/features/`

`client/ui/` 保存 DOM 渲染、交互、滚动、消息操作、图片操作、实时渲染和使用统计视图辅助代码。`client/features/` 保存边界更集中的界面功能，例如消息 Markdown 展示、引用预览、历史导航和澄清展示。

约束：

- UI 只消费已规范化的数据和显式回调；
- 不直接拼装上游 OpenAI 请求；
- 不自行维护与 canonical message、task state 或 session state 竞争的第二份事实来源；
- 可访问性、焦点、事件解绑和资源释放属于 UI 实现的一部分。

### 3.4 `client/app/`

`client/app/` 是应用状态和工作流编排层，负责会话、持久化、提交、任务生命周期、恢复、图片工作流、Markdown 启动、配置与对话框等跨模块流程。

允许依赖 `client/core/`、`client/services/`、`client/ui/`、`client/features/` 和 `shared/`，但不应把这些层已有的底层规则复制到 workflow 中。工作流应通过显式依赖或应用 registry 组合能力，避免继续增加浏览器全局和 `with (...)` 注入范围。

### 3.4.1 应用策略与 Markdown 边界

- `client/app/submit-workflow-policy.js`：提交工作流的纯策略，包括消息索引解析、意图管线单一绝对 60 秒截止时间、可取消且可主动 race 的请求、澄清状态迁移和澄清展示辅助；具体 DOM/UI 副作用仍留在 `submit-workflow.js`；
- `client/app/submit-workflow.js` 与 `client/app/regenerate-workflow.js`：共享任务生命周期不变量；停止后不得持久化 assistant 澄清、发起业务 handoff 或提交完成事件，durable handoff 与 terminal event 必须按 submission/job identity 幂等；
- `client/app/execution-status.js`：统一路由与最终执行阶段的高层状态词汇和 operation 映射；状态只由真实工作流事件推进，等待区原位更新且不记录或展示模型隐藏推理链；
- `client/services/session-snapshot-recovery.js`：会话快照的降级存储、配额错误恢复、部分快照合并和 revision 保护；它不能替代 canonical message/session store，也不能让 pending display 覆盖已提交消息；
- `client/app/markdown/engine-primitives.js`：统一 task-list fallback、表格对齐 class、blockquote fence 规范化、实体解码和高亮结果校验；Node 与 Browser Markdown engine 都复用它；
- `client/app/markdown/sanitizer-policy.js`：统一 DOMPurify 标签、属性、URI 和 style 白名单及 hook。`browser-sanitizer.js` 与 `sanitizer.js` 只负责注入运行时依赖和调用策略，不能各自维护安全白名单。

Markdown 增强运行时（KaTeX、highlight.js、Mermaid）仍由本地 vendor/dependency loader 提供；将其从 Node 生产依赖移出不等于移除浏览器功能。

### 3.5 其他浏览器目录

- `client/config/`：公开、非敏感的浏览器配置常量和 storage key；
- `client/domain/`：领域类型或兼容契约；其中仅供类型文档/测试使用的文件不得加入浏览器资产清单；
- `test/helpers/`：Node-only 测试源码断言与测试辅助代码，不属于浏览器运行契约，也不得被生产模块依赖。

### 3.6 浏览器模块注册表与静态加载顺序

`client/runtime/module-registry.js` 在 `Symbol.for('chatui.module-registry.v1')` 下提供隐藏的模块注册表。新拆出的模块通过 registry 注册并按名称解析，避免继续增加 `window.ChatUI*` 顶层导出；旧 namespace 仅为现有兼容入口保留。注册表不是业务状态，也不能成为跨模块的隐式可变容器。

`index.html` 的脚本顺序是运行契约，原则上应保持以下依赖先后：

1. `module-registry.js`、纯 core 原语和 Markdown policy/primitives；
2. 服务端无关的共享契约，特别是 `capability-registry.js` → `route-intent.js` → `dispatch-contract.js` → clarification 协议；
3. resource identity、route candidates 和 legacy adapter 等浏览器侧路由依赖；
4. `route-service.js`、`request-compatibility.js` 及其他 service 组合层；
5. `submit-workflow-policy.js`、`session-snapshot-recovery.js` 等 app policy，再加载对应 workflow；
6. 兼容启动和根 `app.js`。

变更加载顺序时必须同时运行静态 bundle 顺序测试，并确认根页面、`pages/route.html` 和 `pages/files.html` 的独立资源没有被误纳入或删除。

## 4. 服务端代码

### 4.1 `server/api/`

`server/api/router.js` 负责匹配方法和路径，并把请求分派到 `routes/` 与 `controllers/`。API 层负责 HTTP 契约、参数进入点、状态码和响应形状，不应承载可复用的业务实现或直接拼接复杂 SQL。路由器必须在一个统一的 `try/finally` access-log 边界中覆盖 core、OPTIONS、Job、proxy、static、400/405 与异常路径；每个请求恰好记录一次，并同时捕获显式 `writeHead` 与隐式 `res.statusCode`。具体 route 模块拥有其 canonical access-log 分类，router 不得把已匹配的 core endpoint 重新误标为通用 proxy。access log 写入失败必须转交 error log，不能改变原请求结果。

### 4.2 `server/services/`

服务端 use case 和外部集成层，例如 Release Notes、静态 bundle、图片编辑 payload、使用统计访问控制、问题反馈模型审核和钉钉投递。服务应以明确输入输出组合底层能力，避免依赖浏览器状态。反馈审核必须先于用户名查询和外部投递，模型拒绝或审核不可用时不得发送反馈。

### 4.3 `server/jobs/`

聊天与图片 Job 的生命周期、内存存储、事件订阅、停止、恢复、reasoning 和流解析位于这里。Job state 是服务端任务状态的事实来源；公开响应必须通过 compact/public snapshot 输出，不能把内部 buffer、凭据或原始大文件数据暴露给浏览器。

### 4.4 `server/http/`

负责 body 限制、响应、安全头、静态文件、压缩、ETag、缓存和公开路径。它不负责上游模型语义或浏览器工作流。请求 body 必须先按原始字节执行上限检查，再用 fatal UTF-8 decoder 一次性解码；非法字节序列返回 HTTP 400 / `INVALID_UTF8`，合法 U+FFFD 与跨 chunk 多字节字符必须保留。任何上游调用方都不得预先对 IncomingMessage 调用 `setEncoding('utf8')` 后再交给该边界。`server/http/static-path-utils.js` 集中提供静态服务与 bundle 服务共同使用的安全路径拼接和内容哈希，两个入口不得再各自维护路径穿越校验。

### 4.5 `server/proxy/` 与 `server/security/`

`server/proxy/` 负责允许路径内的 OpenAI 兼容转发、Header 处理、SSE、图片代理和上游错误规范化。`server/security/` 负责 URL/网络访问策略，以及服务端签发的请求 principal 和 Job ownership。`request-principal.js` 是匿名 principal Cookie 的签发、HMAC 校验、tenant 绑定与响应缓存隔离的唯一事实源；`job-ownership.js` 使用不可枚举 owner key 绑定 Job，并提供统一的 owner 比较，业务路由不得自行复制 Cookie 解析或 owner 映射。

只有该边界可以根据经过校验的 Base URL、API Key 和自定义 Header 发起上游请求。日志必须经过脱敏，不能记录凭据、文件 Base64 或图片 Base64。
本地持久请求追踪由 `server/logging/request-trace.js` 统一负责，并从 `server/app.js` 注入 proxy 与 Job 边界。客户端 pre-dispatch 校验失败只能通过受限的 `/api/client-execution-trace` 诊断端点提交结构化身份摘要，再由同一追踪器脱敏落盘；客户端不得直接记录原始 payload。追踪默认关闭；启用后以有界轮转 NDJSON 记录相关请求和结果，系统提示词与 reasoning 正文不落盘，签名 URL 查询参数和自定义 Header 值也不得记录。业务模块不得自行绕过该追踪器写入原始上游 payload。

### 4.6 `server/usage/`、`server/db/` 与相关层

- `server/db/`：PostgreSQL 配置和连接池；
- `server/usage/`：使用统计 SQL、查询结果规范化和工作簿输出；
- `server/api/controllers/usage.controller.js`：使用统计 HTTP 契约；
- `server/services/usage*.js`：用例和访问控制；
- `server/validators/`：输入校验。

数据库未配置时，使用统计应显式返回不可用状态，不能影响聊天、图片和静态页面等核心功能。

### 4.7 支撑目录

- `server/config/`：服务端环境变量、仅本机 `.env.local` 加载、公开配置和 build identity 装配；本机文件只能补充缺失变量，不能覆盖部署环境，也不能进入版本控制；
- `server/version-source.js`：读取并校验根目录唯一版本源；
- `server/errors/`：统一错误类型；
- `server/logging/`：安全日志；
- `server/validators/`：请求校验。

`server/app.js` 是服务端 composition root：创建数据库连接、JobStore、代理、路由和 HTTP server，并在 server 关闭时释放 sweeper 和数据库池。

### 4.8 生产依赖与浏览器 vendor 边界

根 `package.json` 的生产依赖只保留服务端运行所需的 `jszip`、`pg` 和显式锁定的 `undici`。Markdown 渲染器、DOMPurify、jsdom、KaTeX、highlight.js、Mermaid 及 markdown-it 插件属于开发/测试依赖或已提交的浏览器 vendor 资源；服务端入口不得在无 devDependencies 的生产安装中 require 它们。`server/jobs/common.js` 等 Node 运行路径应直接引用显式生产依赖，不能依赖开发依赖的传递安装。

## 5. `shared/` 边界

`shared/` 只用于浏览器和服务端都可以安全加载的稳定契约或纯函数。

禁止放入：

- 密钥、Header 值、数据库连接信息；
- Node.js 文件系统、进程、网络或数据库依赖；
- DOM、`window`、`localStorage` 等浏览器副作用；
- 服务端 controller、repository 或业务 SQL 的新实现；
- 只能由一侧理解的内部状态。

共享模块可以使用兼容 CommonJS/浏览器注册的外壳，但核心结果必须在两端保持一致。

Node-only 源码断言、fixture builder 和测试环境装配应放在 `test/helpers/` 或测试文件中，不得通过静态入口加载。

当前 `shared/usage/ranges.js` 同时包含展示标签和 SQL filter/bounds 字符串，是已知历史边界债务。新改动不得继续扩大该模式；目标边界是把浏览器安全的范围标识/标签留在 `shared/`，把 SQL 留在 `server/usage/`。

## 6. `vendor/` 边界

`vendor/` 是随应用发布的第三方浏览器资源，包括 Markdown、DOMPurify、KaTeX、highlight、Mermaid、插件和字体。

- 不放应用业务代码、配置或秘密；
- 不手工编辑 minified 文件；
- 更新时应同时核对上游版本、来源、License、loader URL、本地文件和回归测试；
- `vendor/chunks/` 当前不进入 Docker runtime identity；
- 大型增强资源可以延迟加载，但本地资源仍是默认部署能力的一部分。

## 7. 数据与请求流

### 7.1 页面启动

```text
GET /
  -> server/api/router
  -> server/http/static
  -> index.html + content-addressed bundle URLs
  -> browser core/services/ui/app registration
  -> bootstrap workflow
```

### 7.2 聊天、路由与任务

```text
用户输入/附件
  -> client core 预检和 canonical resource/context
  -> client app submit/route workflow
  -> client services 组装 API payload
  -> server API/router
  -> server-signed request principal
  -> Job owner / execution contract 校验
  -> server jobs 或 proxy
  -> 受限 OpenAI-compatible upstream
  -> SSE/Job event/JSON response
  -> client service parser
  -> task lifecycle + canonical message commit
  -> UI projection + session persistence
```

该链路必须始终满足：原始输入不因参数分析归一化而改变；上下文故障、非法模型输出和低确定性参数失败关闭；路由本身不授权高风险业务操作；停止、超时、失败与完成保持可区分且单终态；最终执行仍需服务端鉴权、参数和 `dispatch_contract.v1` 校验。Chat/Image Job 在进入创建、复用、查询、SSE、中止或删除边界时必须存在经服务端验证的 principal；owner 在 Job 放入 store 前一次性绑定且不可变，未授权与不存在的公开响应不得泄露差异，owner 信息不得进入 `publicJob`、日志或 trace。

浏览器保存会话、草稿、配置和持久化媒体引用；大媒体使用 IndexedDB。API Key 等敏感配置不得进入备份、Release Notes、日志或模型上下文。服务端 Job 当前以进程内存为主，进程重启后不能假定任务仍存在。默认 principal 也是匿名浏览器身份而非账号登录：同源浏览器自动携带 `HttpOnly` Cookie；独立 API 客户端必须保留 Cookie。多实例部署仍需要粘性会话或一致 Job 存储，并共享显式 principal secret；真实用户/组织多租户必须由可验证 JWT/OIDC 等受信任身份适配器提供，不能信任客户端自报 ID。

### 7.3 图片

图片生成和编辑遵循同一 canonical resource contract。`edit_image` 必须恰好有一个 `target`，并可同时携带内容 `reference`、`style_reference` 和至多一个独立 `mask`；`image_reference_gen` 只生成新图，不得伪装成带 `target` 的编辑。客户端只提交已校验的 source/target/reference/mask 绑定，并把多图角色按实际 multipart 顺序写入可审计映射；服务端 Job 和 proxy 负责验证映射、请求转换、上游调用、结果公开快照和停止/恢复。浏览器负责把结果持久化为稳定媒体引用并提交 canonical message。

### 7.4 使用统计

```text
浏览器统计 UI
  -> client usage service
  -> server usage controller/access service
  -> server usage repository
  -> optional PostgreSQL
  -> normalized JSON/XLSX
```

## 8. 禁止的依赖方向

以下方向默认禁止；确需例外时必须在架构文档和测试中明确：

- `shared -> client` 或 `shared -> server`；
- `client -> server`、数据库、SQL 或 Node-only runtime；
- `server -> client/app`、`client/ui` 或浏览器全局；
- `client/core -> client/services`、DOM 或网络；
- `client/services -> client/ui` 或应用 session state；
- `client/ui -> server payload/proxy implementation`；
- `vendor -> application code`；
- 新业务逻辑直接进入根 `app.js`；
- server-only 数据或凭据进入静态公开目录。

服务端可以依赖 `shared/`；浏览器 core/services/app/ui 可以依赖 `shared/`。高层编排可以依赖低层契约，低层契约不能反向依赖高层工作流。

- `docs/announcements` 由服务端 `announcements.service.js` 读取并通过 `/api/announcements` 提供给浏览器；`announcement-center.js` 负责未读判定、强制遮罩和历史展开。

## 9. 已知演进边界

以下是当前事实，不应被误写为已经完成的重构：

- 根 `app.js` 仍是较大的兼容入口，部分工作流实现和浏览器 namespace 仍在迁移；
- 一些 `client/app` 文件仍使用受 architecture baseline 约束的 legacy `with (...)` 注入；
- 浏览器仍保留多个 `window.ChatUI*` 兼容 namespace；
- `index.html` 清单仍含逐文件手工 query version，尽管最终 bundle URL 使用内容 ETag；
- Node-only 测试辅助代码已移出 Docker 会复制的 `client/` 静态目录；
- `shared/usage/ranges.js` 尚含 server-only SQL 字符串；
- vendor 的来源、版本和 License 更新尚未由统一 manifest 完全自动化；
- Docker 会复制 `docs/releases/` 与 `docs/announcements/`；公告目录参与 runtime source revision，Release Notes 仍保持文档归档语义；
- 当前 architecture check 主要冻结 `app.js` 大小、legacy `with` 和浏览器全局增长，并不是完整的依赖图验证器。

处理这些边界需要独立、可回归的重构，不应在无关功能改动中顺手改写。
