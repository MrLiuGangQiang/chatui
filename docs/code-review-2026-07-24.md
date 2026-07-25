# ChatUI 代码审查报告（2026-07-24）

## 结论

项目的业务分层、任务恢复链路、请求限流、上传大小限制、SSRF 防护和回归测试都比较成熟；`npm run check` 已通过，430 项测试全部通过。当前不建议进行大范围重写，但应先处理依赖安全与资源上限，再持续收敛浏览器组合层的历史债务。

综合评价：**B+（功能与可靠性较好，安全依赖治理和可维护性需要优先改进）**。

## 审查范围与方法

- 审阅仓库中 173 个应用 JavaScript 文件、根静态入口、HTML/CSS、Dockerfile、CI 工作流、配置、服务端路由和测试组织；未逐行审阅 `node_modules`，但审计了直接及生产依赖树和随包的浏览器 vendor 资产。
- 对照 `docs/architecture.md` 检查浏览器、服务端和共享代码边界。
- 执行 `npm.cmd run check`：项目检查、架构检查、入口语法检查及 430 项测试均通过。
- 对全部 222 个非依赖 JavaScript 文件执行 `node --check`，全部通过。
- 执行 `npm.cmd audit --omit=dev --json`：发现 1 个高危、1 个低危生产依赖公告。

本报告是审查意见，不包含业务代码修改。

### 审查深度说明

“逐个检查”有两个不同层级，必须明确区分。本轮已对 **173 个应用源码文件**逐文件完成文件清单、语法、规模、全局导出、`with` 作用域和 HTML 写入点扫描，并对入口、Markdown、安全代理、HTTP、任务、提取、配置、测试和发布路径进行了人工代码走查。

这不等同于对 173 个文件的每一行都进行人工语义审阅；后者需要按功能域分批进行，并在每个文件旁记录审阅人、日期和结论。若将本报告用于上线准入，应先完成 P1/P2 项，并另开逐文件人工走查清单，而不应把本轮静态全覆盖误写成全量逐行审计。

本轮人工走查的重点文件包括：

- `server/proxy/openai.js`、`server/jobs/common.js`、`server/security/url-policy.js`、`server/http/static.js`、`server/http/body.js`、`server/api/router.js`、`server/api/routes/core.js`、`server/api/routes/jobs.js`、`server/extract/index.js`、`server/extract/utils.js`；
- `client/app/markdown/browser-sanitizer.js`、`sanitizer.js`、`browser-engine.js`、`dependency-loader.js`、`resource-loader.js`、`link-policy.js`；
- `client/core/`、`client/services/`、`client/ui/`、`client/features/` 与 `client/app/` 的模块边界、全局导出和高风险 DOM 写入点；
- `index.html`、`Dockerfile`、GitHub Actions、`scripts/check-architecture.js` 和测试入口。

## 分模块评估

| 范围 | 评价 | 依据与建议 |
| --- | --- | --- |
| 根入口：`index.html`、`app.js`、`styles.css`、`route.html` | 有明确兼容静态入口约束，但维护成本偏高 | `app.js` 为 163,048 B、`styles.css` 为 223,614 B；根入口仍承担大量兼容和组装职责。保留静态路径契约，同时继续把业务代码移入 `client/`。 |
| `client/core/` 与 `shared/` | 合理 | 路由契约、上下文预算、任务状态等纯规则与 UI 分离；严格的 `task_contract.v3` 是正确方向。继续保持无 DOM、无 Node 专属依赖。 |
| `client/services/` | 合理 | 请求构造与 API 适配独立于 UI，便于契约测试。建议为每个公开服务导出维护一份最小契约测试。 |
| `client/app/` | 功能完整，但历史迁移未完成 | 工作流拆分已有进展，不过架构检查仍记录 76 个遗留 `with` 作用域和 184 个浏览器全局导出。应按高频改动模块逐步替换为显式依赖对象。 |
| `client/ui/` 与 `client/features/` | 整体合理 | 渲染、滚动、虚拟化和消息功能有较细测试。HTML 写入点较多，必须始终经 Markdown 渲染/净化或 `escapeHtml` 路径，新增写入点应增加 XSS 回归用例。 |
| Markdown 与资源加载 | 功能丰富，但版本与实现易漂移 | 浏览器净化器、CommonJS 净化器和资源描述存在重复；本地 vendor、CDN 和 npm 包版本已不一致。应收敛为单一策略源和单一版本清单。 |
| `server/http/`、`server/api/` | 基础防护良好 | 静态文件白名单、防目录穿越、ETag、压缩、方法限制和请求体上限实现清晰。路由应基于解析后的 pathname，而不是原始 `req.url`。 |
| `server/proxy/`、`server/security/`、`server/jobs/` | 设计较好，仍有资源耗尽边界 | 已实现 URL 协议检查、DNS 解析校验、重定向复验、并发队列和任务状态管理。图片代理响应目前整体读入内存，需补响应大小上限。 |
| `server/extract/` | 合理 | 按文件类型限制大小并使用独立并发 limiter；临时目录清理和命令调用也较规范。建议补压缩炸弹/超长解压输出的端到端测试。 |
| 测试、脚本与 CI | 覆盖面好，执行组织可改进 | 430 项测试包含单元、契约和烟雾覆盖；但统一入口仍从 `test/legacy/regression.test.js` 汇总，且 Playwright、Puppeteer 在仓库中无使用点。应拆分执行器，并增加真实浏览器最小冒烟测试。 |
| Docker 与发布 | 合理 | 非 root 用户、健康检查、运行时依赖和标签发布流程均具备。建议在 CI 增加依赖审计门禁和镜像漏洞扫描。 |

