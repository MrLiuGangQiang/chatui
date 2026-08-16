# ChatUI 开发、测试与发布流程

本文记录当前仓库实际可执行的开发和发布流程。命令、package scripts、CI、Docker 验证或发布 workflow 发生变化时，应同步更新本文、README、CONTRIBUTING 和相关测试。

根目录 `version.json` 是应用版本的唯一权威来源。运行时、CI、Docker 候选身份和 release 校验都读取该文件；`package.json` 与 `package-lock.json` 中的版本仅是 npm 所需镜像，不得手工作为发布版本来源。

## 1. 环境与安装

`package.json` 当前要求 Node.js `>=20.19.0`，仓库 `.nvmrc` 和 Docker 使用 Node.js 22。日常开发建议使用 Node.js 22，以接近容器和主 CI 环境。

从 lockfile 安装依赖：

```bash
npm ci
```

不要用一次本地 `npm install` 产生的未审查 lockfile 变化作为验证依据。依赖变更才手工修改依赖字段；正式发版只通过 `npm run release:prepare` 同步两个版本镜像，并审查其差异。

启动本地服务：

```bash
npm start
```

默认地址为 `http://127.0.0.1:8765`。

本地数据库等私密配置可放在仓库根目录 `.env.local`。`npm start` 会在加载服务端配置前读取它，但不会覆盖当前进程或部署平台已经设置的同名变量；该文件被 Git 忽略，禁止强制提交。


需要为后续问题复盘保留真实请求证据时，可在本机 `.env.local` 中启用持久请求追踪：

```dotenv
CHATUI_REQUEST_TRACE=1
CHATUI_REQUEST_TRACE_FILE=temp/request-trace.ndjson
CHATUI_REQUEST_TRACE_MAX_BYTES=20971520
CHATUI_REQUEST_TRACE_ROTATIONS=3
```

重启 `npm start` 后，服务启动信息会显示实际日志路径。日志使用 `request_trace.v1` NDJSON，每次上游调用至少包含同一 `trace_id` 的 `request.started` 和 `request.completed`/`request.failed`。managed chat/image 请求在服务端执行边界还会写入 `execution.accepted` 或 `execution.rejected`：事件通过 `submission_id`、`job_id` 和 trace ID 关联同一次路由与最终执行，并在同一条记录中对照 execution plan prompt、provider payload prompt、binding evidence、实际资源绑定以及 `prompt_match` / `binding_evidence_match` 等校验结果。若客户端在 provider payload 创建前就因消息上下文绑定不一致而停止发送，会通过受限诊断端点写入 `source=client_pre_dispatch`、`validation_stage=client_context_projection` 的 `execution.rejected`；此时 `payload.available=false`，`context_projection` 会列出 expected、available、selected 和 missing message resource IDs，避免只能从“最终执行事件缺失”反推问题。它会保留限长且脱敏的用户输入、路由输出和普通模型回复，便于复盘；系统提示词只记录长度与哈希，reasoning 只记录长度。API Key、Authorization、自定义 Header 值、文件 Base64、图片 Base64和签名 URL 查询参数不会落盘。日志可能包含用户对话正文，仅允许保存在受信任的本机环境，不得提交到 Git 或附加到 Release。

查看最近记录：

```powershell
Get-Content temp/request-trace.ndjson -Tail 20
```

如只需要结构摘要，可设置 `CHATUI_REQUEST_TRACE_TEXT=0`；删除或关闭 `CHATUI_REQUEST_TRACE` 后，下次启动停止写入。

## 2. 测试 runner

全量测试：

```bash
npm test
```

runner 会按 `legacy/`、`unit/`、`smoke/` 递归发现 `*.test.js`，在同一个 Node.js 进程中顺序执行。每个 suite 必须导出非空的命名测试函数数组。runner 会检查遗漏导出的 `test*` 函数声明或函数赋值、重复测试名、空 suite、非法导出和单项超时。

### 2.1 聚焦到一个测试文件

通过 npm 传递文件路径或文件名片段：

```bash
npm test -- unit/server-hardening.test.js
npm test -- test/smoke/server-smoke.test.js
npm test -- server-hardening
```

也可以直接调用 runner：

```bash
node test/run-tests.js unit/server-hardening.test.js
```

