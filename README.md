# ChatUI 极简聊天与生图工具

ChatUI 是一个轻量、可直接部署的 OpenAI 兼容 Web 工具。它以单页前端 + Node.js 本地代理为核心，支持聊天、流式输出、思考内容展示、文本生图、图片编辑、多附件原生输入、Markdown/数学公式/Mermaid 渲染、会话管理、任务恢复、本地图片缓存、使用统计排行榜和 Docker 镜像发布。

项目定位：用尽量少的依赖快速接入第三方大模型网关、私有 OpenAI 兼容服务、聚合 API 或本地模型代理。

---

## 目录

- [功能总览](#功能总览)
- [界面与交互](#界面与交互)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [模型配置](#模型配置)
- [聊天能力](#聊天能力)
- [联网搜索](#联网搜索)
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
- 支持通过 Responses API 内置 `web_search` 工具联网搜索，并在回答末尾汇总去重后的来源链接。

### 自动路由

- 自动判断当前输入应走：
  - `chat`：普通聊天。
  - `web_search`：需要联网查询实时或最新信息。
  - `image`：文本生成图片。
  - `edit_image`：编辑一个明确目标图，可同时使用内容参考图、风格参考图和 mask。
- 可配置独立路由模型；未配置时使用聊天模型。实时模型只输出最小、非执行性的六字段 `route_intent.v3`：`operation`、`relation`、`goal`、`goal_mode`、`resource_refs`、`task_shape`。`relation` 按本轮主要言语行为描述与前序执行的关系：询问、评价、纠正既有结果或改变后续结果共用要求属于 `followup`，沿用共同要求追加执行或结果属于 `continuation`；`goal_mode=replace|amend` 只描述图片文字任务是完整替换还是增量修订，`resource_refs` 只描述本轮实际绑定的图片、文件和消息。三者相互独立，执行请求中的资源使用/排除约束不会反推 `relation`，因此“继续讨论但完整重做且不使用旧图”可以稳定表示为 `followup + replace + []`。`goal` 只消解指代并保留用户已经提出的约束，不得增加未要求的主体、场景、风格、构图或颜色。
- 意图/图片提示词集中在 `route-prompts.js`，其中理解节点与路由节点使用各自独立的系统提示词（`intent_understanding.v1` / `route_intent.v3`），旧单次巨无霸提示词不再发送；理解证据存在时路由节点使用精简版提示词（≤2500 字符，`dependency` 仅作 relation 候选并按关系规则复核）；简单路径使用独立精简版提示词；仅理解失败或动作为空时回退完整版单跑；主模型与 fallback 模型共用同一确定性校验与定向修复；强事实归一化在 `route-semantic-normalizer.js`；历史图片检索在 `route-memory-retrieval.js`；canonical 候选目录在 `route-candidates.js`；binding role、clarification slot 和 canonical resource 投影在 `route-resource-binding.js`；`route-service.js` 继续负责编排、上下文、模型解析和执行合同编译。 路由提示词把对话理解放在规则之前，按从近到远建立优先级：当前输入与附件 > 引用（显式锚定，执行只带引用上下文）> 最近话题（`text` 时无图片词汇的模糊指代跟随最近文字话题，不因历史图片候选判成图片任务）> 上一轮执行 > 更早历史（仅明确指代可用）；`quoted` 与当前附件在意图层区分，组合请求在 goal 保留全部动作。
- 图片文字任务以严格的 `task_continuity.v1` 持久化：`replace` 建立新的完整基础任务，`amend` 必须基于有效前序状态按顺序追加修订，后者优先；是否使用旧图只由 `resource_refs` 决定。批量结果使用 `image_task_lineage.v1` 为每个子任务分别保存 `reference_id`、图片 ID 和任务状态，不把异构批次的最后一个子任务伪装成整个批次的前序任务。显式损坏的任务状态会失败关闭，不会回退到旧文本猜测。
- `task_shape=multi` 表示需要多个独立执行。 非图片/跨 operation 的多个任务会通过 `multi_task_plan.v1` 拆成独立任务并澄清，用户一次只选择一个执行。所有图片类 `multi` 路由只生成二级 `image_plan.v1` 规划 envelope，父路由没有 `dispatch_contract` 或执行授权；只有规划后的每个子路由可获得独立执行合同。非图片或跨 API 的 `multi` 只标记需要拆分并阻止发送。旧五字段 v2 与四字段 v1 只允许通过显式历史数据适配器迁移，实时解析器不会静默补默认值。图片、文件和历史消息统一使用 `iN`、`fN`、`mN` 候选键；模型不能填写版本字段、API、最终参数、上下文策略、幂等键或规范资源 ID，应用仅校验协议与资源并生成不可变的 `dispatch_contract.v1`，它仍是唯一执行授权。
- 路由只读取文字上下文、附件元数据和图片引用元数据，不把图片二进制、base64 或附件正文发给路由模型。
- 路由会携带当前消息之前、在受控路由窗口内能够容纳的文字历史，并排除正在发送的当前消息。`client/core/image-route-context.js` 的 `route_context_policy.v1` 是唯一裁剪策略：按完整旧轮次淘汰普通历史，不生成合成摘要，不截断当前输入或显式引用内容；受保护内容本身超过模型窗口时会在 provider 请求前返回明确错误。
- 历史图片先在本地完整 memory cards 中按结构化位置和语义检索：支持“第八次生成”“倒数第二次生成”“历史第 N 张”“很早之前”等定位；只把有界候选发布为 `iN`，目录被截断时通过 `resource_catalog.v1` 说明总量、发布量和检索策略。
- 意图识别使用单一绝对 60 秒预算，primary、fallback、图片规划、兼容请求和响应校验共享该预算；`route_model_attempt_ledger.v1` 在每次真实 HTTP 请求前计数，澄清续轮继承同一任务账本，最多允许 6 次 provider attempt。点击停止会立即以取消语义结束，不会被误报成超时，也不会在停止后写入澄清或重复完成事件。
- 路由结果分为 `ready`、`business_clarification`、`configuration_error`、`transient_error`、`invalid_model_output` 和 `cancelled`；只有业务澄清可以创建 pending，配置、网络、限流、超时、无效协议和请求次数超限都显示为失败，不伪装成“请补充信息”。401/403/429 及其他 4xx 不会通过切换第二模型放大请求，只有明确的网络/5xx/可重试故障才允许模型 fallback。
- 图片参数分析保留原始 prompt，仅在本地 analysis view 中处理全半角、常见中英文否定和重叠候选；否定后无法唯一确定合法值时会要求澄清，不会强行使用 `auto`，也不会重新提供已明确排除的选项。
- 最终上下文按确定性策略执行：用户显式引用消息时只发送引用上下文；明确独立的新任务不发送历史；其他情况默认发送窗口内完整会话历史。路由模型选出的消息只用于资源绑定与校验，不再缩小最终聊天历史；纯文本、文件/图片问答的最终提示词保持用户原始输入。最终上下文超限时优先丢弃最早消息，不自动插入替代摘要；当前消息和精确引用消息无法容纳时会停止发送并提示缩短内容。
- 非图片附件上传时直接走聊天，通过 Responses API 的 Base64 原生文件输入发送，不进入图片路由。
- 多图场景支持图片组、图片序号、图片 ID 和最近图片引用元数据；目标图与内容/风格参考图使用稳定角色绑定，不依赖候选顺序猜测。澄清回复会重新进入同一语义路由，不使用独立的续问分类器或本地关键词拼接。图片候选以整卡作为选择控件，预览使用独立按钮且不会改变答案；桌面、窄屏和手机分别使用 3/2/1 列布局。

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
- 支持 OpenAI `input_file` 文档类型，包括 PDF、文本/代码、Word、PowerPoint 和表格文件。
- 文件编码为 Data URL，并以 `input_file.file_data` 直接放入 `/v1/responses`；不会请求 `/v1/files`。
- PDF 支持 `auto` / `low` / `high` 页面图像清晰度；非 PDF 不发送 `detail`。
- 原始文档 Blob 缓存到 IndexedDB，编辑或恢复历史消息时重新编码，不把大段 Base64 写入聊天历史。

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

### 公告中心

- 支持独立的版本化公告目录：`docs/announcements/vMAJOR.MINOR.PATCH.md`；
- 最新公告未读时会以强制遮罩展示，遮罩期间不能使用 ChatUI 的其他功能；
- 点击“我已阅读，进入 ChatUI”后，当前及历史公告不会再次自动弹出；
- 新增更高版本公告会自动重置阅读状态；历史公告永久累计，并可在公告中心展开查看。

### 部署与工程能力

- 无前端构建步骤，静态资源直接交付。
- 本地 vendored：`markdown-it`、`KaTeX`、KaTeX 字体、Mermaid。
- Node.js HTTP 服务静态托管前端。
- 服务端代理只允许白名单路径。
- 提供 `linux/amd64` Docker 镜像。
- 推送语义化版本 Git tag 后触发 GitHub Actions 构建镜像。
- 镜像推送到 Docker Hub 和阿里云 ACR。
- 测试覆盖前端 core/services/ui/app、服务端 API、原生附件输入、路由、任务和冒烟流程。

---

## 界面与交互

### 主界面

- 左侧会话栏：会话列表、新建会话、重命名、删除、当前会话条数。
- 收起态会话栏：保留展开、新会话、会话入口、模型配置入口。
- 移动端会话入口：小屏幕下通过浮动按钮打开会话抽屉。
- 消息区：展示用户消息、助手消息、错误消息、图片结果、附件预览。
- 输入区：附件按钮、会话提示词按钮、会话生图样式按钮、会话模型按钮、思考开关、发送/停止按钮。
- 配置弹窗：Endpoint、API Key、模型加载、模型选择、图片尺寸、全局提示词、全局生图样式提示词。

### 输入与发送

- Enter 发送。
- Shift + Enter 换行。
- 中文输入法组合结束后会重新计算输入框高度。
- 文件可通过附件按钮选择，也可直接粘贴。
- 单条文本消息最多 120,000 个字符；粘贴或输入超限内容时会在写入输入框和触发布局计算之前拒绝，建议改为上传文本文件或分段发送。
- 服务端 JSON 请求体按原始字节限制并使用严格 UTF-8 解码；非法 UTF-8 返回 HTTP 400 / `INVALID_UTF8`，不会用替换字符静默改变请求语义。
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
npm ci
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

### DeepSeek 意图识别兼容

当意图模型使用 `deepseek-*` 时，ChatUI 会在路由请求层优先使用 `json_object`，并把 `route_intent.v3` 的 JSON Schema 约束附加到提示中；收到结果后仍由本地严格校验和编译，不改变普通模型的结构化输出路径。若使用 DeepSeek 之外的模型，仍按原有 `json_schema` 优先、失败后兼容降级策略执行。
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

- 名称包含已知聊天、图片或 embedding 关键词时，会按名称推断类型，并显示 `按名称识别`。
- 名称也无法识别时保留为未知类型，同时进入聊天和生图下拉。
- 未知模型后显示红色 `未知类型` 标记。
- 加载状态会显示未知类型数量，例如 `已加载 12 个，3 个未知类型`。

---

## 聊天能力

### 请求链路

聊天、意图识别、图片任务规划、原生文件、多模态问答、后台文本标签、反馈审核、reasoning 和联网搜索等运行时文本模型请求优先调用 `POST /responses`。意图识别和图片任务规划始终先使用一次性非流式 JSON 请求，并显式发送 `stream: false`；代理绝不会将其升级或重试为 SSE。仅当上游 `/responses` 对这类请求精确返回 HTTP 500 且错误信息包含 `empty stream chunks` 时，客户端才会把同一请求转换为 `POST /chat/completions` 再试一次，仍强制 `stream: false`，绝不切换到 SSE；其他错误维持原有失败和模型 fallback 语义。图片生成与编辑仍调用 Images API；代理继续保留 `/chat/completions`，用于已持久化的历史 Chat Job 恢复、兼容调用及这一个受限的路由网关兼容回退。`web_search` 仍只有在不可变执行计划明确授权时才会附加内置工具。

前端会通过本地代理发送，避免浏览器跨域和直连鉴权问题。

### 流式输出

- 默认使用流式输出。
- 支持标准 SSE `data: ...`。
- 支持 `[DONE]` 结束标记。
- Supports parsing OpenAI reasoning deltas (`reasoning_content`, `reasoning`) and Responses API reasoning summary events.
- 如果流式失败，会尝试普通非流式请求兜底。
- Reasoning requests are never silently downgraded: the selected effort is sent unchanged and upstream errors are returned as-is.

### 联网搜索

- 用户明确要求“联网搜索 / 上网查询 / web search”时会直接生成 `web_search` 路由；其他最新、实时类问题可由路由模型判定为 `web_search`。
- 最终请求强制使用 Responses API，并且只允许发送 `tools: [{ "type": "web_search" }]`；普通聊天不能注入该工具。
- ChatUI 复用当前 Endpoint、API Key 和聊天模型，不需要保存独立的第三方搜索服务密钥；这不代表上游模型调用免费，是否支持及如何计费由当前服务商决定。
- 回答完成后会从 Responses URL citation / sources 中提取并去重链接，追加为“来源”列表。
- 当前 Endpoint 或模型不支持内置工具时，会显示明确的兼容性错误，不会静默退化为普通聊天。

### 重新生成与编辑重发

- 助手消息可重新生成。
- 用户消息可编辑后重发。
- 编辑重发会尽量复用原消息位置，并替换对应助手回复。
- 历史恢复时会按 `messageIndex` / `responseIndex` 规范排序，相同索引固定 `system → user → assistant`。

### 停止输出

- 输出中点击发送按钮会执行停止。
- 停止会 abort 当前 run 关联的聊天/图片 Job；仍在并发队列中等待的 Job 会立即退出队列，不会在稍后取得槽位后继续调用上游。
- Job 一旦进入用户停止终态，迟到的成功响应或 AbortError 不会把它改回完成或“上游超时”。
- 如果已有有效内容，会保留已有输出。
- 如果只有占位内容，会显示“用户停止”。

---

## 思考模式

Thinking mode is limited to OpenAI GPT-5 models. When enabled, requests only use the OpenAI `reasoning_effort` parameter, and returned reasoning is displayed above the final answer.

### Supported efforts

| UI value / request value | Meaning |
| --- | --- |
| `low` | Low reasoning effort |
| `medium` | Medium reasoning effort |
| `high` | High reasoning effort |
| `xhigh` | Extra-high reasoning effort |
| `max` | Maximum reasoning effort |

`none` is the internal disabled state and is not shown as a selectable menu item. The legacy `minimal` value is treated as disabled and is never sent upstream.

### Interaction rules

- Reasoning is disabled by default.
- The brain icon toggles reasoning mode.
- The effort menu is disabled while reasoning mode is off.
- The toggle and effort selector are locked while a response is streaming.
- No Claude, Google, Qwen, or generic-provider reasoning compatibility parameters are sent.
- The selected effort is never silently downgraded after an upstream error.

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

常见文本/代码文件会编码为 Base64 Data URL，并作为 Responses API 的 `input_file.file_data` 直接发送。客户端不会另外提取并重复发送文档正文。

### PDF 附件

PDF 通过 OpenAI 原生文件输入处理。支持在附件标签中选择 `auto`、`low` 或 `high`；该参数只影响 PDF 页面图像处理，PDF 文本仍会被提取。包含页面图像的 PDF 理解需要支持视觉输入的模型。

### Office 附件

原生文件输入支持：

| 类型 | 常见扩展名 | 上游处理方式 |
| --- | --- | --- |
| Word / 富文档 | `.doc`, `.docx`, `.rtf`, `.odt` | 提取文本 |
| PowerPoint / 演示文稿 | `.ppt`, `.pptx`, `.pps` 等 | 提取文本 |
| Excel / 表格 | `.xls`, `.xlsx`, `.csv`, `.tsv`, `.iif` 等 | 表格增强；每个 Sheet 最多处理前 1,000 行 |

非 PDF 文件中的嵌入图片和图表不会进入模型视觉上下文；需要保留图表或排版时，请先转换为 PDF。

每个文档必须严格小于 10 MB；同一条 Responses 请求中的全部文档合计也必须严格小于 10 MB。超限文件会在输入区以红色错误提示保留，不会被静默移除。
Base64 编码会使 HTTP JSON 请求体增大约三分之一；使用中转站或反向代理时，应将请求体上限配置为至少 72 MiB。

### 附件上下文规则

- 路由模型只看附件元数据，不读取附件正文。
- 聊天模型通过 Responses API 的 `input_file.file_data` 读取原始文档。
- 图片编辑接口只接收图片附件。
- Base64 只在发送和未完成任务恢复时生成；聊天历史保留 IndexedDB Blob 引用，不持久化完整 Data URL。
- native 文档不会同时以内联文本重复发送。

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
  A[输入] --> B[模型生成 route_intent.v3]
  B --> C[本地校验六项语义与资源]
  C --> D{图片类 multi?}
  D -- 否 --> E[编译唯一 dispatch_contract.v1]
  D -- 是 --> F[image_plan.v1 拆分独立子任务]
  F --> G[逐子任务编译执行合同]
  E --> H[聊天 / 生图 / 修图]
  G --> I[批量执行]
  C --> J[需要补充信息或失败关闭]
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
| 上传文档与上传/生成图片二进制 | `IndexedDB` |
| 未完成 Job 记录 | `localStorage` + `IndexedDB`（大媒体 payload） |

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

使用统计是可选能力，依赖外部 PostgreSQL 数据库中的使用日志表。未配置数据库连接时，前端统计入口仍可打开，但接口会返回不可用状态，核心聊天、生图、图片编辑和附件输入不受影响。

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
- 本地 `npm start` 会自动读取仓库根目录中被 Git 忽略的 `.env.local`；文件只填补当前进程未设置的变量，不覆盖部署平台已经注入的环境变量。
- 推荐生产环境使用单变量连接串，例如：

```bash
POSTGRES_URL='postgres://user:password@postgres-host:5432/database?sslmode=disable'
```

请不要在仓库、镜像或文档中写入真实数据库账号、密码、主机或连接串。

本地开发可在 `.env.local` 中使用分散参数，避免把凭据写进启动命令或受版本控制文件：

```dotenv
PGHOST=postgres-host
PGPORT=5432
PGDATABASE=database
PGUSER=user
PGPASSWORD=password
```

---

## 服务端 API 与代理

### 核心 API

| API | 方法 | 说明 |
| --- | --- | --- |
| `/api/version` | GET | 返回当前应用版本，来自根目录唯一版本源 `version.json` |
| `/api/announcements` | GET | 返回按公告版本倒序排列的累计公告；前端据此判断最新公告是否需要强制阅读 |
| `/api/image` | POST | 同源图片代理下载，用于上游图片 URL 无法直接加载时 |
| `/api/chat-stream-jobs` | POST | 注册/启动聊天流式 Job |
| `/api/usage/overview` | POST | 一次查询排行榜与个人统计，body 包含 `api_key`、`model` 和范围 |
| `/api/usage/rankings` | POST | 查询指定范围排行榜，body 包含 `api_key`、`model` 与 `range` |
| `/api/usage/personal` | POST | 查询指定范围个人统计，body 包含 `api_key`、`model` 与 `range` |
| `/api/usage/department/verify` | POST | 校验部门统计访问，body 包含 `api_key`、`model` 与 `password` |
| `/api/usage/department/summary` | POST | 查询部门汇总，body 包含访问字段与 `range` |
| `/api/usage/department/rankings` | POST | 查询部门排行，body 包含访问字段与 `range` |
| `/api/usage/department/users` | POST | 查询部门人员统计，body 另含 `department_id` |
| `/api/usage/department/export` | POST | 导出部门统计标准 `.xlsx` |
| `/api/usage/feedback` | POST | 审核并提交问题反馈，body 包含 `api_key`、`model`、可选 `route_model` 与 `content`；内容必须包含问题描述、复现描述和期望结果 |

使用统计范围统一支持 `today`、`yesterday`、`week`、`last_week`、`month`、`last_month`、`total`。统计与反馈入口会先通过当前 API Key 和聊天模型向上游执行访问校验；问题反馈还会由该聊天模型审核内容完整性（内容可以简短，只要问题描述、复现描述和期望结果三项都存在，且不是空泛、占位、广告或胡言乱语即可），只有审核通过才会发送；部门接口还需要部门密码。

浏览器检测到未捕获异常、未处理的 Promise 拒绝、API/功能请求网络失败或非 2xx 响应时，会在 5 秒后打开问题反馈窗口。普通图片、样式和可选依赖等资源加载失败不会自动弹出反馈。系统自动把已脱敏的异常信息以及当前会话最近 3 轮用户消息与助手答复填入“复现描述”；即使没有发生异常，主动点击问题反馈也会自动填入最近 3 轮会话上下文。提交前可自行检查、修改或删除。关闭反馈窗口后再次打开会恢复尚未提交的表单草稿；主动停止请求以及反馈接口自身失败不会递归触发反馈窗口。

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

服务端会为首次请求签发 HMAC 校验的匿名浏览器 principal Cookie，并把 Chat/Image Job 所有权绑定到该 principal 与部署级 tenant。查询、SSE、中止、删除、同 Job ID 复用以及流式代理接管都会重新校验所有权；未授权访问与不存在保持相同的公开结果，owner、tenant 和 Cookie 值不会进入 Job 快照、日志或 trace。内置前端是同源请求，会自动携带 Cookie；独立 API 客户端必须保存创建响应中的 `Set-Cookie` 并在后续 Job 请求中回传。

该 principal 提供浏览器配置文件级的匿名任务隔离，不等同于企业账号登录。需要真实用户/组织身份、单点登录或同一进程内多租户时，应在受信任认证边界接入可验证的 JWT/OIDC principal；不得用客户端自报的 session ID、随机 Header、Job ID 或 CORS 代替授权。

### OpenAI 兼容代理

所有 `/api/*` 且不属于内部 API 的请求会走代理白名单。

允许路径：

```text
/models
/chat/completions
/responses
/images/generations
/images/edits
/openai/image_edit
```

`/openai/image_edit` 是本地代理的兼容别名，服务端会将它规范化为上游 `/images/edits`。托管图片 Job 直接使用 `/images/edits`。

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
- 图片上游路径规则：纯文本生图走 `/images/generations` JSON；图片编辑/参考图生成走 `/images/edits` multipart。前端/本地缓存里的 base64 会在服务端转成文件 Blob，按 `image[]` 数组字段上传；多图会重复追加多个 `image[]` 字段。
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

直接运行 `npm start` 时，服务端会先读取根目录 `.env.local`，并且只应用尚未存在于进程环境中的变量。该文件已由 `.gitignore` 排除，仅供本机开发使用；Docker、CI 和生产部署仍应通过运行环境注入配置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `8765` | HTTP 监听端口 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游 API 超时，默认 10 分钟 |
| `CHATUI_UPSTREAM_PROXY` | `not set` | HTTP/HTTPS outbound proxy for public Endpoint requests from the container; takes precedence over `HTTPS_PROXY` / `HTTP_PROXY`, for example `http://host.docker.internal:7890`. Private upstreams bypass this proxy. |
| `HTTPS_PROXY` / `HTTP_PROXY` | `not set` | Fallback outbound proxy settings when `CHATUI_UPSTREAM_PROXY` is empty. On a Linux Docker host, do not use `127.0.0.1` unless the proxy runs inside this container; use a container-reachable host or gateway address. |
| `CHATUI_VERBOSE_LOGS` | `not set` | Set to `1` to emit redacted upstream diagnostics; API keys and image/file Base64 payloads are never logged. |
| `CHATUI_ACCESS_LOG` | `true` | 每个 HTTP 请求写入一条脱敏 access 记录；core、OPTIONS、Job、proxy、static 与异常路径共享同一记录边界。 |
| `CHATUI_ACCESS_LOG_FILE` | `temp/logs/access.ndjson` | access log 路径；相对路径以仓库根目录解析。 |
| `CHATUI_ACCESS_LOG_MAX_BYTES` / `CHATUI_ACCESS_LOG_ROTATIONS` | `20971520` / `3` | access log 单文件上限与轮转数量。 |
| `CHATUI_LOG_QUEUE_MAX` / `CHATUI_LOG_QUEUE_MAX_BYTES` | `2048` / `8388608` | 每个文件日志 writer 的有界异步队列条目数/字节数；队列满时拒绝新记录而不是无限占用内存，各 access/error/server/trace 队列彼此隔离。 |
| `CHATUI_LOG_BATCH_MAX_ITEMS` / `CHATUI_LOG_BATCH_MAX_BYTES` | `64` / `262144` | 单次异步 append 的最大记录数/字节数；轮转和写入都在请求热路径之外串行执行。 |
| `CHATUI_ERROR_LOG` | `true` | 启用结构化错误日志；access log 入队失败或异步写入失败会转交该日志，不改变原 HTTP 响应。 |
| `CHATUI_ERROR_LOG_FILE` | `temp/logs/error.ndjson` | error log 路径；禁止写入凭据或完整敏感请求内容。 |
| `CHATUI_REQUEST_TRACE` | 未设置 | 设为 `1` 后把上游请求与结果异步写入本地脱敏 NDJSON，覆盖路由、续问、聊天、Responses、生图、图片编辑和图片下载链路；managed execution 会记录 `execution.accepted` / `execution.rejected`，客户端在最终请求发出前被上下文绑定校验拦截时也会写入 `source=client_pre_dispatch` 的 `execution.rejected`，同条对照 execution plan、binding evidence、缺失/可用消息资源及校验结果；默认关闭。 |
| `CHATUI_REQUEST_TRACE_FILE` | `temp/request-trace.ndjson` | 请求追踪文件路径；相对路径以仓库根目录解析。默认目录已被 Git 忽略。 |
| `CHATUI_REQUEST_TRACE_MAX_BYTES` | `20971520` | 单个请求追踪文件的轮转上限，默认 20 MiB。 |
| `CHATUI_REQUEST_TRACE_ROTATIONS` | `3` | 保留的历史轮转文件数量。 |
| `CHATUI_REQUEST_TRACE_TEXT` | `1` | 追踪启用后是否保留脱敏且限长的用户输入与模型输出。设为 `0` 时只记录长度和结构摘要。系统提示词和 reasoning 正文始终不落盘。 |
| `CHATUI_CONTEXT_WINDOW_TOKENS` | `262144` | 聊天请求上下文窗口预算，约 256k estimated tokens；超出时优先裁剪最早历史且不自动插入摘要，只影响发给模型的 payload，不删除本地会话记录；当前消息和精确绑定消息若仍超限则拒绝发送 |
| `CHATUI_CONTEXT_SUMMARIZE_OMITTED` | `0` | 设为 `1` 时，超出上下文预算的最早历史会折叠成有界的 `[自动上下文摘要]` 系统提示（而不是直接丢弃），仅影响发给模型的 payload，不修改本地会话记录 |
| `CHATUI_ALLOW_PRIVATE_UPSTREAM` | 未设置 | 默认禁止代理访问私有/内网地址；仅在明确需要访问受信任内网模型网关时设为 `1`，兼容别名为 `ALLOW_PRIVATE_UPSTREAM` |
| `CHATUI_PRINCIPAL_SECRET` | 每个服务进程随机生成 | 匿名 principal Cookie 的 HMAC 密钥；显式配置时至少 32 bytes。不要提交、记录或暴露该值。当前 JobStore 为进程内存，单实例无需持久化；多实例只有在共享同一密钥并配合粘性会话/一致 Job 存储时才有意义。 |
| `CHATUI_TENANT_ID` | `default` | 部署级 tenant 边界，会参与 Cookie 签名和 Job owner 派生；不是客户端可声明的用户/租户字段。不同安全域应使用不同值。 |
| `CHATUI_PRINCIPAL_COOKIE_SECURE` | `auto` | `1` 始终添加 `Secure`，`0` 始终不添加，`auto` 仅在 Node 直连 TLS（或受信任代理报告 HTTPS）时添加。生产 HTTPS 反向代理部署建议显式设为 `1`。 |
| `CHATUI_TRUST_PROXY` | 未设置 | 仅在请求必经受信任反向代理时设为 `1`；此时 Cookie 的 `auto` 模式才读取 `X-Forwarded-Proto`。不要在可直连应用端口时启用。 |
| `CHATUI_PRINCIPAL_COOKIE_MAX_AGE_SECONDS` | `86400` | principal Cookie 生命周期，范围 3600-2678400 秒；应不短于需要恢复的 Job 生命周期。 |
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
| `PGSSL` / `POSTGRES_SSL` | 未设置 | PostgreSQL SSL 开关；可设为 `true` / `require` / `false` |`n| `REDIS_URL` | 未设置 | Redis 连接串，用于多实例共享在线人数统计；例如 `redis://:password@host:6379/0`。未设置时使用单实例内存 presence。 |
| `USAGE_RANKING_LIMIT` | `10` | 使用排行榜每个范围返回数量，非法值回退到 10，最大 100 |
| `USAGE_STATS_RANKING_LIMIT` | 未设置 | 排行榜数量兼容别名 |
| `USAGE_ACCESS_CACHE_TTL_MS` / `USAGE_ACCESS_CACHE_MAX_ENTRIES` | `300000` / `512` | 统计/反馈 API Key+模型访问校验的 TTL 与 LRU 上限；只缓存脱敏结果，不保存原始 Key。 |
| `USAGE_ACCESS_MAX_IN_FLIGHT` / `USAGE_ACCESS_TIMEOUT_MS` | `64` / `10000` | 相同校验请求共享一个上游 `/models` 请求；全局并发上限和单次校验超时。 |
| `MAX_USAGE_REFRESH_BUCKETS` / `USAGE_REFRESH_SWEEP_INTERVAL_MS` | `4096` / `60000` | 统计刷新 IP 限流桶的硬上限与过期 sweep 周期；超过上限淘汰最旧桶。 |
| `USAGE_DEPARTMENT_PASSWORD` | `not set` | Password for department statistics; disabled when unset. |
| `USAGE_STATS_DEPARTMENT_PASSWORD` | `not set` | Compatible alias for the department statistics password. |

Docker proxy example (the proxy URL must be reachable **from inside the container**):

```bash
docker run -d --name chatui --restart unless-stopped -p 8765:8765 \
  -e CHATUI_UPSTREAM_PROXY=http://host.docker.internal:7890 \
  -e CHATUI_VERBOSE_LOGS=1 \
  liugangqiang/chatui:latest
```

If text requests work but image/file chat fails, run `docker logs --tail 200 chatui` after one failed upload. The log records only target host/path, outbound byte size and the underlying network code (such as `ECONNRESET`); it does not include credentials or Base64 data.


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

默认安全策略会阻止私有地址上游。只有确实需要访问受信任的内网模型网关时才显式开启：

```bash
CHATUI_ALLOW_PRIVATE_UPSTREAM=1 node server.js
```

---

## 目录结构

```text
.
├── app.js                         # 浏览器端主业务编排入口
├── index.html                     # 页面结构、模板、配置弹窗、消息模板
├── pages/                         # 弹窗按需加载的独立说明页面
│   ├── route.html                 # 智能任务路由流程图
│   └── files.html                 # 支持的文件格式与上传约束
├── styles.css                     # 全局样式、响应式布局、消息/图片/配置面板样式
├── styles/                        # 按功能拆分的补充样式
├── server.js                      # Node HTTP 启动入口
├── config/                        # 可公开的运行时配置，不得存放密钥
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
│   ├── security/                  # 上游 URL 安全策略
│   ├── services/                  # 服务端用例与外部集成
│   ├── validators/                # API 输入校验
│   ├── logging/                   # 安全日志与脱敏
│   ├── errors/                    # 统一应用错误
│   └── jobs/                      # 聊天任务、图片任务、SSE、abort、内存任务仓库、reasoning
├── shared/                        # 浏览器和服务端都可安全使用的共享逻辑
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
├── .github/workflows/release.yml   # Tag 后优先发布阿里云 ACR，再自动同步 Docker Hub
├── CONTRIBUTING.md                # 开发规范、目录边界和治理约束
├── package.json
├── package-lock.json
├── version.json
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

提交前完整检查：

```bash
npm run check
git diff --check
```

当前测试覆盖：

- `server.js`、`app.js`、前端模块、服务端测试文件语法检查。
- 前端 core：消息、模型、附件、图片引用、路由上下文、reasoning、storage。
- 前端 services：模型、Job、聊天、路由、生图、图片解析。
- 前端 UI：文件动作、实时渲染、滚动、消息渲染、消息操作、图片操作。
- 前端 app：状态、run、会话、持久化、display item、runtime、image store。
- API、Job 生命周期、原生附件输入、路由与 HTTP 服务冒烟。

当前测试以 Node/JSDOM 和 HTTP smoke 为主；真实浏览器 E2E 作为后续增强项。

### 常用单项检查

```bash
npm run check:syntax
node test/run-tests.js
node test/run-tests.js unit/server-hardening.test.js
node test/run-tests.js smoke/server-smoke.test.js
node test/run-tests.js --list
node test/run-tests.js unit/usage --timeout=20000
```

测试文件导出测试函数数组，不能直接执行单个 `*.test.js` 文件；聚焦运行必须通过 `test/run-tests.js`，否则可能以退出码 0 结束但实际执行 0 项。

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

项目在 pull request 和 `main` 推送时运行日常 CI，包括 Node.js 20.19、Node.js 22 的 `npm run check`，以及 `Exact Docker runtime` 容器验证。推送 `vMAJOR.MINOR.PATCH` 格式的正式 Release Git tag 会触发独立的 `linux/amd64` 发布流程：先在阿里云 ACR 构建、验证和提升镜像，再创建 GitHub Release，最后自动同步同一已验证 digest 到 Docker Hub。

### 固定镜像地址

```text
Docker Hub: liugangqiang/chatui
阿里云 ACR: registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui
```

除非明确迁移仓库，否则不要在发版时临时改镜像地址。

### Release 流程

1. 从当前 `origin/main` 准备一个干净候选，运行 `npm run release:prepare`（默认自动递增；经确认的主版本升级可运行 `npm run release:prepare -- 2.0.0`）。该命令按 `a.b.c` 规则更新根目录 `version.json`（默认从 `c=99` 的下一版进位到 `b+1.0`），同步 `package.json`、`package-lock.json` 镜像字段并创建同版本 `docs/releases/vMAJOR.MINOR.PATCH.md`。
2. 运行 `npm run check`；本机有 Docker 时再运行 `npm run preview:release`。
3. 将候选提交推送到 `main`，等待 Node 检查和 `Exact Docker runtime` 全部通过。
4. 在该已验证提交上创建并推送 annotated `vMAJOR.MINOR.PATCH` tag。
5. workflow 构建带提交 SHA 和 runtime source fingerprint 的 ACR 候选镜像，以 digest 启动验证，再把同一 digest 提升为版本、`v` 前缀和 `latest` 标签；验证与提升之间不得重建。
6. 确认 ACR 和 Docker Hub 标签均解析到已验证 digest，容器 `/api/version` 的版本、Git SHA、source fingerprint 一致。
7. 从该版本 Release Notes 创建或确认非 draft GitHub Release；只有镜像 workflow、两个仓库的标签验证与 GitHub Release 都成功后才算发布完成。

### 镜像标签规则

| 标签 | 示例 | 说明 |
| --- | --- | --- |
| `latest` | `liugangqiang/chatui:latest` | 最新正式版本 |
| `MAJOR.MINOR.PATCH` | `liugangqiang/chatui:1.2.3` | 精确版本标签 |
| `vMAJOR.MINOR.PATCH` | `liugangqiang/chatui:v1.2.3` | 与 Git tag 一致的精确版本标签 |

### 公告发布规范

公告与 Release Notes 分开维护。每次发布重要公告时，只新增一个更高版本的文件，不删除历史公告：

```text
docs/announcements/v1.0.0.md
docs/announcements/v1.0.1.md
docs/announcements/v1.0.2.md
```

公告文件可使用以下 front matter：

```markdown
---
published_at: 2026-08-05
badge: 重要公告
summary: 一句话摘要
---
# 公告标题

公告正文支持 Markdown。
```

最新版本未被确认阅读时，客户端会 fail-closed 地显示强制公告遮罩；确认阅读后会记录当前公告版本。新增版本会自动触发下一次强制阅读，历史文件只累计、不删除。

### Release Notes 规范

正式 Release Notes 必须使用正确版本标题并包含实质性的用户说明；可按新增、修改、修复、删除等实际内容分类，不要求制造空章节。Release Notes 不能只复制 commit message。

### 发布前检查

```bash
npm run check
git diff --check
```

本机可用 Docker 时还应运行 `npm run preview:release`；否则必须等待推送提交的 `Exact Docker runtime` 成功后才能打 tag。

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

如果没有 `type`，ChatUI 会先根据模型名称推断聊天、图片或 embedding 类型，并显示 `按名称识别`；名称也无法识别时才标记为 `未知类型`，并同时出现在聊天和生图下拉中。

### 生图失败

检查：

- Endpoint 是否正确。
- 生图模型是否选择正确。
- 模型是否支持 OpenAI 兼容图片接口。
- 图片尺寸是否被该模型支持。
- API Key 是否有生图权限。
- 上游是否支持 `/images/generations` 和 `/images/edits`：纯文本生图走 `/images/generations` JSON；图片编辑/参考图生成走 `/images/edits` multipart，服务端会把 base64 输入转成 `image[]` 文件数组字段。本地兼容代理仍接受 `/openai/image_edit` 并转换为 `/images/edits`。

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

PDF 由上游 Responses API 处理。扫描件、图片型 PDF 需要模型支持视觉输入，并且中转站必须完整支持 `input_file.file_data`。

建议：

- 确认聊天模型支持 PDF/视觉文件输入。
- 确认中转站实现 `/v1/responses` 中的 `input_file.file_data`，且允许 Base64 请求体通过。
- 将扫描件先做 OCR，或导出为可检索 PDF、文本/Markdown 后再上传。

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
- 服务端默认阻止代理访问私有地址段以降低 SSRF 风险；不要在公开部署中设置 `CHATUI_ALLOW_PRIVATE_UPSTREAM=1`。
- 服务端代理只允许 `/models`、`/chat/completions`、`/responses`、`/images/generations`、`/images/edits` 和兼容别名 `/openai/image_edit`。
- 浏览器尝试加载上游返回的公开图片 URL 时不会附带 API Key；需要鉴权的图片统一回退到 `/api/image`，由服务端校验图片 URL 与 Endpoint 同源后再请求。
- Chat/Image Job 已绑定服务端签发、HMAC 校验、`HttpOnly`、`SameSite=Strict` 的匿名 principal Cookie；查询、SSE、中止、删除和 Job ID 复用均按 owner fail-closed，Job ID 本身不是授权凭据。
- 匿名 principal 的安全边界是浏览器配置文件，不是企业用户账号。真正的用户/组织多租户部署仍需受信任 JWT/OIDC/SSO 身份源；不要用客户端 session ID、自报 tenant 或随机 Header 替代。
- HTTPS 反向代理部署应设置 `CHATUI_PRINCIPAL_COOKIE_SECURE=1`；只有代理不可绕过时才设置 `CHATUI_TRUST_PROXY=1`。独立 API 客户端必须保存并回传 principal Cookie。
- 后台任务默认使用内存存储；可通过 `JOB_TTL_MS` 和 `MAX_JOBS_PER_STORE` 控制完成任务保留时间和单类任务上限。
- `vendor/` 是前端公开资源，不要放任何密钥。
- API Key 保存在当前浏览器 localStorage；清空站点数据会删除配置与历史。

---

## License

按仓库实际 License 为准。

---

## Engineering documentation

- [Architecture and module boundaries](docs/architecture.md)
- [Development, checks, and release workflow](docs/development.md)
- [Manual acceptance suite](docs/manual-acceptance-test.md)
- [Contribution guide](CONTRIBUTING.md)