## 发现与修改建议

### F1 / P1：Markdown 链路含高危 `linkify-it` ReDoS 公告

**证据**：生产依赖树为 `markdown-it@14.2.0 -> linkify-it@5.0.1`。`npm audit --omit=dev` 报告 GHSA-v245-v573-v5vm，攻击者可通过特制 `mailto:` 文本触发二次复杂度扫描，影响可用性。

**影响**：模型输出、历史消息或用户输入进入 Markdown 链路时，浏览器或服务端渲染可能出现明显卡顿；外网部署时属于优先修复项。

**建议**：

1. 使用可修复版本更新锁文件（`npm audit fix` 前先在分支验证），确认最终 `linkify-it` 已不在公告范围。
2. 更新 `vendor/markdown-it.min.js` 及相关浏览器资产，使其与锁定版本一致；不能只更新 npm 包。
3. 为超长 `mailto:`、超长 URL 和大段 Markdown 增加性能回归测试，并设置合理的渲染输入上限或分段策略。

### F2 / P2：浏览器实际加载的 DOMPurify 版本落后且与 npm 声明不一致

**证据**：`vendor/purify.min.js` 标明 **3.4.7**，`client/app/markdown/dependency-loader.js` 的 CDN 同样固定为 3.4.7；`package.json` 则为 3.4.11。依赖审计还报告 DOMPurify `<=3.4.11` 的 GHSA-c2j3-45gr-mqc4，修复版本为 3.4.12。

**影响**：当前净化配置没有启用该公告涉及的 `CUSTOM_ELEMENT_HANDLING`，因此不能据此认定已可利用；但 Markdown 是不可信内容边界，交付资产与依赖声明漂移会使安全修复失效。

**建议**：

1. 将 npm 依赖升级到至少 3.4.12，并同步替换 `vendor/purify.min.js`。
2. 将 `dependency-loader.js`、`resource-loader.js`、HTML 直接引用和 vendor 版本改为由同一版本常量/生成脚本驱动。
3. 为脚本标签、事件属性、危险 URL、SVG data URL、样式 URL 和自定义元素建立固定 XSS 回归样本；CI 中校验 vendor 文件头版本与 `package-lock.json` 一致。

### F3 / P2：`/api/image` 将上游响应整体缓冲到内存，缺少响应大小上限

**位置**：`server/proxy/openai.js` 的 `proxyImage`。

**证据**：在只校验 `Content-Type` 以 `image/` 开头后，代码使用 `Buffer.from(await upstream.arrayBuffer())`。没有检查 `Content-Length`，也没有在流读取过程中累计字节数。

**影响**：合法但异常大的图片、错误的上游响应或恶意/失陷上游可令单请求占用大量内存；并发请求会放大为进程 OOM 风险。

**建议**：新增 `MAX_IMAGE_PROXY_BYTES` 配置（例如按部署容量设为 20–50 MiB），先拒绝超限 `Content-Length`，再流式读取并在累计字节超限时取消上游请求、返回 413。为无 `Content-Length`、伪造长度、超限流和并发大响应增加测试。

### F4 / P2：路由按原始 `req.url` 精确匹配，携带查询参数的标准 API 请求会落入错误分支

**位置**：`server/api/routes/core.js`、`server/api/routes/jobs.js`、`server/api/router.js`。

**证据**：核心路由使用 `item.path === req.url`，任务创建使用 `req.url === basePath`；`/api/version?x=1` 或 `/api/chat-jobs?x=1` 不会匹配，随后可能进入通用代理并返回 403。

**影响**：监控探针、缓存层、排障工具或未来客户端只要附带查询参数就会得到非预期结果，且错误行为难以诊断。

**建议**：在 Router 入口只解析一次 `new URL(req.url, base)`，将 `pathname` 与 `searchParams` 显式传给子路由；所有路径判断使用 pathname。补充核心 API、任务 API、SSE API 带查询参数及编码非法 URL 的契约测试。

### F5 / P2：CORS 全开放且任务接口无应用级身份校验，应按部署边界收紧

**位置**：`server/api/router.js`、核心路由和 Job 路由。

**证据**：OPTIONS 和多项响应统一设置 `Access-Control-Allow-Origin: *`；任务查询、订阅、取消和释放接口没有服务端用户身份/任务归属校验。