位置参数当前筛选的是测试文件路径或文件名片段，不是单个测试函数名。没有文件匹配时 runner 会失败。

不要使用下面这种命令作为测试证据：

```bash
node test/unit/server-hardening.test.js
```

suite 文件只负责导出测试数组，直接执行它不会经过 runner。

列出将被选择的文件：

```bash
npm test -- --list server-hardening
```

调整每项测试的超时：

```bash
npm test -- --timeout=20000 unit/server-hardening.test.js
```

也可以设置 `CHATUI_TEST_TIMEOUT_MS`。默认每项测试超时为 10 秒。

## 3. 测试分层

- `test/unit/`：纯函数、模块、契约、状态机、错误分支和可注入依赖测试；
- `test/smoke/`：启动真实 HTTP server 后验证路由、响应和静态资源等跨模块链路；
- `test/legacy/`：尚未拆分的历史回归；
- `test/fixtures/`：稳定、无秘密的测试输入；
- `test/run-tests.js`：唯一的标准测试入口。

新增测试应进入 `unit/` 或 `smoke/`。已删除的聚合 legacy regression suite 不得恢复；历史回归应迁移到聚焦的 unit/smoke 测试。

测试名称应描述可观察行为。优先调用真实导出函数并断言结果；源码字符串断言只适合必须冻结的装配、缓存、发布或兼容约束，不能替代行为测试。

### 3.1 意图与执行边界聚焦回归

修改用户输入、上下文、意图请求、参数编译、路由、任务生命周期或 HTTP 接入边界时，除受影响模块测试外，至少运行下面的聚焦集合：

```bash
npm test -- route-resilience route-deadline-fallback route-live-status route-intent-request route-context-policy-source
npm test -- route-memory-ordinal-retrieval route-model-attempt-budget route-outcome-presentation route-prompt-multi-edit-contract
npm test -- clarification-image-choice-interaction clarification-choice-workflow clarification-refresh-persistence
npm test -- submit-workflow-cancellation regenerate-workflow submit-workflow-clarification-answers durable-task-lifecycle task-lifecycle
npm test -- dispatch-contract image-size-auto-policy message-size-guard
npm test -- request-body-utf8 server-router-access-log chat-request-error-metadata protocol-message-quality
npm test -- job-ownership job-routes server-hardening
```

这些测试分别冻结：共享绝对 deadline、adapter 忽略取消时的主动结算、deadline 后禁止继续 Structured Output 兼容请求、真实 provider-attempt 账本、primary/fallback 错误身份、`route_context_policy.v1` 单一裁剪策略与受保护内容超限、历史图片结构化序号检索、typed route outcome、图片澄清整卡选择/独立预览、停止后的单终态、handoff/completion 幂等、常见中英文否定/重叠/全角参数及排除选项、统一 120,000 字符上限、严格 UTF-8、每请求一条且分类正确的 access log 和协议错误消息质量。新增回归不能只断言一个用户样例；应同时包含正例、近邻反例、冲突或边界输入以及失败路径。

聚焦测试通过不等于发布候选通过。最终工作树仍必须重新执行 `npm run check`；涉及真实模型语义时还必须运行第 6 节独立评测，涉及浏览器或容器行为时必须分别取得真实浏览器 E2E 与 exact Docker runtime 证据。

## 4. 同进程测试的清理要求

runner 不为每项测试创建独立进程。它会在每项测试开始前记录真实 `globalThis` 自有属性的描述符，并在测试结束后（包括失败路径）自动删除新增的直接属性、恢复被替换的直接属性；新增且不可配置的全局属性会让清理失败，防止污染被静默接受。

该保护不会递归清理对象内部状态，也不负责外部资源。测试套件仍须使用 `try/finally`，至少处理适用的项目：

- 恢复嵌套对象修改和 `process.env` 条目；
- 清理为测试创建或替换的 module/require cache 项；
- 清除 interval、timeout、animation frame 和 sweeper；
- 关闭 HTTP server、socket、数据库池和订阅；
- 释放 object URL、AbortController 和临时事件监听器；
- 清理 IndexedDB、`localStorage` 内容及其他进程外或持久化资源。
- 临时文件放在 `os.tmpdir()` 下的唯一目录，并在 `finally` 中删除；
- HTTP 测试优先监听端口 `0`，不要依赖固定本地端口；
- 默认测试不得访问真实上游、真实账号、真实 API Key 或生产数据库。

