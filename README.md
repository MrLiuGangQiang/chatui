# ChatUI 极简聊天与生图工具

ChatUI 是一个轻量、可直接部署的 OpenAI 兼容 Web 工具。它以单页前端 + Node.js 本地代理为核心，支持聊天、流式输出、思考内容展示、文本生图、图片编辑、多附件解析、Markdown/数学公式/Mermaid 渲染、会话管理、任务恢复、本地图片缓存、使用统计排行榜和 Docker 镜像发布。

项目定位：用尽量少的依赖快速接入第三方大模型网关、私有 OpenAI 兼容服务、聚合 API 或本地模型代理。

---

## 目录

- [功能总览](#功能总览)
- [界面与交互](#界面与交互)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [模型配置](#模型配置)
- [聊天能力](#聊天能力)
- [思考模式](#思考模式)
- [图片生成与图片编辑](#图片生成与图片编辑)
- [附件能力](#附件能力)
- [Markdown、公式与图表](#markdown公式与图表)
- [会话、本地存储与任务恢复](#会话本地存储与任务恢复)
- [使用统计与排行榜](#使用统计与排行榜)
- [服务端 API 与代理](#服务端-api-与代理)
- [环境变量](#环境变量)
- [目录结构](#目录结构)
- [开发与验证](#开发与验证)
- [发布与镜像仓库](#发布与镜像仓库)
- [常见问题](#常见问题)
- [安全建议](#安全建议)
- [License](#license)

---

## 功能总览

### 聊天与模型调用

- OpenAI Chat Completions 兼容接口。
- 支持流式输出和普通非流式兜底。
- 支持聊天任务后台 Job 化，刷新后可恢复未完成输出。
- 支持停止当前输出。
- 支持重新生成助手回复。
- 支持编辑用户消息后重发，并替换对应回复。
- 支持会话级聊天模型覆盖：单个会话可选择不同聊天模型，也可跟随全局模型。
- 支持全局 System Prompt。
- 支持会话级 System Prompt 覆盖。
- 支持回复完成提示音。
- 支持模型返回 `output_text`、标准 `choices[].message.content`、SSE delta 等多种兼容格式。

### 自动路由

- 自动判断当前输入应走：
  - `chat`：普通聊天。
  - `image`：文本生成图片。
  - `edit_image`：图片编辑。
- 可配置独立路由模型；未配置时使用聊天模型。
- 路由只读取文字上下文、附件元数据和图片引用元数据，不把图片二进制、base64 或附件正文发给路由模型。
- 非图片附件上传时直接走聊天，先解析附件正文，不进入图片路由。
- 多图场景支持图片组、图片序号、图片 ID 和最近图片引用元数据。

### 图片能力

- 文本生成图片。
- 上传图片后编辑图片。
- 基于上一张生成图继续修改。
- 支持多图返回展示。
- 支持多图编辑上下文保存。
- 支持选择历史生成图引用，内部使用 `imgref_` / `img_` 标识。
- 支持图片预览。
- 支持单图下载和全部图片下载。
- 支持图片缩略图稳定尺寸，避免加载过程中布局跳动。
- 支持图片本地 IndexedDB 持久化，刷新后恢复历史图片。
- 支持上游返回图片 URL、`b64_json`、`image_base64`。
- 支持无法直连的上游图片通过 `/api/image` 同源代理下载。

### 附件能力

- 支持多附件上传。
- 支持点击上传、粘贴上传。
- 支持上传进度展示。
- 支持图片附件预览。
- 支持图片附件压缩：JPEG / PNG / WebP 会尽量压缩到合适大小。
- 支持 BMP 转 PNG。
- 支持图片附件作为多模态聊天内容或图片编辑输入。
- 支持文本/代码类文件读取为上下文。
- 支持 PDF 文本提取，并带多级 fallback。
- 支持 Word / Excel / PowerPoint 附件解析。
- 对无法解析的附件会在消息中明确说明，避免误以为模型已读取正文。

### Markdown 与富文本展示

- 本地 `markdown-it` 渲染 Markdown。
- 支持标题、列表、任务列表、表格、引用、链接、图片、删除线、代码块等常见 GFM 能力。
- 支持 KaTeX 行内公式和块级公式。
- 支持 Mermaid 图表。
- 支持代码块语言标识。
- 支持代码块右上角复制按钮。
- 支持表格横向滚动包装。
- 支持标题自动锚点。
- 支持部分扩展 Markdown：脚注、引用式链接、mark、高/下标、常用 emoji shortcode。
- 当 `markdown-it` 不可用时有内置 legacy renderer 兜底。

### 会话与本地状态

- 多会话列表。
- 新建会话。
- 切换会话。
- 重命名会话。
- 删除会话，删除时会确认。
- 每个会话独立保存消息、展示历史、最近图片、提示词、模型选择、Header UUID。
- 支持会话侧边栏收起。
- 移动端支持会话抽屉。
- 支持每个会话输入草稿保留。
- 支持会话标题自动从首条用户消息生成。
- 支持历史消息顺序规范化和去重，避免恢复时顺序错乱。

### 任务、恢复与滚动体验

- 聊天 Job 和图片 Job 使用内存任务仓库。
- 前端使用 SSE 监听任务更新。
- SSE 断开时支持轮询/重连策略。
- 页面刷新后恢复未完成聊天任务。
- 页面刷新后恢复未完成图片生成/编辑任务。
- 输出过程中显示“正在处理/正在生成/正在修改”与已等待时间。
- 上传图片编辑时显示上传进度。
- 用户滚动离开输出焦点时不强制拉回底部。
- 正在输出离开可视焦点时显示“继续查看输出”按钮。
- 点击“继续查看输出”可回到当前输出位置。
- 新建/切换会话不会残留旧会话的输出焦点。

### 使用统计能力

- 可选 PostgreSQL 使用统计，不配置数据库时自动关闭，不影响聊天、生图和附件功能。
- 支持今日排行、昨日排行、总排行，默认每个范围返回前 10 名。
- 支持通过环境变量调整排行榜返回数量。
- 支持个人使用统计，按当前浏览器配置的 API Key 查询。
- 统计范围支持今日、昨日、总计切换。
- 前端采用懒加载：打开弹窗只查当前范围，切换到哪个范围才查询哪个范围，已查询数据会在前端缓存。
- 后端使用独立 PostgreSQL 连接池，连接串、连接池大小、超时和 SSL 均通过环境变量配置。
- 统计模块与聊天、图片、附件和 OpenAI 代理解耦，独立路由为 `/api/usage/*`。

### 部署与工程能力

- 无前端构建步骤，静态资源直接交付。
- 本地 vendored：`markdown-it`、`KaTeX`、KaTeX 字体、Mermaid。
- Node.js HTTP 服务静态托管前端。
- 服务端代理只允许白名单路径。
- 支持 Docker 多架构镜像。
- GitHub Release 触发 GitHub Actions 构建镜像。
- 镜像推送到 Docker Hub 和阿里云 ACR。
- 测试覆盖前端 core/services/ui/app、服务端 API、附件解析、路由、任务和冒烟流程。

---

## 界面与交互

### 主界面

- 左侧会话栏：会话列表、新建会话、重命名、删除、当前会话条数。
- 收起态会话栏：保留展开、新会话、会话入口、模型配置入口。
- 移动端会话入口：小屏幕下通过浮动按钮打开会话抽屉。
- 消息区：展示用户消息、助手消息、错误消息、图片结果、附件预览。
- 输入区：附件按钮、会话提示词按钮、会话生图样式按钮、会话模型按钮、思考开关、发送/停止按钮。
- 配置弹窗：Endpoint、API Key、模型加载、模型选择、图片尺寸、全局提示词、全局生图样式提示词、Header 参数。

### 输入与发送

- Enter 发送。
- Shift + Enter 换行。
- 中文输入法组合结束后会重新计算输入框高度。
- 文件可通过附件按钮选择，也可直接粘贴。
- 文件处理过程中发送按钮会禁用或提示等待。
- 输出过程中发送按钮切换为停止按钮；只有点击停止按钮才会中断，普通 Enter 不会误触停止。

### 消息操作

- 用户消息支持编辑重发。
- 助手消息支持重新生成。
- 消息支持复制。
- 助手回答支持下载为文本文件。
- 代码块支持单独复制。
- 图片支持预览、下载、分享（浏览器支持 Web Share 文件分享时）。

### 会话级设置

- 会话 System Prompt：可单独设置当前会话提示词。
- 会话生图样式提示词：可单独设置当前会话图片风格要求。
- 会话聊天模型：可让当前会话使用独立聊天模型，或跟随全局聊天模型。
- 会话级设置保存在本地，仅影响当前浏览器当前会话。

---

## 快速开始

### 环境要求

```text
Node.js 20.19+
```

推荐直接使用与容器和 CI 一致的 Node.js 22 LTS。

### 克隆仓库

```bash
git clone https://github.com/MrLiuGangQiang/chatui.git
cd chatui
```

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm start
```

等价于：

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

| 仓库 | 镜像地址 | 推荐用途 |
| --- | --- | --- |
| Docker Hub | `liugangqiang/chatui` | 海外服务器、Docker Hub 默认环境 |
| 阿里云 ACR | `registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui` | 国内服务器、阿里云或国内网络环境 |

常用标签：

| 标签 | 说明 |
| --- | --- |
| `latest` | 最新正式 Release 镜像 |
| `MAJOR.MINOR.PATCH` | 与 GitHub Release 对应的版本号，例如 `1.1.76` |

> GitHub Release tag 使用 `vMAJOR.MINOR.PATCH`，镜像标签使用去掉 `v` 的 `MAJOR.MINOR.PATCH`。例如 Release `v1.1.76` 对应镜像 `liugangqiang/chatui:1.1.76`。

### 使用 Docker Hub 镜像

```bash
docker pull liugangqiang/chatui:latest
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  liugangqiang/chatui:latest
```

指定版本：

```bash
docker pull liugangqiang/chatui:1.1.76
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  liugangqiang/chatui:1.1.76
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

指定版本：

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:1.1.76
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:1.1.76
```

### 升级已有容器

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

如果需要固定版本，把 `latest` 换成明确版本号，例如 `1.1.76`。

---

## 模型配置

打开页面后点击“模型配置”。

### 基础配置

| 配置项 | 说明 |
| --- | --- |
| Endpoint Base URL | OpenAI 兼容接口地址；默认 `https://ingress.lfans.cn/v1`，也可改成自己的服务，例如 `https://api.openai.com/v1` |
| API Key | 接口密钥，保存在浏览器本地 |
| 聊天模型 | 用于聊天、路由判断和文本回复 |
| 路由模型 | 用于判断聊天/生图/修图；为空时使用聊天模型 |
| 生图模型 | 用于图片生成或图片编辑 |
| 图片尺寸 | 生图尺寸，默认 `auto` |
| System Prompt | 全局聊天系统提示词 |
| 图片样式提示词 | 全局生图/修图风格要求，会附加到图片 prompt |

Endpoint 示例：

```text
https://ingress.lfans.cn/v1
https://api.openai.com/v1
https://your-gateway.example.com/v1
http://127.0.0.1:8000/v1
```

不要写到具体接口路径，例如不要写成：

```text
https://api.example.com/v1/chat/completions
```

应写成：

```text
https://api.example.com/v1
```

### 模型加载

点击“加载模型”后，ChatUI 会通过本地代理请求：

```text
GET /models
```

推荐上游返回：

```json
{
  "data": [
    { "id": "gpt-4.1", "type": "chat" },
    { "id": "gpt-image-1", "type": "image_generation" }
  ]
}
```

也支持数组：

```json
[
  { "id": "chat-model", "type": "chat" },
  { "id": "image-model", "type": "image" }
]
```

### 模型类型识别

聊天模型关键词：

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

生图模型关键词：

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

如果模型没有 `type` 字段，或 `type` 为空：

- 聊天下拉可选。
- 生图下拉也可选。
- 模型后显示红色 `未知类型` 标记。
- 加载状态会显示未知类型数量，例如 `已加载 12 个，3 个未知类型`。

### Header 参数

如果网关要求额外 Header，可在“参数配置”中添加多条 Header。

Header 值模式：

| 模式 | 说明 |
| --- | --- |
| 手动值 | 固定 Header 值 |
| 会话级短 UUID | 每个会话生成一次，同一会话内所有请求复用 |
| 消息级短 UUID | 每次发送、刷新或重新生成时生成新值 |

适用场景：请求追踪、租户标识、网关鉴权、链路调试。

---

## 聊天能力

### 请求链路

聊天请求最终调用：

```text
POST /chat/completions
```

前端会通过本地代理发送，避免浏览器跨域和直连鉴权问题。

### 流式输出

- 默认使用流式输出。
- 支持标准 SSE `data: ...`。
- 支持 `[DONE]` 结束标记。
- 支持解析 reasoning/thinking delta。
- 如果流式失败，会尝试普通非流式请求兜底。
- 如果上游提示不支持某类 reasoning 参数，会自动降级重试。

### 重新生成与编辑重发

- 助手消息可重新生成。
- 用户消息可编辑后重发。
- 编辑重发会尽量复用原消息位置，并替换对应助手回复。
- 历史恢复时会按 `messageIndex` / `responseIndex` 规范排序，相同索引固定 `system → user → assistant`。

### 停止输出

- 输出中点击发送按钮会执行停止。
- 停止会 abort 当前 run 关联的聊天/图片 Job。
- 如果已有有效内容，会保留已有输出。
- 如果只有占位内容，会显示“用户停止”。

---

## 思考模式

思考模式用于向上游模型传递 reasoning / thinking 相关参数，并在模型返回思考内容时显示在回复上方。

### 支持的思考强度

| 显示 | 内部值 | 说明 |
| --- | --- | --- |
| 快速 | `low` | 较低 reasoning budget |
| 标准 | `medium` | 默认强度 |
| 深度 | `high` | 更高 reasoning budget |
| 最强 | `xhigh` | 最高预设；不支持时自动降级到 high |

### 支持的提供商模式

| 显示 | 内部值 | 说明 |
| --- | --- | --- |
| 自动 | `auto` | 自动选择兼容参数 |
| OpenAI | `openai` | OpenAI reasoning 风格 |
| Claude | `anthropic` | Anthropic thinking 风格 |
| Google | `google` | Google thinking 风格 |
| Qwen 兼容 | `thinking-budget` | 使用 thinking budget 风格参数 |
| 通用 | `generic` | 通用 reasoning 字段 |

### 交互规则

- 点击脑形图标开启/关闭思考模式。
- 关闭思考模式时，思考强度和提供商菜单禁用。
- 输出过程中锁定思考开关和思考设置，避免同一轮请求参数中途变化。
- 如果模型未返回可展示的思考过程，会显示“当前模型未返回可展示的思考过程”。
- 思考内容默认持久展示。

---

## 图片生成与图片编辑

### 文本生成图片

在自动模式下，输入明确生图需求会自动走生图流程。

也可手动切换到生图模式。

示例：

```text
生成一张赛博朋克城市夜景，16:9，霓虹灯风格
```

### 上传图片编辑

上传图片后输入修改需求：

```text
把这张图改成赛博朋克风格
```

系统会调用图片编辑接口。

### 基于上一张图继续修改

已有生成图后，可继续输入：

```text
基于上一张图，把背景换成雪山
```

系统会从 IndexedDB 恢复上一张图作为编辑输入。

### 多图与图片引用

- 图片结果可包含多张图。
- 最近生成图会保存为图片组。
- 多图默认按整组参与后续编辑。
- 用户明确“第一张/第二张/左边/右边/全部”时，路由阶段会尝试识别选择范围。
- 图片引用使用：
  - `imgref_...`：图片组引用。
  - `img_...`：单图引用。
- 部分编辑场景会将选中的新结果合并回原图片组上下文。

### 图片尺寸

当前配置中支持：

```text
auto
1024x1024
1024x1536
1536x1024
```

最终是否支持取决于上游图片模型。

### 图片结果操作

- 点击图片可预览大图。
- 单图下载。
- 全部图片下载。
- 支持浏览器原生分享时可分享图片文件。
- 图片缩略图记录原始尺寸和缩略图尺寸，刷新恢复时保持稳定布局。

---

## 附件能力

### 支持的上传方式

- 点击附件按钮选择文件。
- 粘贴文件到输入区。
- 多文件同时上传。

### 图片附件

支持识别：

```text
png, jpg, jpeg, gif, webp, bmp, svg
```

处理能力：

- 图片预览。
- 图片压缩。
- BMP 转 PNG。
- 图片作为聊天多模态内容。
- 图片作为图片编辑输入。
- 图片缓存到 IndexedDB，避免大 base64 长期写入 localStorage。

### 文本与代码附件

常见文本/代码文件会读取正文并追加到聊天上下文中。

如果疑似二进制或无法解析，会在消息里说明未能解析正文。

### PDF 附件

PDF 解析顺序：

1. `pdftotext` / Poppler，优先用于稳定提取中文和布局文本。
2. `pdf-parse` / pdf.js。
3. 基础 PDF 文本流解析。
4. OCR fallback：`pdftoppm` 转图片 + `tesseract`，语言为 `chi_sim+eng`。

如果 OCR 依赖不可用，会返回明确提示。

### Office 附件

支持：

| 类型 | 扩展名 | 解析方式 |
| --- | --- | --- |
| Word | `.docx`, `.doc` | 优先 mammoth，失败后 officeparser / OpenXML fallback |
| Excel | `.xlsx`, `.xlsm`, `.xls` | 优先 officeparser，失败后解析工作簿 XML 预览 |
| PowerPoint | `.pptx`, `.ppt` | 优先 officeparser，失败后解析 slide XML |

Excel fallback 会提取最多前 8 个工作表、每个表前 80 行、前 40 列，并转成 Markdown 表格预览。

### 附件上下文规则

- 路由模型只看附件元数据，不读取附件正文。
- 聊天模型可读取文本/Office/PDF 提取结果。
- 图片编辑接口只接收图片附件。
- 不支持解析的附件不会把二进制强行发给聊天模型。

---

## Markdown、公式与图表

### 本地前端资源

项目将 Markdown、公式和图表资源放在本地：

```text
vendor/markdown-it.min.js
vendor/katex.min.js
vendor/katex.min.css
vendor/fonts/*
vendor/mermaid.min.js
```

部署时必须包含 `vendor/`，否则 Markdown、公式或 Mermaid 可能无法渲染。

### Markdown 示例

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

### 数学公式

行内公式：

```md
$a^2 + b^2 = c^2$
```

块级公式：

```md
$$
E = mc^2
$$
```

也支持：

```md
\( inline math \)
\[ block math \]
```

### Mermaid

使用 `mermaid` 代码块：

````md
```mermaid
flowchart TD
  A[输入] --> B{路由}
  B --> C[聊天]
  B --> D[生图]
  B --> E[修图]
```
````

---

## 会话、本地存储与任务恢复

ChatUI 不需要数据库，主要使用浏览器本地存储。

### 存储位置

| 数据 | 存储位置 |
| --- | --- |
| 接口配置 | `localStorage` |
| API Key | `localStorage` |
| 会话元信息 | `localStorage` |
| 聊天规范消息 | `localStorage` |
| 展示历史 display | `localStorage` |
| 最近生成图片上下文 | `localStorage` + `IndexedDB` |
| 上传/生成图片二进制 | `IndexedDB` |
| 未完成 Job 记录 | `localStorage` |

### 历史恢复

- `messages` 保存规范聊天历史。
- `display` 保存富媒体展示历史。
- 恢复时会结合两者修复历史展示。
- 图片不直接写入 localStorage，而是保存 `indexeddb://...` 引用。
- 清空浏览器站点数据会删除配置、历史和图片缓存。

### 任务恢复

- 聊天任务记录保存为 `CHAT_JOB_KEY:<sessionId>`。
- 图片任务记录保存为 `IMAGE_JOB_KEY:<sessionId>`。
- 页面刷新或切换回来时，会尝试恢复未完成任务。
- 如果服务端任务已过期或服务重启导致任务不存在，会显示明确错误并清理过期 pending 状态。

---
## 使用统计与排行榜

使用统计是可选能力，依赖外部 PostgreSQL 数据库中的使用日志表。未配置数据库连接时，前端统计入口仍可打开，但接口会返回不可用状态，核心聊天、生图、图片编辑和附件解析不受影响。

#### 展示能力

- 右上角使用统计按钮，点击打开独立统计弹窗。
- 个人统计默认展示今日，并支持今日、昨日、总计切换。
- 排行榜支持今日排行、昨日排行、总排行。
- 部门统计需要服务端配置访问密码后启用，点击右上角刷新按钮左侧的“部门”切换按钮进入；首次进入需输入密码，校验通过后会像 API Key 一样保存到浏览器本地。
- 部门统计支持今日排行、昨日排行、本月排行、上月排行、总排行。
- 部门统计不受排行榜数量限制，会展示所有部门。
- 部门排行可点击部门下钻查看该部门所有成员使用统计。
- 部门统计支持导出标准 `.xlsx`，第一个 Sheet 为部门排行，后续每个 Sheet 为对应部门人员使用统计；导出包含序号、开始时间、结束时间和各 token 指标。
- 排行榜默认展示前 10 名，可通过环境变量调整。
- 前三名使用金、银、铜视觉样式，但显示文本仍为 `1 / 2 / 3`。
- 指标包括：总用量、输入、输出、缓存输入、推理输出。
- 百万以上使用 `M`，亿以上使用 `B`，鼠标悬停可查看完整数值。

#### 查询策略

- 前端采用懒加载，打开弹窗只查询当前展示范围。
- 切换排行榜 Tab 时，只查询目标范围排行榜。
- 切换个人统计范围时，只查询目标范围个人统计。
- 已加载过的数据会在当前页面生命周期内缓存，重复切换不重复查询。
- 点击刷新按钮只刷新当前展示的个人统计范围和当前排行榜范围。

#### 数据库连接

- 后端使用 `pg.Pool` 连接池复用数据库连接。
- 连接串、分散连接参数、连接池最小/最大连接数、空闲超时、连接超时和 SSL 均通过环境变量配置。
- 推荐生产环境使用单变量连接串，例如：

```bash
POSTGRES_URL='postgres://user:password@postgres-host:5432/database?sslmode=disable'
```

请不要在仓库、镜像或文档中写入真实数据库账号、密码、主机或连接串。

---

## 服务端 API 与代理

### 核心 API

| API | 方法 | 说明 |
| --- | --- | --- |
| `/api/version` | GET | 返回当前应用版本，来自 `package.json` |
| `/api/image` | POST | 同源图片代理下载，用于上游图片 URL 无法直接加载时 |
| `/api/extract-file` | POST | 附件文本提取：PDF / Office 等 |
| `/api/chat-stream-jobs` | POST | 注册/启动聊天流式 Job |
| `/api/usage/rankings?range=today|yesterday|total` | GET | 查询指定范围排行榜，懒加载按需查询 |
| `/api/usage/personal` | POST | 查询指定范围个人统计，body 包含 `api_key` 与 `range` |
| `/api/usage/department/verify` | POST | 校验部门统计访问密码，body 包含 `password` |
| `/api/usage/department/rankings` | POST | 查询部门排行，body 包含 `password` 与 `range=today|yesterday|month|last_month|total` |
| `/api/usage/department/users` | POST | 查询部门人员统计，body 包含 `password`、`department_id` 与 `range` |
| `/api/usage/department/export` | POST | 导出部门统计标准 `.xlsx`，body 包含 `password` 与 `range` |

### Job API

| API | 方法 | 说明 |
| --- | --- | --- |
| `/api/chat-jobs` | POST | 创建聊天 Job |
| `/api/chat-jobs/:id` | GET | 查询聊天 Job |
| `/api/chat-jobs/:id/events` | GET | 订阅聊天 Job SSE |
| `/api/chat-jobs/:id/abort` | POST | 中止聊天 Job |
| `/api/image-jobs` | POST | 创建图片生成/编辑 Job |
| `/api/image-jobs/:id` | GET | 查询图片 Job |
| `/api/image-jobs/:id/events` | GET | 订阅图片 Job SSE |
| `/api/image-jobs/:id/abort` | POST | 中止图片 Job |

### OpenAI 兼容代理

所有 `/api/*` 且不属于内部 API 的请求会走代理白名单。

允许路径：

```text
/models
/chat/completions
/images/generations
/openai/image_edit
```

允许方法：

```text
GET, POST
```

代理会处理：

- `baseUrl` 规范化。
- `apiKey` 注入 Authorization。
- 自定义 Header 透传。
- 上游超时。
- SSE 转发。
- 图片上游路径规则：纯文本生图走 `/images/generations` JSON；图片编辑/参考图生成走 `/openai/image_edit` multipart。前端/本地缓存里的 base64 会在服务端转成文件 Blob，按 `image[]` 数组字段上传；多图会重复追加多个 `image[]` 字段。
- 流式聊天 Job 同步更新。
- 错误响应标准化。

### 静态资源服务

- 默认 `/` 返回 `index.html`。
- 支持 `GET` / `HEAD`。
- 防止路径穿越。
- JS / CSS / JSON / 图片 / 字体 MIME 类型显式设置。
- JS / CSS / HTML 使用 `no-cache`。
- 其他静态资源默认 `public, max-age=3600`。
- 如果同目录存在更新的 `.br` 或 `.gz`，会按 `Accept-Encoding` 返回预压缩版本。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `8765` | HTTP 监听端口 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游 API 超时，默认 10 分钟 |
| `CHATUI_UPSTREAM_PROXY` | `not set` | HTTP/HTTPS outbound proxy for public Endpoint requests from the container; takes precedence over `HTTPS_PROXY` / `HTTP_PROXY`, for example `http://host.docker.internal:7890`. Private upstreams bypass this proxy. |
| `HTTPS_PROXY` / `HTTP_PROXY` | `not set` | Fallback outbound proxy settings when `CHATUI_UPSTREAM_PROXY` is empty. On a Linux Docker host, do not use `127.0.0.1` unless the proxy runs inside this container; use a container-reachable host or gateway address. |
| `CHATUI_VERBOSE_LOGS` | `not set` | Set to `1` to emit redacted upstream diagnostics; API keys and image Base64 payloads are never logged. |
| `CHATUI_CONTEXT_WINDOW_TOKENS` | `262144` | 聊天请求上下文窗口预算，约 256k estimated tokens；超出时会裁剪较早历史并插入自动上下文摘要/摘录，只影响发给模型的 payload，不删除本地会话记录 |
| `DISALLOW_PRIVATE_UPSTREAM` | 未设置 | 设置为 `1` 时禁止代理访问私有/内网地址 |
| `JOB_TTL_MS` | `3600000` | JobStore 任务保留时长，默认 1 小时 |
| `MAX_JOBS_PER_STORE` | `200` | 每类任务最多保留数量 |
| `NODE_ENV` | Docker 中为 `production` | Node 运行环境 |
| `POSTGRES_URL` | 未设置 | PostgreSQL 单变量连接串，推荐生产部署使用，例如 `postgres://user:password@host:5432/database?sslmode=disable` |
| `POSTGRESQL_URL` | 未设置 | PostgreSQL 连接串别名 |
| `PG_DATABASE_URL` | 未设置 | PostgreSQL 连接串别名 |
| `DATABASE_URL` | 未设置 | 通用数据库连接串别名 |
| `PGHOST` / `POSTGRES_HOST` | 未设置 | PostgreSQL 主机；未使用连接串时生效 |
| `PGPORT` / `POSTGRES_PORT` | `5432` | PostgreSQL 端口；未使用连接串时生效 |
| `PGDATABASE` / `POSTGRES_DATABASE` | 未设置 | PostgreSQL 数据库名；未使用连接串时生效 |
| `PGUSER` / `POSTGRES_USER` | 未设置 | PostgreSQL 用户名；未使用连接串时生效 |
| `PGPASSWORD` / `POSTGRES_PASSWORD` | 未设置 | PostgreSQL 密码；未使用连接串时生效 |
| `PG_POOL_MIN` / `POSTGRES_POOL_MIN` | `0` | PostgreSQL 连接池最小连接数 |
| `PG_POOL_MAX` / `POSTGRES_POOL_MAX` | `10` | PostgreSQL 连接池最大连接数 |
| `PG_IDLE_TIMEOUT_MS` / `POSTGRES_IDLE_TIMEOUT_MS` | `30000` | PostgreSQL 连接池空闲连接回收时间 |
| `PG_CONNECTION_TIMEOUT_MS` / `POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | PostgreSQL 建连超时时间 |
| `PGSSL` / `POSTGRES_SSL` | 未设置 | PostgreSQL SSL 开关；可设为 `true` / `require` / `false` |
| `USAGE_RANKING_LIMIT` | `10` | 使用排行榜每个范围返回数量，非法值回退到 10，最大 100 |
| `USAGE_STATS_RANKING_LIMIT` | 未设置 | 排行榜数量兼容别名 |
| `USAGE_DEPARTMENT_PASSWORD` | `not set` | Password for department statistics; disabled when unset. |
| `USAGE_STATS_DEPARTMENT_PASSWORD` | `not set` | Compatible alias for the department statistics password. |

Docker proxy example (the proxy URL must be reachable **from inside the container**):

```bash
docker run -d --name chatui --restart unless-stopped -p 8765:8765 \
  -e CHATUI_UPSTREAM_PROXY=http://host.docker.internal:7890 \
  -e CHATUI_VERBOSE_LOGS=1 \
  liugangqiang/chatui:1.3.73
```

If text requests work but visual chat fails, run `docker logs --tail 200 chatui` after one failed upload. The log records only target host/path, outbound byte size and the underlying network code (such as `ECONNRESET`); it does not include credentials or image data.


示例：

```bash
HOST=127.0.0.1 PORT=3000 UPSTREAM_TIMEOUT_MS=900000 CHATUI_CONTEXT_WINDOW_TOKENS=524288 node server.js
```

使用统计示例：

```bash
POSTGRES_URL='postgres://user:password@postgres-host:5432/database?sslmode=disable' \
PG_POOL_MIN=0 \
PG_POOL_MAX=10 \
USAGE_RANKING_LIMIT=10 \
USAGE_DEPARTMENT_PASSWORD='请替换为强密码' \
node server.js
```

公开部署建议：

```bash
DISALLOW_PRIVATE_UPSTREAM=1 node server.js
```

---

## 目录结构

```text
.
├── app.js                         # 浏览器端主业务编排入口
├── index.html                     # 页面结构、模板、配置弹窗、消息模板
├── styles.css                     # 全局样式、响应式布局、消息/图片/配置面板样式
├── server.js                      # Node HTTP 启动入口
├── client/                        # 前端拆分模块
│   ├── core/                      # 纯逻辑：附件、消息、模型、reasoning、图片引用、路由上下文、存储
│   ├── services/                  # 请求与 payload：模型、聊天、路由、生图、图片、Job、使用统计
│   ├── ui/                        # UI 辅助：消息渲染、图片操作、滚动、实时渲染、文件动作、统计弹窗
│   └── app/                       # 应用状态：会话、持久化、运行态、图片缓存、display items
├── server/                        # 服务端模块
│   ├── app.js                     # 服务装配：JobStore、代理、路由、静态服务
│   ├── config/                    # 端口、根目录、上游超时、代理 allowlist、版本
│   ├── api/                       # HTTP 路由分发
│   ├── db/                        # 可选数据库连接池，例如 PostgreSQL
│   ├── usage/                     # 使用统计查询仓库
│   ├── http/                      # 请求 body、响应、安全头、静态文件服务
│   ├── proxy/                     # OpenAI 兼容代理、图片代理、Header 规范化
│   ├── extract/                   # PDF / Office / OpenXML / OCR 辅助解析
│   ├── security/                  # 上游 URL 安全策略
│   └── jobs/                      # 聊天任务、图片任务、SSE、abort、内存任务仓库、reasoning
├── test/                          # 自动化测试
│   ├── unit/                      # 前后端单元与契约测试
│   ├── smoke/                     # HTTP 服务冒烟测试
│   └── run-tests.js               # 全量测试入口
├── vendor/                        # 本地第三方前端资源
│   ├── markdown-it.min.js
│   ├── katex.min.js
│   ├── katex.min.css
│   ├── mermaid.min.js
│   └── fonts/                     # KaTeX 字体
├── Dockerfile                     # Docker 镜像定义
├── .dockerignore                  # Docker 构建忽略文件
├── .github/workflows/dockerhub.yml# Release 后构建并推送 Docker Hub / 阿里云 ACR
├── AI_PROJECT_GUIDE.md            # 给 AI / 开发者的工程导览
├── package.json
├── package-lock.json
└── README.md
```

---

## 开发与验证

### 全量测试

```bash
npm test
```

等价于：

```bash
node test/run-tests.js
```

当前测试覆盖：

- `server.js`、`app.js`、前端模块、服务端测试文件语法检查。
- 前端 core：消息、模型、附件、图片引用、路由上下文、reasoning、storage。
- 前端 services：模型、Job、聊天、路由、生图、图片解析。
- 前端 UI：文件动作、实时渲染、滚动、消息渲染、消息操作、图片操作。
- 前端 app：状态、run、会话、持久化、display item、runtime、image store。
- API、Job 生命周期、附件解析、路由与 HTTP 服务冒烟。

当前测试以 Node/JSDOM 和 HTTP smoke 为主；真实浏览器 E2E 作为后续增强项。

### 常用单项检查

```bash
node --check app.js
node --check server.js
node test/run-tests.js
node test/unit/server-hardening.test.js
node test/smoke/server-smoke.test.js
```

### 启动检查

```bash
node server.js
curl -fsS http://127.0.0.1:8765/api/version
curl -fsS http://127.0.0.1:8765/ >/dev/null
```

### 检查 vendor 资源

```bash
curl -I http://127.0.0.1:8765/vendor/markdown-it.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.css
curl -I http://127.0.0.1:8765/vendor/mermaid.min.js
```

期望：

- JS 返回 `Content-Type: application/javascript`。
- CSS 返回 `Content-Type: text/css`。
- 状态码为 `200`。

---

## 发布与镜像仓库

项目通过 GitHub Release 触发 GitHub Actions 构建多架构 Docker 镜像，并推送到 Docker Hub 与阿里云 ACR。

### 固定镜像地址

```text
Docker Hub: liugangqiang/chatui
阿里云 ACR: registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui
```

除非明确迁移仓库，否则不要在发版时临时改镜像地址。

### Release 触发流程

1. 提交并推送 `main` 分支。
2. 创建符合 `vMAJOR.MINOR.PATCH` 格式的 Git tag，例如 `v1.1.76`。
3. 创建 GitHub Release。
4. GitHub Actions 读取 Release tag。
5. 校验 `package.json` 与 `package-lock.json` 版本必须等于 tag 去掉 `v` 后的版本号。
6. 构建 `linux/amd64` 与 `linux/arm64` 多架构镜像。
7. 先推送阿里云 ACR，再复制/同步到 Docker Hub。

### 镜像标签规则

| 标签 | 示例 | 说明 |
| --- | --- | --- |
| `latest` | `liugangqiang/chatui:latest` | 最新正式版本 |
| `MAJOR.MINOR.PATCH` | `liugangqiang/chatui:1.1.76` | 精确版本标签 |

### Release Notes 规范

正式 Release Notes 必须包含：

- 新增：新增能力、入口、配置、文档、部署方式。
- 删除：移除的功能、依赖、配置或行为；没有则写“无”。
- 修改：已有行为、UI、结构、默认值、部署流程的调整。
- 修复：bug、兼容性、构建、部署、安全或体验问题修复。

Release Notes 应面向使用者说明实际影响，不能只写 commit message。

### 发布前检查

```bash
npm test
git diff --check
```

如果涉及 Docker 镜像内容，确认 Dockerfile 包含必要目录：

```dockerfile
COPY client ./client
COPY server ./server
COPY vendor ./vendor
```

---

## 常见问题

### 页面提示 markdown-it.min.js、katex.min.js 或 mermaid.min.js 404

说明部署产物缺少 `vendor/` 目录。

处理：

- 确认 `vendor/markdown-it.min.js` 存在。
- 确认 `vendor/katex.min.js` 存在。
- 确认 `vendor/katex.min.css` 存在。
- 确认 `vendor/mermaid.min.js` 存在。
- 确认 `vendor/fonts/` 下的 KaTeX 字体存在。
- 重新构建并部署。

### 控制台提示 MIME type 不支持

通常是 JS/CSS 文件请求返回了 404 HTML 或空内容。

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

如果没有 `type`，模型会标记为 `未知类型`，并同时出现在聊天和生图下拉中。

### 生图失败

检查：

- Endpoint 是否正确。
- 生图模型是否选择正确。
- 模型是否支持 OpenAI 兼容图片接口。
- 图片尺寸是否被该模型支持。
- API Key 是否有生图权限。
- 上游是否支持 `/images/generations` 和 `/openai/image_edit`：纯文本生图走 `/images/generations` JSON；图片编辑/参考图生成走 `/openai/image_edit` multipart，服务端会把 base64 输入转成 `image[]` 文件数组字段。

### 图片显示失败但返回了 URL

可能是上游图片 URL 需要鉴权或跨域不可直接访问。ChatUI 会尝试通过 `/api/image` 同源代理下载，但要求图片 URL 与 Endpoint Base URL 同源。

### 聊天没有流式输出

可能原因：

- 上游接口不支持 streaming。
- 代理或网关没有正确转发 SSE。
- 模型服务返回非标准流式格式。
- 浏览器或网络环境中断 SSE。

ChatUI 会尽量降级为普通请求。

### PDF 没有识别出文字

可能是扫描件、图片型 PDF 或复杂字体编码 PDF。

建议：

- 使用 Docker 镜像，镜像内置 Poppler 和 Tesseract OCR 依赖。
- 确认 OCR 依赖可用：`pdftoppm`、`tesseract`、`chi_sim`、`eng`。
- 或将 PDF 导出为文本/Markdown 后再上传。

### 清空对话会删除配置吗？

不会。清空对话只删除当前会话聊天、展示历史和图片上下文，不删除模型配置和 API Key。

### 删除会话会删除图片缓存吗？

会删除该会话引用到的 IndexedDB 图片，并尝试清理孤儿图片缓存。

### 刷新后任务没有恢复

可能原因：

- 服务端内存 Job 已过期。
- 服务端重启后内存 Job 丢失。
- 浏览器本地 Job 记录被清理。

ChatUI 会显示“任务不存在或服务已重启”等错误，并清理过期 pending 状态。

---

## 安全建议

- 不要把真实 API Key 写入仓库。
- 不要在公共设备上长期保存 API Key。
- 生产环境建议通过 HTTPS 访问。
- 如果使用反向代理，请限制管理入口访问范围。
- 如果接入私有模型网关，请做好鉴权和访问控制。
- 公开部署时建议设置 `DISALLOW_PRIVATE_UPSTREAM=1`，阻止代理访问私有地址段，降低 SSRF 风险。
- 服务端代理只允许 `/models`、`/chat/completions`、`/responses`、`/images/generations`、`/openai/image_edit`。
- 后台任务默认使用内存存储；可通过 `JOB_TTL_MS` 和 `MAX_JOBS_PER_STORE` 控制完成任务保留时间和单类任务上限。
- `vendor/` 是前端公开资源，不要放任何密钥。
- API Key 保存在当前浏览器 localStorage；清空站点数据会删除配置与历史。

---

## License

按仓库实际 License 为准。
