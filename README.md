# ChatUI 极简聊天与生图工具

ChatUI 是一个轻量、无需前端构建、可直接部署的 OpenAI 兼容接口 Web 工具。它同时支持聊天、生图、图片编辑、附件上传、Markdown、数学公式、代码复制、思考内容展示和模型配置。

项目定位：用最少依赖快速接入第三方大模型网关、私有 OpenAI 兼容服务、聚合 API 或本地模型代理。

---

## 目录

- [最新能力](#最新能力)
- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [模型配置](#模型配置)
- [模型接口与 type 分类](#模型接口与-type-分类)
- [Markdown 与数学公式](#markdown-与数学公式)
- [图片生成与图片编辑](#图片生成与图片编辑)
- [附件能力](#附件能力)
- [本地存储与隐私](#本地存储与隐私)
- [目录结构](#目录结构)
- [开发与验证](#开发与验证)
- [发布与镜像仓库](#发布与镜像仓库)
- [常见问题](#常见问题)
- [安全建议](#安全建议)

---


## 当前版本重点

本版本重点围绕「稳定可部署、离线前端资源、长任务可恢复、思考模式交互约束」做了系统整理：

- 前端 Markdown、KaTeX、Mermaid 资源改为随仓库本地交付，避免线上 CDN 不稳定、MIME type 异常或外网不可达导致页面能力缺失。
- 服务端从单文件入口拆分为 `server/` 模块，保留 `server.js` 作为兼容启动入口，方便后续维护代理、附件解析、任务恢复和安全策略。
- Docker 镜像构建已显式包含 `server/` 与 `vendor/`，发布镜像后无需额外挂载这些目录。
- 聊天和图片任务使用后台 Job/SSE 机制，刷新页面后可恢复正在进行的任务状态。
- 输出过程中发送按钮切换为停止按钮；普通 Enter 不会误触停止，只有点击停止按钮才会中断当前输出。
- 思考模式关闭时禁用思考设置；输出过程中锁定思考开关和思考设置，避免同一轮请求参数被中途改变。
- 正在输出但用户滚动离开时显示“继续查看输出”浮动按钮；新建/切换会话后不会残留旧会话按钮。
- Header 参数支持会话级短 UUID 与消息级短 UUID，适合接入需要链路追踪或临时鉴权 Header 的网关。

---

## 最新能力

- **聊天与流式输出**：支持 OpenAI Chat Completions 兼容接口、流式输出、停止输出、重新生成、用户消息编辑后重发、回复完成提示音。
- **自动路由**：自动判断当前输入应走聊天、生图还是图片编辑；也可手动切换模式。
- **思考模式**：支持 reasoning / thinking 内容展示；思考内容默认持久展示；关闭思考时禁用思考设置；输出过程中禁止切换思考开关或修改思考强度。
- **继续查看输出**：输出过程中如果用户滚动离开当前输出位置，会显示“继续查看输出”按钮；点击后回到正在输出的位置；新建会话不会继承旧会话按钮状态。
- **Markdown 与公式**：支持 GFM Markdown、表格、任务列表、代码块、KaTeX 数学公式、Mermaid 图表。
- **代码复制**：代码块右上角提供图标复制按钮，复制成功后显示打勾图标，不占用正文布局。
- **模型配置**：模型配置弹窗支持加载 `/models`，按模型 `type` 自动区分聊天模型和生图模型。
- **未知类型模型**：模型接口没有返回 `type` 或 `type` 为空时，会显示红色 `未知类型`，并允许同时作为聊天模型和生图模型候选。
- **Header 参数**：支持多个附加 Header；支持手动值、会话级短 UUID、消息级短 UUID；适合请求追踪、租户标识、网关鉴权等场景。
- **图片能力**：支持文本生图、上传图片编辑、基于上一张生成图继续修改、图片预览、下载和历史图片恢复。
- **附件能力**：支持多附件上传；支持图片、多模态输入、常见文本/代码文件解析；不支持解析的附件会明确提示。
- **本地前端资源**：`markdown-it`、`KaTeX`、KaTeX 字体、Mermaid 已随仓库放在 `vendor/`，线上不依赖 CDN。
- **Docker 发布**：Dockerfile 已包含 `server/` 与 `vendor/`，Release 后镜像可直接运行。

---

## 功能特性

### 聊天

- 支持 OpenAI Chat Completions 兼容接口。
- 支持流式输出。
- 支持自动意图识别：自动判断聊天、生图或图片编辑。
- 支持手动切换聊天 / 生图模式。
- 支持普通消息复制。
- 支持用户消息编辑后重新发送。
- 支持助手回复重新生成。
- 支持回复完成提示音。
- 支持 reasoning / thinking / 思考内容展示。
- 思考内容默认保持显示，可通过按钮切换。

### Markdown

使用本地 `markdown-it` 渲染 Markdown，支持常见 GFM 语法：

- 标题
- 段落
- 粗体 / 斜体 / 删除线
- 引用
- 有序列表 / 无序列表
- 任务列表
- 表格
- 行内代码
- fenced code block
- 链接
- 图片
- 横线
- 换行

### 数学公式

使用本地 KaTeX 渲染数学公式，支持：

```text
$a^2 + b^2 = c^2$
```

```text
$$
\frac{1}{n}\sum_{i=1}^n x_i
$$
```

也支持：

```text
\( inline math \)
\[ block math \]
```

### 代码块复制

代码块会自动增强为带右上角复制按钮的代码框：

- 右上角图标按钮。
- 点击复制原始代码。
- 成功后按钮显示打勾图标。
- 不用文字提示，避免按钮被撑开。

### 生图与图片编辑

- 支持 OpenAI 兼容图片接口。
- 支持文本生成图片。
- 支持上传图片后进行图片编辑。
- 支持基于上一张生成图继续修改。
- 支持图片预览。
- 支持图片下载。
- 支持保持原图比例显示缩略图。
- 支持图片结果本地持久化，刷新后仍可恢复历史图片。
- 支持图片尺寸：
  - `auto`
  - `1024x1024`
  - `1024x1536`
  - `1536x1024`

### 附件

- 支持多附件上传。
- 支持图片附件作为多模态输入或图片编辑输入。
- 支持常见文本 / 代码文件解析为上下文。
- 不支持解析的附件会明确标注，避免误以为模型已读取正文。

### 配置弹窗

- 设置入口名称为“模型配置”。
- 浅色玻璃风 UI。
- 自定义下拉菜单。
- 支持模型加载。
- 支持按 `type` 自动筛选聊天模型与生图模型。
- 不再展示“直连模式”。
- 默认通过本地代理访问接口，减少跨域与鉴权问题。

---
### 思考模式交互

思考模式用于向上游模型传递 reasoning / thinking 相关参数，并在模型返回思考内容时展示在回复上方。

交互规则：

- 点击脑形图标可开启或关闭思考模式。
- 思考模式关闭时，思考强度和思考提供商菜单处于禁用状态，避免用户误以为设置会生效。
- 输出过程中，思考开关、思考强度、思考提供商都会被锁定；当前请求完成或停止后才允许再次修改。
- 如果当前模型没有返回可展示的思考过程，会显示“当前模型未返回可展示的思考过程”。
- 思考内容默认持久展示；如果关闭持久展示，历史消息可按设置隐藏思考内容。

### 输出与继续查看

ChatUI 对长回复和生图任务做了滚动保护：

- 正在输出时，如果用户停留在底部，页面会自动跟随最新内容。
- 如果用户手动向上滚动，系统不会强行把页面拉回底部。
- 当正在输出的消息离开当前可视焦点时，会显示“继续查看输出”按钮。
- 点击“继续查看输出”会把当前正在输出的回复重新定位到输入框上方，方便继续阅读。
- 新建会话、切换会话或输出结束后，旧会话的继续查看状态不会残留到新会话。

---

## 快速开始

### 环境要求

本地运行需要：

```text
Node.js 18+
```

推荐：

```text
Node.js 20+
```

### 克隆仓库

```bash
git clone https://github.com/MrLiuGangQiang/chatui.git
cd chatui
```

### 启动服务

```bash
node server.js
```

默认访问：

```text
http://127.0.0.1:8765
```

默认监听：

```text
HOST=0.0.0.0
PORT=8765
UPSTREAM_TIMEOUT_MS=600000  # 上游 API 超时，默认 10 分钟
```

可通过环境变量修改：

```bash
HOST=127.0.0.1 PORT=3000 UPSTREAM_TIMEOUT_MS=900000 node server.js
```

---

## Docker 部署

### 本地构建

```bash
docker build -t chatui .
docker run --rm -p 8765:8765 chatui
```

访问：

```text
http://127.0.0.1:8765
```

### 官方镜像地址

请固定使用以下两个镜像地址，不需要每次发版重新确认：

| 仓库 | 镜像地址 | 推荐用途 |
| --- | --- | --- |
| Docker Hub | `liugangqiang/chatui` | 海外服务器、Docker Hub 默认环境 |
| 阿里云 ACR | `registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui` | 国内服务器、阿里云或国内网络环境 |

常用标签：

| 标签 | 说明 |
| --- | --- |
| `latest` | 最新正式 Release 镜像 |
| `MAJOR.MINOR.PATCH` | 与 GitHub Release 对应的版本号，例如 `1.1.36` |

> 说明：GitHub Release tag 使用 `vMAJOR.MINOR.PATCH`，镜像标签使用去掉 `v` 的 `MAJOR.MINOR.PATCH`，例如 Release `v1.1.36` 对应镜像 `liugangqiang/chatui:1.1.36`。

### 使用 Docker Hub 镜像

```bash
docker pull liugangqiang/chatui:latest
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  liugangqiang/chatui:latest
```

指定版本运行：

```bash
docker pull liugangqiang/chatui:1.1.36
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  liugangqiang/chatui:1.1.36
```

### 使用阿里云 ACR 镜像

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
```

指定版本运行：

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:1.1.36
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:1.1.36
```

### 升级已有容器

以阿里云 ACR 为例：

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
docker stop chatui || true
docker rm chatui || true
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
```

如果希望固定版本，建议把 `latest` 换成明确版本号，例如 `1.1.36`。

---

## 模型配置

打开页面后点击右上角“模型配置”。

需要填写：

| 配置项 | 说明 |
| --- | --- |
| Endpoint Base URL | OpenAI 兼容接口地址，例如 `https://api.openai.com/v1` |
| API Key | 接口密钥 |
| 聊天模型 | 用于聊天、路由判断、文本回复 |
| 生图模型 | 用于图片生成或图片编辑 |
| 图片尺寸 | 生图尺寸，默认 `auto` |

配置会保存到当前浏览器 `localStorage`。

### Endpoint 示例

```text
https://api.openai.com/v1
https://your-gateway.example.com/v1
http://127.0.0.1:8000/v1
```

注意：Endpoint 不要写到具体接口路径，例如不要写成：

```text
https://api.example.com/v1/chat/completions
```

应写成：

```text
https://api.example.com/v1
```

---

## 模型接口与 type 分类

点击“加载模型”后，ChatUI 会请求：

```text
GET /models
```

如果网关要求额外 Header，可点击“连接信息”右侧的“参数配置”按钮添加多个 Header。

Header 值支持：

- 手动填写固定值。
- 内置短 UUID · 会话级：新建会话时生成，同一会话所有请求复用。
- 内置短 UUID · 消息级：每次发送、刷新或重新生成时生成新值。

并根据返回模型的 `type` 字段自动分类。

### 推荐返回格式

```json
{
  "data": [
    {
      "id": "gpt-4.1",
      "type": "chat"
    },
    {
      "id": "gpt-image-1",
      "type": "image_generation"
    }
  ]
}
```

也支持数组格式：

```json
[
  { "id": "chat-model", "type": "chat" },
  { "id": "image-model", "type": "image" }
]
```

### 聊天模型识别

以下 `type` 或关键词会归为聊天模型：

- `chat`
- `text`
- `llm`
- `language`
- `completion`
- `reason`
- `assistant`
- `gpt`
- `claude`
- `gemini`
- `qwen`
- `deepseek`
- `llama`
- `mistral`

### 生图模型识别

以下 `type` 或关键词会归为生图模型：

- `image`
- `image_generation`
- `image-generation`
- `imagegeneration`
- `vision`
- `picture`
- `img`
- `dall`
- `gpt-image`
- `flux`
- `sd`
- `stable`
- `midjourney`
- `wan`
- `kling`

### 未返回 type 的模型

如果模型没有 `type` 字段，或 `type` 为空：

- 聊天模型下拉可选。
- 生图模型下拉也可选。
- 模型后显示红色标记：`未知类型`。
- 加载状态会显示未知类型数量，例如：

```text
已加载 12 个，3 个未知类型
```

不会弹出额外警告框。

---

## Markdown 与数学公式

本项目将 Markdown 与公式渲染资源放在本地：

```text
vendor/markdown-it.min.js
vendor/katex.min.js
vendor/katex.min.css
vendor/fonts/*
```

部署时必须确保 `vendor/` 目录被包含，否则线上会出现：

- `markdown-it.min.js 404`
- `katex.min.js 404`
- `katex.min.css 404`
- MIME type 报错
- Markdown / 公式无法渲染

### 示例

````md
# 标题

> 引用内容

- [x] 任务列表
- 普通列表

| A | B |
|---|---|
| **粗体** | $a^2+b^2=c^2$ |

```js
console.log('hello')
```
````

数学公式：

```md
行内公式：$a^2+b^2=c^2$

块级公式：
$$
E = mc^2
$$
```

---

## 图片生成与图片编辑

### 文本生成图片

在自动模式下，输入明确生图需求时会自动走生图流程。

也可以手动切换到生图模式。

### 上传图片编辑

上传图片后输入修改需求，例如：

```text
把这张图改成赛博朋克风格
```

系统会调用图片编辑接口。

### 基于上一张图继续修改

当已有生成图时，可以继续输入：

```text
基于上一张图，把背景换成雪山
```

系统会尝试使用上一张图作为编辑输入。

---

## 附件能力

支持：

- 图片文件
- 文本文件
- 常见代码文件
- 多文件上传

对于无法解析的文件，消息中会提示该文件未解析正文。

---

## 本地存储与隐私

ChatUI 不需要数据库。

浏览器本地存储内容：

| 数据 | 存储位置 |
| --- | --- |
| 接口配置 | `localStorage` |
| 聊天显示历史 | `localStorage` |
| 生成图片 / 历史图片 | `IndexedDB` |
| 最近生成图片上下文 | `localStorage` + `IndexedDB` |

注意：

- API Key 保存在当前浏览器本地。
- 清空浏览器站点数据会删除配置与历史。
- 不建议在不可信设备上保存长期可用的 API Key。

---

## 目录结构

```text
.
├── app.js                         # 前端主逻辑
├── index.html                     # 页面结构
├── styles.css                     # 页面样式
├── server.js                      # HTTP 入口、路由编排、兼容旧部署入口
├── server/                        # 服务端模块
│   ├── app.js                     # 应用装配：JobStore、代理、路由、静态服务
│   ├── config/                    # 端口、根目录、上游超时、代理 allowlist
│   ├── api/                       # HTTP 路由分发
│   ├── http/                      # 响应头、JSON 响应、请求体读取、静态资源
│   ├── proxy/                     # OpenAI 兼容代理、图片代理、Header 规范化
│   ├── extract/                   # 附件解析路由、PDF、Office、OpenXML ZIP、通用工具
│   ├── security/                  # 上游 URL 安全策略
│   └── jobs/                      # 聊天任务、图片任务、SSE/abort、内存仓库、reasoning 工具
├── vendor/                        # 本地第三方前端资源
│   ├── markdown-it.min.js         # Markdown 渲染
│   ├── katex.min.js               # 数学公式渲染
│   ├── katex.min.css              # KaTeX 样式
│   ├── fonts/                     # KaTeX 字体文件
│   └── mermaid.min.js             # Mermaid 图表渲染
├── test/                          # 自动化冒烟测试
│   └── smoke-test.js              # 启动、静态资源、API、任务生命周期测试
├── Dockerfile                     # Docker 镜像定义
├── .dockerignore                  # Docker 构建忽略文件
├── .github/workflows/dockerhub.yml# Release 后构建并推送 Docker Hub / 阿里云 ACR
└── README.md                      # 项目说明
```

---

## 开发与验证

### 全量测试

```bash
npm test
```

当前测试会执行：

- `server.js` / `app.js` / `test/smoke-test.js` 语法检查。
- 启动本地测试服务。
- 检查 `/api/version`、安全响应头、首页加载。
- 检查本地 `vendor/` 静态资源。
- 检查代理路径 allowlist。
- 检查聊天任务和图片任务的创建 / 中止生命周期。

### 语法检查

```bash
node --check app.js
node --check server.js
node --check test/smoke-test.js
```

### 启动检查

```bash
node server.js
curl -fsS http://127.0.0.1:8765
```

### 检查 vendor 资源

```bash
curl -I http://127.0.0.1:8765/vendor/markdown-it.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.css
curl -I http://127.0.0.1:8765/vendor/mermaid.min.js
```

期望：

- JS 返回 `Content-Type: application/javascript`
- CSS 返回 `Content-Type: text/css`
- 状态码为 `200`

---

## 发布与镜像仓库

项目通过 GitHub Release 触发 GitHub Actions 构建多架构 Docker 镜像，并推送到 Docker Hub 与阿里云 ACR。

### 固定镜像地址

后续文档、Release Notes、部署说明默认使用以下地址：

```text
Docker Hub: liugangqiang/chatui
阿里云 ACR: registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui
```

除非明确迁移仓库，否则不要在发版时临时改镜像地址。

### Release 触发流程

1. 提交并推送 `main` 分支。
2. 创建符合 `vMAJOR.MINOR.PATCH` 格式的 Git tag，例如 `v1.1.36`。
3. 创建 GitHub Release。
4. GitHub Actions 读取 Release tag。
5. 校验 `package.json` 与 `package-lock.json` 版本必须等于 tag 去掉 `v` 后的版本号。
6. 构建 `linux/amd64` 与 `linux/arm64` 多架构镜像。
7. 先推送阿里云 ACR，再复制/同步到 Docker Hub。

### 镜像标签规则

当前工作流发布以下标签：

| 标签 | 示例 | 说明 |
| --- | --- | --- |
| `latest` | `liugangqiang/chatui:latest` | 最新正式版本 |
| `MAJOR.MINOR.PATCH` | `liugangqiang/chatui:1.1.36` | 精确版本标签 |

### Release Notes 规范

正式 Release Notes 必须包含以下四节：

- 新增：新增能力、入口、配置、文档、部署方式。
- 删除：移除的功能、依赖、配置或行为；没有则写“无”。
- 修改：已有行为、UI、结构、默认值、部署流程的调整。
- 修复：bug、兼容性、构建、部署、安全或体验问题修复。

Release Notes 应面向使用者说明实际影响，不能只写 commit message。

### 发布前检查

建议至少执行：

```bash
npm test
git diff --check
```

如涉及 Docker 镜像内容，确认 Dockerfile 包含必要目录：

```dockerfile
COPY server ./server
COPY vendor ./vendor
```

如涉及前端资源，确认以下文件可在容器内访问：

```text
/vendor/markdown-it.min.js
/vendor/katex.min.js
/vendor/katex.min.css
/vendor/mermaid.min.js
/vendor/fonts/*
```

---

## 常见问题

### 页面提示 markdown-it.min.js 或 katex.min.js 404

说明部署产物中缺少 `vendor/` 目录。

处理：

- 确认 `vendor/markdown-it.min.js` 存在。
- 确认 `vendor/katex.min.js` 存在。
- 确认 `vendor/katex.min.css` 存在。
- 确认 `vendor/fonts/` 下的 KaTeX 字体存在。
- 确认 `vendor/mermaid.min.js` 存在。
- 重新构建并部署。

### 控制台提示 MIME type 不支持

通常是请求的 JS/CSS 文件返回了 404 HTML 或空内容。

处理：

```bash
curl -I http://your-host/vendor/markdown-it.min.js
curl -I http://your-host/vendor/katex.min.css
```

确认状态码和 `Content-Type` 正确。

### 模型没有出现在正确下拉里

检查 `/models` 返回中的 `type` 字段。

推荐：

```json
{ "id": "your-chat-model", "type": "chat" }
{ "id": "your-image-model", "type": "image_generation" }
```

如果没有 `type`，模型会被标记为 `未知类型`，并同时出现在聊天和生图下拉中。

### 生图失败

检查：

- Endpoint 是否正确。
- 生图模型是否选择正确。
- 模型是否支持 OpenAI 兼容图片接口。
- 图片尺寸是否被该模型支持。
- API Key 是否有生图权限。

### 聊天没有流式输出

可能原因：

- 上游接口不支持 streaming。
- 代理或网关没有正确转发 SSE。
- 模型服务返回了非标准流式格式。

系统会尽量降级处理，但建议检查上游接口兼容性。

### 清空对话会删除配置吗？

不会。清空对话只删除聊天和图片上下文，不删除模型配置和 API Key。

---

## 安全建议

- 不要把真实 API Key 写入仓库。
- 不要在公共设备上长期保存 API Key。
- 生产环境建议通过 HTTPS 访问。
- 如果使用反向代理，请限制管理入口访问范围。
- 如果接入私有模型网关，请做好鉴权和访问控制。
- 默认允许访问本机 / 内网上游，便于本地模型网关使用；公开部署时建议设置 `DISALLOW_PRIVATE_UPSTREAM=1`，阻止代理访问私有地址段，降低 SSRF 风险。
- 后台任务默认使用内存存储；可通过 `JOB_TTL_MS` 和 `MAX_JOBS_PER_STORE` 控制完成任务保留时间和单类任务上限。
- `vendor/` 是前端公开资源，不要放任何密钥。

---

## License

按仓库实际 License 为准。