失败清理同样必须执行，避免一个测试污染后续测试或让 Node 进程无法退出。

## 5. `npm run check` 的实际门禁

提交前运行：

```bash
npm run check
```

当前按以下顺序执行：

1. `npm run check:project`
   - 校验 package 基本信息和 `private: true`；
   - 校验 `version.json` 格式，并确认 `package.json`、`package-lock.json` 镜像字段与它一致；
   - 校验要求的 package scripts；
   - 校验根静态文件与 `pages/` 独立页面存在，并检查该目录的 Docker/静态服务约束。
2. `npm run check:architecture`
   - 限制根 `app.js` 大小；
   - 禁止超过 baseline 的 legacy `with (...)`；
   - 限制浏览器 `ChatUI*` 全局 namespace 增长。
3. `npm run check:syntax`
   - 对根 `app.js`、`server.js` 及 `client/`、`server/`、`shared/`、`scripts/`、`test/` 下的 JavaScript 执行 `node --check`；
   - 排除 node_modules、vendor、coverage、dist、temp 和测试报告等目录。
4. `npm test`
   - 运行 runner 选择到的全部 legacy、unit 和 smoke suite。

当前 `npm run check` **不包含**：

- Docker 构建或 `preview:release`；
- 正式代码覆盖率阈值；
- 真实浏览器 E2E；
- `linux/amd64` 容器运行测试；
- 真实 PostgreSQL 集成环境；
- 真实 OpenAI-compatible 上游调用；
- actionlint、通用 lint、format 或 image vulnerability scan。

不要把这些未实现的检查写成 `npm run check` 已经覆盖。

## 6. 意图路由评估

`npm run eval:intent` 是独立的真实模型评估工具，不属于 `npm run check`。它需要显式提供评估用 Base URL、API Key 和 route model，例如：

```bash
npm run eval:intent -- \
  --base-url https://example.invalid/v1 \
  --api-key "$CHATUI_EVAL_API_KEY" \
  --model route-model \
  --output temp/reports/intent-routing-live.json
```

评估输入来自 `test/fixtures/intent-routing-eval.v3.json`。模型必须返回只含 `operation`、`relation`、`goal`、`goal_mode`、`resource_refs`、`task_shape` 的最小 `route_intent.v3`；`goal` 只消解指代并保留用户已提出的约束。`relation`、`goal_mode` 与资源绑定分别评估：对话上的 follow-up 可以是完整 `replace`，文字任务 `amend` 可以不绑定旧图，明确不使用旧图只能表现为 `resource_refs=[]`，不能被本地层改写。没有有效前序图片任务状态时，请求级 schema 必须把 `goal_mode` 收窄为 `replace`；非图片操作与 `image_reference_gen` 也只能为 `replace`。

评估器直连供应商时仍复用 `shared/responses-output.js` 解释非流式 envelope，与服务端 `/api/responses` 意图压缩边界使用同一最终文本提取规则；Responses 顶层 `text.format` 只能视为请求/响应格式元数据，不能当成模型输出。若 fixture 的 `context.recent_messages` 含正在评估的当前用户消息，必须显式声明 `current_turn.messageIndex`；评估器和生产提交链路使用同一 current-turn 过滤规则，禁止把当前输入再次作为历史证据发送。

`task_shape` 描述本轮是否需要多个独立执行，而非资源数量：`single` 是一次 dispatch 可返回一个可合并结果，多图问答、比较、OCR 和汇总仍为 `single`；`multi` 表示多个独立执行。所有图片类 `multi` 都进入二级图片规划，父路由必须是无执行合同、无执行授权的 planning envelope，只有 `image_plan.v1` 子路由可独立 dispatch；非图片或跨 API 的 `multi` 由执行门禁阻止发送并要求拆分。评估器直接把原始模型六字段作为独立语义证据，检查 operation、relation、goal mode、task shape、`goal` 原子事实及资源角色/顺序，再通过生产 `route-service` 重建绑定，校验 `task_continuity.v1` 的 transition/render 结果、批量 `image_task_lineage.v1`、澄清、父规划门禁和最终 `dispatch_contract.v1`。模型路径的本地编译器不得替错误语义兜底，也不得给 `resource_refs=[]` 补入最近图片。

