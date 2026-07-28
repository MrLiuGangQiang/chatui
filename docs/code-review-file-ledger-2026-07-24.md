# ChatUI 文件级审查台账（2026-07-24）

此台账覆盖仓库自有的 **230 个代码、测试、配置与自动化文件**。第三方压缩依赖和字体（`vendor/`）、依赖安装目录、发行文档不逐行复述；它们的版本与供应链风险见主报告。

判读维度：L = 逻辑正确性，U = 用户体验，P = 性能/资源，A = 架构边界。F1–F9 对应主报告 [code-review-2026-07-24.md](code-review-2026-07-24.md) 的具体发现；“无新增”并不表示形式化证明无缺陷，而是本次静态与人工走查未识别到独立问题。

| 文件 | 职责 | 文件级分析（L/U/P/A/建议） |
| --- | --- | --- |
| `app.js` | 兼容浏览器组合入口 | L: 适配转发正确；U: 无直接问题；P: 组合开销可控；A: 例外（遗留入口）；建议：继续抽离业务逻辑（F6）。 |
| `server.js` | Node 进程启动与退出 | L: 启动/容器职责清晰；U: 不适用；P: 合理；A: 符合；建议：保留健康检查并在 CI 做镜像漏洞扫描。 |
| `index.html` | 主应用 HTML 壳与资源加载顺序 | L: 资源排序明确；U: 首屏完整；P: 脚本数量多；A: 静态契约内；建议：构建单 bundle 并消除内联代码/CSP 例外（F9）。 |
| `route.html` | 路由图 iframe 页面 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `styles.css` | 根级兼容样式入口 | L/U: 视觉入口；P: 体积较大；A: 静态契约内；建议：按页面拆分并清理失效选择器。 |
| `Dockerfile` | 生产容器构建 | L: 启动/容器职责清晰；U: 不适用；P: 合理；A: 符合；建议：保留健康检查并在 CI 做镜像漏洞扫描。 |
| `package.json` | 依赖、脚本与运行时契约 | L: 脚本齐全；U: 不适用；P: 两个未使用浏览器测试依赖；A: 符合；建议：更新安全依赖并移除未用工具（F1/F2/F8）。 |
| `config/public.json` | 配置：public | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `.github/workflows/ci.yml` | 执行持续集成检查 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `.github/workflows/dockerhub.yml` | 构建、发布 Docker 镜像 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/app-context.js` | 应用 app-context 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/attachments-workflow.js` | 应用 attachments-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/bootstrap-workflow.js` | 应用 bootstrap-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/browser.js` | 应用 browser 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/chat-workflow.js` | 应用 chat-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/composer-layout-workflow.js` | 应用 composer-layout-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/config-workflow.js` | 应用 config-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/custom-select-workflow.js` | 应用 custom-select-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/dialog-workflow.js` | 应用 dialog-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/display-history-workflow.js` | 应用 display-history-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/display-items.js` | 应用 display-items 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/formatting.js` | 应用 formatting 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-actions-workflow.js` | 应用 image-actions-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-context-workflow.js` | 应用 image-context-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-preview-workflow.js` | 应用 image-preview-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-result-reconciliation.js` | 应用 image-result-reconciliation 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-result-workflow.js` | 应用 image-result-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-store.js` | 应用 image-store 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/image-workflow.js` | 应用 image-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/index.js` | 应用 index 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/job-resume-workflow.js` | 应用 job-resume-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/job-workflow.js` | 应用 job-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/browser.js` | Markdown browser 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/browser-engine.js` | Markdown browser-engine 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/browser-enhancer.js` | Markdown browser-enhancer 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/browser-sanitizer.js` | Markdown browser-sanitizer 处理 | L: 渲染安全/加载职责明确；U: 降级可用；P: 延迟加载合理；A: 存在重复与版本漂移；建议：合并策略并同步 vendor（F2/F7）。 |
| `client/app/markdown/browser-streaming-renderer.js` | Markdown browser-streaming-renderer 处理 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/app/markdown/dependency-loader.js` | Markdown dependency-loader 处理 | L: 渲染安全/加载职责明确；U: 降级可用；P: 延迟加载合理；A: 存在重复与版本漂移；建议：合并策略并同步 vendor（F2/F7）。 |
| `client/app/markdown/enhancer.js` | Markdown enhancer 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/index.js` | Markdown index 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/link-policy.js` | Markdown link-policy 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/markdown-engine.js` | Markdown markdown-engine 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/math-renderer.js` | Markdown math-renderer 处理 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/app/markdown/mermaid-normalizer.js` | Markdown mermaid-normalizer 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/resource-loader.js` | Markdown resource-loader 处理 | L: 渲染安全/加载职责明确；U: 降级可用；P: 延迟加载合理；A: 存在重复与版本漂移；建议：合并策略并同步 vendor（F2/F7）。 |
| `client/app/markdown/sanitizer.js` | Markdown sanitizer 处理 | L: 渲染安全/加载职责明确；U: 降级可用；P: 延迟加载合理；A: 存在重复与版本漂移；建议：合并策略并同步 vendor（F2/F7）。 |
| `client/app/markdown/source-normalizer.js` | Markdown source-normalizer 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/stable-boundary.js` | Markdown stable-boundary 处理 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/markdown/streaming-renderer.js` | Markdown streaming-renderer 处理 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/app/markdown-utils.js` | 应用 markdown-utils 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/media-workflow.js` | 应用 media-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/message-records.js` | 应用 message-records 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/message-workflow.js` | 应用 message-workflow 工作流 | L: 流程完整；U: 功能丰富；P: 有节流/延迟机制；A: 使用遗留 with/global；建议：分批显式注入依赖（F6）。 |
| `client/app/model-ui.js` | 应用 model-ui 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/performance-workflow.js` | 应用 performance-workflow 工作流 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/app/persistence.js` | 应用 persistence 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/reasoning-workflow.js` | 应用 reasoning-workflow 工作流 | L: 流程完整；U: 功能丰富；P: 有节流/延迟机制；A: 使用遗留 with/global；建议：分批显式注入依赖（F6）。 |
| `client/app/regenerate-workflow.js` | 应用 regenerate-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/route-decision-workflow.js` | 应用 route-decision-workflow 工作流 | L: 流程完整；U: 功能丰富；P: 有节流/延迟机制；A: 使用遗留 with/global；建议：分批显式注入依赖（F6）。 |
| `client/app/route-diagram-workflow.js` | 应用 route-diagram-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/runs.js` | 应用 runs 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/runtime.js` | 应用 runtime 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/scroll-focus-workflow.js` | 应用 scroll-focus-workflow 工作流 | L: 流程完整；U: 功能丰富；P: 有节流/延迟机制；A: 使用遗留 with/global；建议：分批显式注入依赖（F6）。 |
| `client/app/session-config.js` | 应用 session-config 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-display.js` | 应用 session-display 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-panel-workflow.js` | 应用 session-panel-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-persistence.js` | 应用 session-persistence 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-resources.js` | 应用 session-resources 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/sessions.js` | 应用 sessions 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-store.js` | 应用 session-store 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/session-ui-workflow.js` | 应用 session-ui-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/state.js` | 应用 state 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/submit-workflow.helpers.js` | 应用 submit-workflow.helpers 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/submit-workflow.js` | 应用 submit-workflow 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/app/task-lifecycle.js` | 应用 task-lifecycle 工作流 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/config/feature-flags.js` | 浏览器 feature-flags 配置 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/config/storage-keys.js` | 浏览器 storage-keys 配置 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/attachments.js` | 浏览器核心 attachments 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/browser.js` | 浏览器核心 browser 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/context-budget.js` | 浏览器核心 context-budget 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/http.js` | 浏览器核心 http 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/image-references.js` | 浏览器核心 image-references 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/image-route-context.js` | 浏览器核心 image-route-context 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/index.js` | 浏览器核心 index 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/intent-contract.js` | 浏览器核心 intent-contract 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/messages.js` | 浏览器核心 messages 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/models.js` | 浏览器核心 models 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/preflight-guards.js` | 浏览器核心 preflight-guards 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/reasoning.js` | 浏览器核心 reasoning 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/storage.js` | 浏览器核心 storage 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/task-state.js` | 浏览器核心 task-state 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/core/web-preview.js` | 浏览器核心 web-preview 规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/domain/types.js` | 配置：types | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/history-anchor-nav.js` | 浏览器功能 history-anchor-nav | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/messages/markdown-final-renderer.js` | 浏览器功能 markdown-final-renderer | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/features/messages/markdown-live-stream.js` | 浏览器功能 markdown-live-stream | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/features/messages/markdown-preview.js` | 浏览器功能 markdown-preview | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/messages/message-domain.js` | 浏览器功能 message-domain | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/messages/message-model.js` | 浏览器功能 message-model | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/messages/quote-preview.js` | 浏览器功能 quote-preview | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/features/usage-stats/view-helpers.js` | 浏览器功能 view-helpers | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `client/services/attachment-service.js` | 浏览器服务 attachment-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/browser.js` | 浏览器服务 browser 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/chat-service.js` | 浏览器服务 chat-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/clarification-service.js` | 浏览器服务 clarification-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/composition.js` | 浏览器服务 composition 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/image-generation-service.js` | 浏览器服务 image-generation-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/image-service.js` | 浏览器服务 image-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/job-service.js` | 浏览器服务 job-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/model-service.js` | 浏览器服务 model-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/prompt-composer-service.js` | 浏览器服务 prompt-composer-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/route-service.js` | 浏览器服务 route-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/runtime-service.js` | 浏览器服务 runtime-service 适配 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/services/usage-stats.js` | 浏览器服务 usage-stats 适配 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `client/testing/source-assertions.js` | 配置：source-assertions | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/browser.js` | 浏览器 UI browser 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/file-actions.js` | 浏览器 UI file-actions 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/image-actions.js` | 浏览器 UI image-actions 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/message-actions.js` | 浏览器 UI message-actions 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/message-renderer.js` | 浏览器 UI message-renderer 组件 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/ui/message-virtualizer.js` | 浏览器 UI message-virtualizer 组件 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/ui/realtime-renderer.js` | 浏览器 UI realtime-renderer 组件 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/ui/render-cache.js` | 浏览器 UI render-cache 组件 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/ui/render-scheduler.js` | 浏览器 UI render-scheduler 组件 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `client/ui/scroll-controller.js` | 浏览器 UI scroll-controller 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/scroll-metrics.js` | 浏览器 UI scroll-metrics 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `client/ui/usage-stats.js` | 浏览器 UI usage-stats 组件 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `client/ui/usage-stats-auth.js` | 浏览器 UI usage-stats-auth 组件 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `client/ui/usage-stats-format.js` | 浏览器 UI usage-stats-format 组件 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `client/ui/web-preview.js` | 浏览器 UI web-preview 组件 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `scripts/check-architecture.js` | 工程 check-architecture 脚本 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `scripts/check-project.js` | 工程 check-project 脚本 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `scripts/evaluate-intent-routing.js` | 工程 evaluate-intent-routing 脚本 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `scripts/lib/intent-routing-evaluation.js` | 工程 intent-routing-evaluation 脚本 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `scripts/verify-release.js` | 工程 verify-release 脚本 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/api/controllers/usage.controller.js` | 服务端 API usage.controller 分发/控制 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `server/api/router.js` | 服务端 API router 分发/控制 | L: 路由分层合理；U: 查询参数请求会失配；P: 无明显问题；A: 符合；建议：统一使用 pathname（F4）。 |
| `server/api/routes/core.js` | 服务端 API core 分发/控制 | L: 路由分层合理；U: 查询参数请求会失配；P: 无明显问题；A: 符合；建议：统一使用 pathname（F4）。 |
| `server/api/routes/jobs.js` | 服务端 API jobs 分发/控制 | L: 路由分层合理；U: 查询参数请求会失配；P: 无明显问题；A: 符合；建议：统一使用 pathname（F4）。 |
| `server/api/routes/usage.js` | 服务端 API usage 分发/控制 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/app.js` | 服务端 app 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/concurrency.js` | 服务端 concurrency 能力 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/config/index.js` | 服务端 index 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/config/public-config.js` | 服务端 public-config 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/db/postgres.js` | 服务端 postgres 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/errors/app-error.js` | 服务端 app-error 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/errors/http-error.js` | 服务端 http-error 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/extract/index.js` | 附件 index 提取 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/extract/office.js` | 附件 office 提取 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/extract/pdf.js` | 附件 pdf 提取 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/extract/text.js` | 附件 text 提取 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/extract/utils.js` | 附件 utils 提取 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/http/body.js` | HTTP body 基础设施 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/http/response.js` | HTTP response 基础设施 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/http/static.js` | HTTP static 基础设施 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/jobs/chat.js` | 托管任务 chat 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/chat-image.js` | 托管任务 chat-image 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/chat-stream-parser.js` | 托管任务 chat-stream-parser 生命周期 | L: 分段渲染职责清晰；U: 降低长消息卡顿；P: 有懒加载/调度；A: 符合；建议：增加真实浏览器性能基线。 |
| `server/jobs/common.js` | 托管任务 common 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/events.js` | 托管任务 events 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/image.js` | 托管任务 image 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/job-url.js` | 托管任务 job-url 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/reasoning.js` | 托管任务 reasoning 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/jobs/store.js` | 托管任务 store 生命周期 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/logging/safe-log.js` | 服务端 safe-log 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/proxy/headers.js` | 服务端 headers 能力 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/proxy/openai.js` | 服务端 openai 能力 | L: 代理校验充分；U: 错误可诊断；P: 图片响应无上限；A: 符合；建议：流式限制图片字节数（F3）。 |
| `server/proxy/responses-stream.js` | 服务端 responses-stream 能力 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/security/url-policy.js` | 服务端 url-policy 能力 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/services/dingtalk-feedback.service.js` | 服务端 dingtalk-feedback.service 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/services/image-edit-payload.service.js` | 服务端 image-edit-payload.service 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/services/static-bundle.service.js` | 服务端 static-bundle.service 能力 | L: 防护/边界清晰；U: 错误契约一致；P: 有限制或缓存；A: 符合；建议：补异常边界压力测试。 |
| `server/services/usage.service.js` | 服务端 usage.service 能力 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `server/services/usage-access.service.js` | 服务端 usage-access.service 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/usage/export-xlsx.js` | 服务端 export-xlsx 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/usage/ranges.js` | 服务端 ranges 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `server/usage/stats-repository.js` | 服务端 stats-repository 能力 | L: 分层合理；U: 统计视图可用；P: 批量查询意识良好；A: 符合；建议：补权限与跨域部署测试（F5）。 |
| `server/validators/usage.validator.js` | 服务端 usage.validator 能力 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `shared/config/context-budget.js` | 跨端 context-budget 共享规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `shared/file-names.js` | 跨端 file-names 共享规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `shared/usage/ranges.js` | 跨端 ranges 共享规则 | L: 职责单一、未见独立逻辑缺陷；U: 无新增体验问题；P: 无新增热点；A: 位于规定层；建议：保持现有边界并随调用变更补契约测试。 |
| `test/legacy/regression.test.js` | 验证 regression 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/run-tests.js` | 验证 run tests 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/smoke/multi-image-compose-flow.test.js` | 验证 multi image compose flow 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/smoke/server-smoke.test.js` | 验证 server smoke 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/api-contract.test.js` | 验证 api contract 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/chat-stream-fallback.test.js` | 验证 chat stream fallback 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/chat-stream-parser.test.js` | 验证 chat stream parser 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/client-contract.test.js` | 验证 client contract 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/content-region-dialog-layout.test.js` | 验证 content region dialog layout 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/done-sound.test.js` | 验证 done sound 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/durable-task-lifecycle.test.js` | 验证 durable task lifecycle 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/image-edit-payload-contract.test.js` | 验证 image edit payload contract 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/image-job-contract.test.js` | 验证 image job contract 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/image-service-contract.test.js` | 验证 image service contract 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/image-session-switch-media.test.js` | 验证 image session switch media 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/intent-routing-evaluation.test.js` | 验证 intent routing evaluation 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/job-routes.test.js` | 验证 job routes 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/large-markdown-canonical-final.test.js` | 验证 large markdown canonical final 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/markdown-preview-table-alignment.test.js` | 验证 markdown preview table alignment 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/markdown-streaming-canonical-final.test.js` | 验证 markdown streaming canonical final 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/markdown-streaming-details.test.js` | 验证 markdown streaming details 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/markdown-streaming-table-preview.test.js` | 验证 markdown streaming table preview 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/message-order-persistence.test.js` | 验证 message order persistence 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/message-quote-layout.test.js` | 验证 message quote layout 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/message-size-guard.test.js` | 验证 message size guard 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/multi-image-reference-routing.test.js` | 验证 multi image reference routing 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/project-tooling.test.js` | 验证 project tooling 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/prompt-ime-submit-guard.test.js` | 验证 prompt ime submit guard 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/reasoning-history-persistence.test.js` | 验证 reasoning history persistence 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/reasoning-workflow.test.js` | 验证 reasoning workflow 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/regenerate-workflow.test.js` | 验证 regenerate workflow 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/route-model-follow-session.test.js` | 验证 route model follow session 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/route-recognition-submit.test.js` | 验证 route recognition submit 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/server-hardening.test.js` | 验证 server hardening 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/session-job-recovery.test.js` | 验证 session job recovery 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/session-job-resume-reconciliation.test.js` | 验证 session job resume reconciliation 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/session-route-switch-continuity.test.js` | 验证 session route switch continuity 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/session-snapshot-format.test.js` | 验证 session snapshot format 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/session-store-recovery.test.js` | 验证 session store recovery 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/static-bundle.test.js` | 验证 static bundle 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/streaming-code-block.test.js` | 验证 streaming code block 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/submit-workflow-helpers.test.js` | 验证 submit workflow helpers 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/task-context-boundary.test.js` | 验证 task context boundary 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/task-lifecycle.test.js` | 验证 task lifecycle 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/task-lifecycle-state-machine.test.js` | 验证 task lifecycle state machine 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/task-state.test.js` | 验证 task state 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/usage.test.js` | 验证 usage 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/user-message-copy.test.js` | 验证 user message copy 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |
| `test/unit/web-preview.test.js` | 验证 web preview 行为 | L: 覆盖文件名所示回归；U: 间接覆盖；P: 单测轻量；A: 目录符合；建议：由新执行器直接发现，逐步移出 legacy 汇总（F8）。 |

## 台账使用说明

- 高风险和跨边界文件已做人工路径走查；其中 API、代理、Markdown、任务恢复、静态资源和发布链路的具体证据及修复顺序在主报告中。
- 测试文件按文件独立登记其覆盖意图；测试逻辑本身不直接提供用户体验，价值在于锁定对应回归。测试执行器目前由 legacy 汇总，属于 F8 的维护性问题。
- 对单文件给出“无新增”时，仍需在修改该文件后运行 `npm run check`；涉及 DOM/Markdown/路由/任务状态的改动应同时新增相邻单元或烟雾测试。