**影响**：若服务暴露在不受信任网络，任意网站可跨域调用接口；随机 job ID 降低猜测风险，但不是授权机制。内网、单用户且由反向代理隔离的部署风险较低。

**建议**：把允许源设为环境配置白名单，默认仅同源；公开部署时在反向代理或应用层引入认证，并将 job 与用户/会话主体绑定。为允许源、拒绝源、无凭据和跨用户 job 访问增加集成测试。

### F6 / P3：根组合层和全局命名空间仍是主要维护瓶颈

**证据**：架构检查记录 `app.js` 163,048 B、76 个遗留 `with` 作用域、184 个 `window.ChatUI*` 导出；`scroll-focus-workflow.js`（36 个）和 `reasoning-workflow.js`（22 个）集中度最高。

**影响**：隐式名称解析让静态分析、重构和并行开发更难；全局 API 增加模块加载顺序和覆盖风险。

**建议**：不要一次性重写。以 `scroll-focus-workflow.js`、`reasoning-workflow.js` 为批次，把 `with (deps)` 改为解构后的显式局部变量或具名接口；以 `ChatUIApp.appContext` 为唯一组合注册表；每迁移一个工作流就降低架构基线，而非只冻结当前上限。

### F7 / P3：Markdown 净化与依赖加载存在重复实现，已造成配置漂移

**位置**：`client/app/markdown/browser-sanitizer.js`、`client/app/markdown/sanitizer.js`、`client/app/markdown/dependency-loader.js`、`client/app/markdown/resource-loader.js`。

**证据**：浏览器和 CommonJS 版本分别复制净化白名单与样式过滤；两份资源加载器的资源集合、版本、加载顺序和超时策略不同，且浏览器实际使用的是 `dependency-loader.js`。

**影响**：安全策略或依赖升级可能只改到其中一条路径，测试与生产行为逐渐偏离。

**建议**：将纯数据的 Markdown 安全策略与资源清单移至 `shared/`；浏览器和 Node 仅保留各自的适配器。确认 `resource-loader.js` 的运行价值后删除或以测试专用适配器替代。为两端输出的净化结果建立同一组黄金测试。

### F8 / P3：测试入口与浏览器测试工具可精简

**证据**：`test/run-tests.js` 从 `test/legacy/regression.test.js` 汇总全部测试；`package.json` 声明了 Playwright 和 Puppeteer，但代码库无引用。

**影响**：测试目录的所有权不直观，安装时间和依赖面大于实际需要；JSDOM 不能完整覆盖 CSP、动态资源加载、滚动和真实浏览器媒体行为。

**建议**：让 `test/run-tests.js` 自动发现并按 `unit/`、`smoke/`、`legacy/` 分组执行；每次迁移测试后减少 legacy 汇总。二选一保留浏览器自动化工具，并增加最小 Chromium 冒烟场景：启动服务、加载首页、发送 Markdown、附件和会话恢复。若短期不做真实浏览器测试，应移除两项未用开发依赖。

### F9 / P3：CSP 允许外部脚本并含 `unsafe-inline`，可进一步降低供应链暴露面

**位置**：`server/http/response.js`、Markdown 依赖加载器。

**证据**：CSP 的 `script-src` 允许两个外部 CDN 和 `'unsafe-inline'`；加载器在本地资源失败后会回退 CDN。

**影响**：本地 vendor 本可提供离线加载，但回退路径扩大了第三方脚本供应链边界；`unsafe-inline` 降低 CSP 对注入的兜底效果。

**建议**：以经过版本校验的本地 vendor 为默认且生产唯一来源；若必须保留 CDN，加入 SRI、明确的发布验收和可配置开关。逐步消除内联脚本/样式后使用 nonce 或 hash 替代 `'unsafe-inline'`。

## 建议实施顺序

1. **本周**：升级并同步 `linkify-it`、DOMPurify、vendor 资产；复跑 `npm run check` 和新增的恶意 Markdown 性能/XSS 用例。
2. **本周**：为图片代理增加响应流大小上限；修复 Router 的 pathname 解析，并补对应 API 契约测试。
3. **下个迭代**：按部署模型收紧 CORS 与 job 授权；为公开部署提供反向代理配置示例。
4. **持续进行**：拆除 `with` 和多余全局导出；合并 Markdown 策略/资源加载实现；把测试从 legacy 汇总迁移到分层执行器。

## 保留的优点

- 静态资源白名单与路径规范化避免了常见目录穿越问题。
- 上游请求对私网地址、DNS 解析及重定向都做了校验，SSRF 防护优于常见简易代理实现。
- 聊天、图片和恢复任务具有清晰的 durable owner 设计，并有广泛的状态机回归测试。
- 文件提取和上游调用均有大小、超时或并发控制，日志也会脱敏敏感字段。
- 架构检查阻止根入口和历史全局模式继续无约束增长，适合多维护者协作下的渐进式重构。