默认质量门槛为平均得分 100、合法合同率 100%，且所有 safety-critical 用例必须完美通过。请求级 schema 门禁还必须覆盖动态候选 enum、空候选零引用、确定性 relation/goal mode 域和 current-input goal authority，并同时验证近邻反例仍保留完整模型选择域。每个连续性故障都必须有独立回归：完整重做 `replace`、局部修订 `amend`、刷新恢复、显式损坏状态拒绝、图片类 multi 父路由无 dispatch、批量 child 独立 lineage。不得通过修改评估器、后置归一化或 legacy 文本回退掩盖失败。

报告逐条保留 fixture 输入、脱敏后的模型输出、编译结果、最终执行计划、payload 边界审计、评测依据、失败原因和原始输出 SHA-256；不会保留 API Key、Authorization、Base64、Data URL 或完整二进制。真实凭据不得写入命令历史、fixture、报告或仓库。默认输出目录属于生成报告，不应提交。

## 7. 本地 Docker release preview

安装并启动 Docker 后，可运行：

```bash
npm run preview:release
```

该命令会先运行 `npm run check`，随后：

1. 要求工作区为干净的已提交状态；
2. 确认 runtime identity 与当前 `HEAD` 一致；
3. 使用版本、Git SHA 和 runtime source revision 构建本地候选镜像；
4. 启动候选容器；
5. 校验 `/api/version`、身份字段和关键静态 bundle；
6. 停止验证容器。

本地 preview 只验证本机 Docker 可运行的平台。它不会证明：

- 当前提交已经推送到 `origin/main`；
- GitHub required checks 已通过；
- `linux/amd64` 镜像已经运行；
- ACR 和 Docker Hub 标签已经发布；
- GitHub Release 已存在。

如果本机没有 Docker，不要伪造或跳过记录。按 release procedure，必须在打 tag 前等待该提交的远端 `Exact Docker runtime` 成功。

## 8. CI

`.github/workflows/ci.yml` 在 pull request 和 `main` push 上运行：

- Node.js 20.19.0：`npm ci --ignore-scripts` + `npm run check`；
- Node.js 22：`npm ci --ignore-scripts` + `npm run check`；
- Exact Docker runtime：构建 `linux/amd64` 候选镜像，并校验容器版本、Git SHA、source revision 和静态资产。

CI 结果只对它检出的确切 commit 有效。脏工作区、另一 worktree 或较早 commit 的结果不能作为当前 release candidate 的证据。

分支保护、tag ruleset、required check 配置属于 GitHub 仓库设置，不由本地脚本自动证明；发布者仍需确认这些外部设置和 check 状态。

## 9. 版本化强制公告

重要公告使用独立目录维护，不复用 Release Notes：

```text
docs/announcements/vMAJOR.MINOR.PATCH.md
```

- 文件版本按语义版本排序，最新版本作为当前公告；
- 只新增，不删除历史公告；
- front matter 支持 `published_at`、`badge`、`summary`；
- 浏览器以 `chatui-announcements-read-v1` 保存已读版本；
- 最新公告未读时，首屏使用 fail-closed 遮罩并将主应用设为 `inert`，直到用户确认已读；
- 新增更高版本公告后，当前最新版本不在已读集合中，遮罩自动重新出现；
- 历史公告通过公告中心的“查看历史公告”展开，不影响最新公告确认流程。

新增公告后至少运行：

```bash
npm run check
```

公告目录会被 Docker 复制到 `/app/docs/announcements`，并参与 runtime source revision，避免公告内容与已验证镜像不一致。

## 9. 完整 Release 流程

“推送 tag”不是完整发布。正式 release 必须执行全部步骤。

### 9.1 准备候选提交

1. 获取最新远端状态，确认基于当前 `origin/main` 工作；
2. 确认没有未提交或未跟踪的候选改动；
3. 运行 `npm run release:prepare`，自动递增 `version.json`；版本遵循 `a.b.c`，`c` 从 0 到 99，`1.10.99` 的下一版为 `1.11.0`；
4. 确认命令已同步 `package.json`、`package-lock.json` 顶层版本和 lockfile 根 package 镜像字段；
5. 完成命令新建的 `docs/releases/vMAJOR.MINOR.PATCH.md`，标题以 `# ChatUI vMAJOR.MINOR.PATCH` 开头，并写清用户可见影响。

