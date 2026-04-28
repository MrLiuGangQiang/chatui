# 极简聊天工具 ChatUI

一个轻量、零前端构建、可直接部署的 OpenAI 兼容接口聊天与生图 Web 工具。

项目面向需要快速接入第三方大模型网关、私有 OpenAI 兼容服务、聚合 API 或本地代理服务的场景。前端直接使用浏览器能力完成聊天、生图、附件、缓存和预览；后端只提供静态文件服务与可选的安全代理能力。

---

## 目录

- [功能特性](#功能特性)
- [界面与交互](#界面与交互)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [配置说明](#配置说明)
- [模型与接口要求](#模型与接口要求)
- [附件能力](#附件能力)
- [图片生成与图片编辑](#图片生成与图片编辑)
- [数据存储与隐私](#数据存储与隐私)
- [发布与 Docker Hub 自动构建](#发布与-docker-hub-自动构建)
- [常见问题](#常见问题)
- [开发说明](#开发说明)
- [安全建议](#安全建议)

---

## 功能特性

### 聊天能力

- 支持 OpenAI Chat Completions 兼容接口。
- 支持流式输出，回复可以边生成边展示。
- 支持 Markdown 渲染，包括：
  - 标题
  - 列表
  - 引用
  - 代码块
  - 表格
  - 行内代码
- 代码块内置复制按钮。
- 普通消息支持复制。
- 用户消息支持编辑后重新发送。
- 回复完成后播放轻量提示音。
- 支持思考内容展示，兼容部分模型返回的字段：
  - `reasoning_content`
  - `reasoning`
  - `thinking`

### 生图能力

- 支持 OpenAI 兼容图片接口。
- 支持文本生成图片。
- 支持带图片附件的图片编辑 / 改图。
- 支持基于上一张生成图继续编辑。
- 支持图片预览。
- 支持图片下载。
- 图片生成 / 编辑完成后播放轻量提示音。
- 支持图片结果本地持久化，刷新页面后仍可恢复历史图片。
- 支持图片尺寸选择：
  - `auto`
  - `1024x1024`
  - `1024x1536`
  - `1536x1024`

### 自动意图识别

- 自动模式下不使用本地关键词匹配，避免正则误判。
- 每次发送后都会调用已配置的聊天模型做轻量路由分类，只要求模型基于用户真实意图返回 `chat` 或 `image`。
- 路由提示词保持中立，不通过固定业务关键词硬编码判断，避免对用户输入添油加醋。
- 只有模型严格返回 `image` 时才进入生图 / 改图流程。
- 如果没有配置聊天模型，或路由模型请求失败，则兜底按聊天任务处理。
- 如果希望完全跳过自动判断，可以手动切换聊天 / 生图模式。
- 上传非图片附件时，仍会作为聊天上下文处理。

### 附件能力

- 支持多附件上传。
- 支持图片作为多模态输入。
- 支持常见文本 / 代码文件解析为上下文。
- 不支持解析的文件会在消息中标注，避免误以为模型已读取正文。

### 本地缓存

- 接口配置保存到浏览器 `localStorage`。
- 聊天历史保存到浏览器 `localStorage`。
- 生成图片保存到浏览器 `IndexedDB`。
- 无需数据库。

### 部署能力

- 只依赖 Node.js 运行静态服务和代理。
- 无需 npm install。
- 无需前端打包。
- 支持 Docker 单容器部署。
- 使用多阶段极简 Docker 镜像，最终镜像只保留运行所需的 Node.js runtime 和静态文件。
- 支持 GitHub Release 发布后自动构建并推送 Docker Hub 多架构镜像。

---

## 界面与交互

- 顶部工具栏：
  - 当前模式 / 标题显示。
  - 接口配置按钮。
  - 清空对话按钮。
- 输入区：
  - `Enter` 发送。
  - `Shift + Enter` 换行。
  - 附件按钮支持多文件上传。
- 消息区：
  - 左右气泡式聊天布局。
  - 用户消息可编辑重发。
  - 助手消息可复制。
  - 图片结果提供预览、下载、打开原图等操作。
- 移动端：
  - 支持小屏布局。
  - 输入区和顶部栏适配移动端。

---

## 技术栈

- 前端：原生 HTML / CSS / JavaScript。
- 后端：Node.js 原生 `http` 模块。
- 存储：浏览器 `localStorage` + `IndexedDB`。
- 容器：Docker。
- CI/CD：GitHub Actions。
- 镜像发布：Docker Hub。

项目没有引入前端框架和构建工具，适合快速审查、二次开发和轻量部署。

---

## 目录结构

```text
.
├── app.js                         # 前端主要逻辑：聊天、生图、附件、缓存、渲染
├── index.html                     # 页面结构
├── styles.css                     # 页面样式
├── server.js                      # 静态文件服务和可选接口代理
├── Dockerfile                     # Docker 镜像定义
├── .dockerignore                  # Docker 构建忽略文件
├── .github/workflows/dockerhub.yml# Release 后构建并推送 Docker Hub
└── README.md                      # 项目说明
```

---

## 环境要求

### 本地运行

需要：

```text
Node.js 18+
```

推荐：

```text
Node.js 20+
```

原因：服务端代理使用了 Node.js 内置 `fetch`，较新的 Node.js 版本兼容性更好。

### Docker 运行

需要：

```text
Docker 20+
```

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/MrLiuGangQiang/chatui.git
cd chatui
```

### 2. 本地启动

```bash
node server.js
```

启动后访问：

```text
http://127.0.0.1:8765
```

局域网访问：

```text
http://<服务器IP>:8765
```

服务默认监听：

```text
HOST=0.0.0.0
PORT=8765
```

### 3. 页面配置接口

打开页面后点击右上角“接口配置”，填写：

```text
Endpoint Base URL
API Key
聊天模型
生图模型
图片尺寸
```

默认接口地址为空，需要你手动填写自己的 OpenAI 兼容接口地址。

常见示例：

```text
https://api.openai.com/v1
https://your-gateway.example.com/v1
http://127.0.0.1:8000/v1
```

然后点击“加载模型”，选择聊天模型和生图模型，保存即可使用。

---

## Docker 部署

### 方式一：使用 Docker Hub 镜像

发布正式版本后，可直接运行 Docker Hub 镜像：

```bash
docker run --rm -p 8765:8765 liugangqiang/chatui:latest
```

指定版本运行：

```bash
docker run --rm -p 8765:8765 liugangqiang/chatui:v1.0.0
```

访问：

```text
http://127.0.0.1:8765
```

### 方式二：本地构建镜像

```bash
docker build -t chatui:local .
docker run --rm -p 8765:8765 chatui:local
```

Dockerfile 使用多阶段极简构建，最终镜像不包含 npm、corepack、README、GitHub workflow 等运行时不需要的内容。

### 方式三：后台运行

```bash
docker run -d \
  --name chatui \
  --restart unless-stopped \
  -p 8765:8765 \
  liugangqiang/chatui:latest
```

查看日志：

```bash
docker logs -f chatui
```

停止容器：

```bash
docker stop chatui
```

删除容器：

```bash
docker rm chatui
```

### Docker 环境变量

容器支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `8765` | 服务监听端口 |
| `MAX_BODY_BYTES` | `52428800` | 代理请求最大 body，默认 50MB |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游接口超时时间，默认 120 秒 |

示例：

```bash
docker run -d \
  --name chatui \
  -p 9000:9000 \
  -e PORT=9000 \
  -e UPSTREAM_TIMEOUT_MS=180000 \
  liugangqiang/chatui:latest
```

---

## 配置说明

页面配置保存在当前浏览器中，不会写入服务器文件。

### Endpoint Base URL

填写 OpenAI 兼容接口的基础地址。

示例：

```text
https://api.openai.com/v1
https://your-gateway.example.com/v1
http://127.0.0.1:8000/v1
```

注意：末尾是否带 `/` 都可以，程序会自动归一化。

### API Key

填写接口密钥。请求时会以 Bearer Token 方式传递：

```http
Authorization: Bearer <API_KEY>
```

### 聊天模型

用于聊天接口：

```text
POST /chat/completions
```

页面会从 `/models` 返回中读取模型列表。

### 生图模型

用于图片接口：

```text
POST /images/generations
POST /images/edits
```

### 图片尺寸

可选值：

```text
auto
1024x1024
1024x1536
1536x1024
```

不同供应商对尺寸支持不完全一致，如果接口报错，请换成供应商支持的尺寸。

### 直连模式

配置项：

```text
直接从浏览器请求接口
```

开启后：

- 浏览器直接请求 `Endpoint Base URL`。
- 适合上游接口已正确配置 CORS 的情况。
- 带附件改图时需要使用直连模式。

关闭后：

- 请求会经过本项目 `server.js` 的 `/api/*` 代理。
- 适合上游接口没有开放浏览器跨域的情况。
- 代理只允许以下路径：
  - `/models`
  - `/chat/completions`
  - `/images/generations`
  - `/images/edits`

---

## 模型与接口要求

本项目按 OpenAI 兼容协议调用接口。

### 模型列表

```http
GET /models
```

兼容返回：

```json
{
  "data": [
    { "id": "gpt-4o-mini" },
    { "id": "gpt-image-1" }
  ]
}
```

也兼容简单数组形式：

```json
[
  "gpt-4o-mini",
  "gpt-image-1"
]
```

### 聊天接口

```http
POST /chat/completions
```

请求大致结构：

```json
{
  "model": "你的聊天模型",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": true
}
```

支持普通 JSON 返回，也支持 SSE 流式返回。

### 图片生成接口

```http
POST /images/generations
```

请求大致结构：

```json
{
  "model": "你的生图模型",
  "prompt": "一只橘猫坐在窗边",
  "size": "1024x1024"
}
```

兼容返回字段：

```json
{
  "data": [
    { "url": "https://example.com/image.png" }
  ]
}
```

或：

```json
{
  "data": [
    { "b64_json": "..." }
  ]
}
```

### 图片编辑接口

```http
POST /images/edits
```

带图片附件时会使用 `multipart/form-data` 上传图片和 prompt。

---

## 附件能力

### 支持图片

常见图片格式：

```text
png
jpg
jpeg
webp
gif
svg
```

图片附件在聊天中会作为多模态 `image_url` 内容传给聊天模型；在改图场景中会作为图片编辑输入。

### 支持文本 / 代码文件

常见可解析格式：

```text
txt
md
markdown
json
csv
xml
yaml
yml
js
ts
jsx
tsx
html
css
py
java
go
rs
php
sql
log
conf
ini
env
sh
bash
zsh
toml
lock
```

这些文件会读取为文本，并附加到用户消息上下文中。

### Office / PDF 文件

页面会识别：

```text
pdf
doc
docx
xls
xlsx
ppt
pptx
```

当前版本不会解析这些文件正文，只会提示“暂不支持解析”，避免错误地让用户以为模型已经读取文件内容。

---

## 图片生成与图片编辑

### 文本生图

输入类似：

```text
画一张赛博朋克风格的城市夜景
```

系统会自动识别为生图任务，并调用图片生成接口。

### 基于上一张图继续修改

生成图片后，可以继续输入：

```text
把上一张图改成雨夜氛围
```

或：

```text
让这张图背景换成雪山
```

系统会尝试把上一张生成图作为图片编辑输入。

### 上传图片改图

点击附件按钮上传图片，然后输入：

```text
把这张图改成水彩风格
```

系统会调用图片编辑接口。

### 下载图片

图片生成完成后，图片消息右上角会提供下载按钮。

---

## 数据存储与隐私

本项目默认不需要后端数据库。

浏览器本地保存：

| 数据 | 存储位置 |
| --- | --- |
| 接口地址、API Key、模型选择 | `localStorage` |
| 聊天历史 | `localStorage` |
| 生成图片 Blob | `IndexedDB` |

注意：

- API Key 保存在当前浏览器本地。
- 如果在公共电脑上使用，请及时清空浏览器数据。
- 如果关闭直连模式，API Key 会经过本项目 Node.js 代理转发给上游接口。
- 项目不会主动上传配置到其他服务。

---

## 发布与 Docker Hub 自动构建

### 当前发布规则

只有发布 GitHub Release 才会触发 Docker Hub 镜像构建。

以下行为不会触发 Docker 构建：

- 普通 push 到 `main`
- 仅 push tag
- 手动 workflow_dispatch

### 版本号规范

Release tag 必须符合：

```text
vMAJOR.MINOR.PATCH
```

示例：

```text
v1.0.0
v1.2.3
v2.0.0
```

不符合规范的 Release 会让 workflow 失败，并提示版本号格式错误。

### GitHub Secrets

需要在 GitHub 仓库中配置：

```text
Settings → Secrets and variables → Actions → Repository secrets
```

新增：

| Secret 名称 | 说明 |
| --- | --- |
| `DOCKERHUB_TOKEN` | Docker Hub Personal Access Token。Docker Hub 用户名已固定为 `liugangqiang` |

Docker Hub Token 建议权限：

```text
Read & Write
```

### 发布流程

推荐流程：

```bash
# 1. 确保 main 分支代码已提交并推送
git checkout main
git pull origin main

# 2. 创建版本 tag
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1

# 3. 在 GitHub 页面基于该 tag 创建 Release
# GitHub → Releases → Draft a new release → Choose a tag → Publish release
```

发布 Release 后，GitHub Actions 会自动构建并推送 Docker Hub。

### 镜像标签规范

发布 `v1.2.3` 后，会推送以下标签：

```text
liugangqiang/chatui:v1.2.3
liugangqiang/chatui:1.2.3
liugangqiang/chatui:1.2
liugangqiang/chatui:latest
liugangqiang/chatui:sha-<commit>
```

### 为什么只用 Release 触发

这样可以避免同一个版本因为“push tag”和“publish release”触发两次构建，保证一次正式发布对应一次 Docker 构建。

---

## 常见问题

### 1. 点击“加载模型”失败

可能原因：

- Endpoint Base URL 填错。
- API Key 无效。
- 上游接口不支持 `/models`。
- 浏览器直连时上游接口没有配置 CORS。

处理方式：

- 检查 Base URL 是否类似 `https://xxx/v1`。
- 确认 API Key 是否可用。
- 尝试关闭“直接从浏览器请求接口”，改走本地代理。

### 2. 聊天请求跨域失败

如果浏览器控制台出现 CORS 错误，可以关闭直连模式。

关闭后请求会走：

```text
/api/chat/completions
```

由 `server.js` 转发给上游接口。

### 3. 图片生成成功但图片打不开

可能原因：

- 上游返回的图片 URL 需要鉴权。
- 图片 URL 与接口 Base URL 不同源，代理拒绝下载。
- 浏览器无法访问上游图片地址。

建议：

- 优先使用返回 `b64_json` 的图片接口。
- 或开启直连模式，让浏览器直接访问图片。

### 4. 上传图片改图失败

当前版本的附件改图需要直连模式。

请确认：

- 已开启“直接从浏览器请求接口”。
- 上游接口支持 `/images/edits`。
- 上游接口支持 `multipart/form-data`。

### 5. 为什么 Office / PDF 上传后没有正文

当前版本只解析文本和代码类文件。PDF、Word、Excel、PPT 暂不解析正文，只作为附件提示显示。

### 6. Docker 容器启动后访问不了

检查：

```bash
docker ps
docker logs chatui
```

确认端口映射是否正确：

```bash
-p 8765:8765
```

如果改了 `PORT`，宿主机映射也要对应修改。

### 7. Release 发布后 Docker 构建失败

重点检查：

- Release tag 是否符合 `v1.2.3` 格式。
- GitHub Secret 是否存在：`DOCKERHUB_TOKEN`
- Docker Hub Token 是否有写入权限。
- Docker Hub Token 是否属于 `liugangqiang` 账号或具备该 namespace 的写入权限。

---

## 开发说明

### 本地语法检查

```bash
node --check server.js
node --check app.js
```

### 启动开发服务

```bash
node server.js
```

### 修改前端

直接编辑：

```text
index.html
styles.css
app.js
```

刷新浏览器即可看到效果。

### 修改服务端代理

编辑：

```text
server.js
```

重启服务：

```bash
node server.js
```

### 构建 Docker 镜像

```bash
docker build -t chatui:dev .
```

---

## 安全建议

- 不要把真实 API Key 写进代码仓库。
- 不要把 `.env`、本地配置、密钥文件加入镜像或 Git。
- 在公共环境使用后，记得清空浏览器缓存和 localStorage。
- GitHub Token、Docker Hub Token 泄露后应立即撤销并重新生成。
- 如果部署到公网，建议放在 HTTPS 反向代理后面，并限制访问范围。

---

## License

当前仓库未声明开源许可证。如需对外开源或商用分发，请先补充 LICENSE 文件。
