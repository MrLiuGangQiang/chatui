Release v1.3.72

## 新增
- 无。

## 删除
- 无。

## 修改
- Endpoint Base URL 恢复为可编辑配置项；已保存的自定义上游地址会在重新打开设置后保留。
- 浏览器提交请求时会规范化 Endpoint Base URL，自动移除末尾的 `/`，避免拼接图片 API 路径时出现重复斜杠。
- 服务端将默认上游地址调整为兼容性兜底值：仅旧版客户端没有携带 `baseUrl` 时才使用 `DEFAULT_UPSTREAM_BASE_URL` 环境变量（未设置时默认 `https://ingress.lfans.cn/v1`）。

## 修复
- 修复 v1.3.68 起服务端忽略客户端 `baseUrl`、强制将聊天和图片任务转发至 `https://ingress.lfans.cn/v1` 的回归问题。
- 修复带图片的聊天、图片生成和图片编辑在用户 Endpoint 正常时仍报“连接上游接口失败：Endpoint 地址不可达或网络连接被拒绝”的问题。
- 图片任务现在会按实际配置分别转发到：
  - `<Endpoint Base URL>/images/generations`
  - `<Endpoint Base URL>/images/edits`
- 修复统计访问校验模块引用已移除固定上游常量导致的服务启动风险。
- 补充 Endpoint 保留/规范化及图片生成、异步完成、图片编辑的上游地址契约测试，防止再次把用户配置覆盖为固定网关。

## 验证
- `node test/unit/image-job-contract.test.js`：20/20 通过。
- `node --check`：前端配置、服务端配置、任务公共逻辑、统计访问逻辑和测试脚本均通过语法检查。
- 本地服务已启动并验证 `GET /api/version` 返回 HTTP 200（版本 `1.3.71`；提交后会升级为 `1.3.72`）。
- `git diff --check`：通过。
- `npm test` 已执行，所有与本次 Endpoint/图片任务相关测试及绝大多数回归测试通过；剩余测试因仓库未纳入版本控制且被 `.gitignore` 忽略的 `temp/run-final-full-e2e.js` 缺失而停止，此文件缺失与本次改动无关。

## 升级注意事项
1. 部署 v1.3.72 后请重启服务，并在浏览器执行一次 Ctrl + F5 强制刷新。
2. 打开设置确认 Endpoint Base URL 为实际使用的 OpenAI 兼容服务地址；无需填写 `/images/generations` 或 `/images/edits` 路径。
3. 若通过旧客户端或脚本调用且未传 `baseUrl`，可使用 `DEFAULT_UPSTREAM_BASE_URL` 环境变量指定服务端默认上游。
4. 控制台中来自 `RuntimeBackground`、`autofill.service.ts` 的 “Did not autofill” 通常是浏览器扩展的自动填充日志，不属于 ChatUI 请求链路；排查接口问题时请查看 `/api/image-jobs` 的 Network 响应与服务端日志。