### 9.2 本地验证与推送 main

```bash
npm run check
```

Docker 可用时还必须运行：

```bash
npm run preview:release
```

提交 release candidate 并推送到 `main`。等待该精确提交的全部 main CI，特别是 `Exact Docker runtime`，成功后才能打 tag；不能以脏工作区、另一 worktree 或较早 commit 的结果作为候选依据。

### 9.3 创建 annotated tag

在已验证的 main commit 上创建 annotated tag：

```bash
git tag -a vMAJOR.MINOR.PATCH -m "ChatUI vMAJOR.MINOR.PATCH"
git push origin vMAJOR.MINOR.PATCH
```

不要使用 lightweight tag，也不要把 tag 指向未通过 main CI 的提交。

### 9.4 Tag workflow

`.github/workflows/release.yml` 以阿里云 ACR 为主发布路径，当前会：

1. 校验 tag 格式；
2. checkout tag，确认它是 annotated tag 且提交属于 `origin/main`；
3. 校验 tag 与 `version.json` 一致、npm 版本镜像一致，并检查 Release Notes；
4. 再次运行 `npm run check`；
5. 构建 `linux/amd64` ACR 候选镜像；
6. 按构建输出 digest 拉取 ACR 候选，并运行 runtime identity/asset 验证；
7. 不重新构建，直接把同一 digest 提升为 ACR 的 `MAJOR.MINOR.PATCH`、`vMAJOR.MINOR.PATCH` 和 `latest`；
8. 验证 ACR 的全部正式标签都解析到该 digest；
9. 创建或更新同 tag 的非 draft、非 prerelease GitHub Release。

Docker Hub 同步是 tag 发布的最后一个独立节点：它在 ACR 标签验证和 GitHub Release 成功后，自动从已验证的 ACR digest 复制，不会重建镜像。手动触发 workflow 时，`publish_dockerhub` 默认也为启用状态。

当前 workflow 仅构建并验证 `linux/amd64` 镜像；ARM64 部署不在发布支持范围内。

### 9.5 发布完成条件

只有全部满足时才能报告“发布完成”：

- tag 指向已验证的确切 main commit；
- tag-triggered Docker workflow 成功；
- GitHub Release 已发布且不是 draft；
- ACR 的版本、`v` 前缀和 `latest` 标签解析到验证过的同一 digest；
- Docker Hub 的对应标签也解析到同一 digest；
- workflow 的 `/api/version` 校验匹配 version、Git SHA 和 runtime source revision；
- 已说明是否还需要部署环境拉取新镜像或重启服务。

报告至少包含：版本、commit、tag、GitHub Release URL/状态、镜像 digest、workflow URL/结果、source revision 和剩余部署动作。如果 workflow 尚未结束，只能报告“发布进行中”。

## 10. 只能在远端或外部系统确认的事项

下列项目不能仅凭本地 `npm run check` 或 Git tag 推断：

- GitHub main CI 和 required checks 状态；
- tag workflow 是否成功完成；
- GitHub Release 是否真正发布；
- ACR 和 Docker Hub 的标签传播及最终 digest；
- registry 登录、secret 权限和配额；
- GitHub branch/tag protection 与 ruleset；
- 下游部署是否已拉取新镜像并完成重启/健康检查；
- 真实上游、网络代理和生产 PostgreSQL 的可用性。

这些事项必须通过相应平台 API、workflow 日志、registry inspect 或部署平台健康检查取得证据。

## 11. 提交卫生

提交前确认：

- 只包含本次任务需要的源码、测试和文档；
- 不包含 `coverage/`、`dist/`、`temp/`、`test-results/`、日志或编辑器状态；
- 不包含 `.env`、API Key、数据库密码、registry token 或真实业务数据；
- 根静态入口变化已经同步静态服务器、Docker、测试和文档；
- 新测试位于 `test/unit/` 或 `test/smoke/`；
- `npm run check` 在最终候选状态重新执行并记录结果。
