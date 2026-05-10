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

## 最新能力

- 支持完整 GFM Markdown 渲染。
- 支持 KaTeX 数学公式渲染。
- 支持代码块右上角图标复制按钮，复制成功后显示打勾图标。
- 支持模型配置弹窗，按模型 `type` 自动区分聊天模型和生图模型。
- 支持未知类型模型标记：模型接口没有返回 `type` 或 `type` 为空时，聊天模型和生图模型均可选择，并显示红色 `未知类型`。
- 支持本地 `vendor` 资源：`marked`、`KaTeX`、KaTeX 字体都已随项目提交，线上不依赖 CDN。
- 支持思考内容持久展示，默认开启。
- 支持发送与重新生成时的即时动效反馈。
- 支持图片生成、图片编辑、基于上一张图片继续修改。

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

使用本地 `marked` 渲染 Markdown，支持常见 GFM 语法：

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

### 使用 Docker Hub 镜像

如果已经发布 Docker Hub 镜像，可直接拉取运行：

```bash
docker pull liugangqiang/chatui:latest
docker run -d --name chatui -p 8765:8765 liugangqiang/chatui:latest
```

### 使用阿里云 ACR 镜像

项目 Release 发布后也会同步推送阿里云容器镜像服务 ACR。镜像地址由仓库的 GitHub Actions Secrets 配置：

```text
registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui
```

常用标签与 Docker Hub 保持一致：

```text
latest
vMAJOR.MINOR.PATCH
MAJOR.MINOR.PATCH
MAJOR.MINOR
sha-<commit>
```

拉取和运行示例：

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
docker run -d --name chatui -p 8765:8765 registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui:latest
```

实际阿里云 ACR 镜像地址：`registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui`。

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
vendor/marked.min.js
vendor/katex.min.js
vendor/katex.min.css
vendor/fonts/*
```

部署时必须确保 `vendor/` 目录被包含，否则线上会出现：

- `marked.min.js 404`
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
├── server.js                      # 静态文件服务与代理
├── vendor/                        # 本地第三方前端资源
│   ├── marked.min.js              # Markdown 渲染
│   ├── katex.min.js               # 数学公式渲染
│   ├── katex.min.css              # KaTeX 样式
│   └── fonts/                     # KaTeX 字体
├── Dockerfile                     # Docker 镜像定义
├── .dockerignore                  # Docker 构建忽略文件
├── .github/workflows/dockerhub.yml# Release 后构建并推送 Docker Hub / 阿里云 ACR
└── README.md                      # 项目说明
```

---

## 开发与验证

### 语法检查

```bash
node --check app.js
node --check server.js
```

### 启动检查

```bash
node server.js
curl -fsS http://127.0.0.1:8765
```

### 检查 vendor 资源

```bash
curl -I http://127.0.0.1:8765/vendor/marked.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.js
curl -I http://127.0.0.1:8765/vendor/katex.min.css
```

期望：

- JS 返回 `Content-Type: application/javascript`
- CSS 返回 `Content-Type: text/css`
- 状态码为 `200`

---

## 发布与镜像仓库

项目通过 GitHub Release 触发 GitHub Actions 构建 Docker 镜像，并推送到 Docker Hub 与阿里云 ACR。

发版建议：

1. 确认功能已验证。
2. 确认新增文件已纳入 Git，特别是 `vendor/`。
3. 提交并推送 `main`。
4. 创建版本 tag，例如 `v1.0.21`。
5. 创建 GitHub Release。
6. 等待 GitHub Actions 完成 Docker 镜像构建，并确认 Docker Hub 与阿里云 ACR 均已推送成功。

正式 Release Notes 应包含：

- 新增
- 删除
- 修改
- 修复

并说明相对上一个正式版本的变化。

镜像发布目标：

- Docker Hub：`liugangqiang/chatui`
- 阿里云 ACR：`registry.cn-hangzhou.aliyuncs.com/liugangqiang/chatui`

阿里云 ACR 发布依赖以下 GitHub Actions Secrets：

- `ACR_REGISTRY`
- `ACR_NAMESPACE`
- `ACR_USERNAME`
- `ACR_PASSWORD`

---

## 常见问题

### 页面提示 marked.min.js 或 katex.min.js 404

说明部署产物中缺少 `vendor/` 目录。

处理：

- 确认 `vendor/marked.min.js` 存在。
- 确认 `vendor/katex.min.js` 存在。
- 确认 `vendor/katex.min.css` 存在。
- 确认 `vendor/fonts/` 存在。
- 重新构建并部署。

### 控制台提示 MIME type 不支持

通常是请求的 JS/CSS 文件返回了 404 HTML 或空内容。

处理：

```bash
curl -I http://your-host/vendor/marked.min.js
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
- `vendor/` 是前端公开资源，不要放任何密钥。

---

## License

按仓库实际 License 为准。
