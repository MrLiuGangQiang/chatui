# 极简聊天工具

一个可配置兼容 OpenAPI 的第三方供应商、支持聊天和生图的极简网页工具，支持：

- 自动识别聊天 / 生图 / 改图意图
- 聊天流式输出
- Markdown 渲染与代码复制
- 图片生成、预览、下载、基于上一张图继续编辑
- 附件上传：图片、多种文本/代码文件
- 本地缓存配置、会话、图片结果
- 移动端适配

## 本地启动

```bash
node server.js
```

访问：

```text
http://127.0.0.1:8765
```

局域网访问使用本机 IP：

```text
http://<your-ip>:8765
```

## 说明

默认接口地址：

```text
https://ai.biseecloud.com/v1
```

配置保存在浏览器 localStorage；生成图片缓存使用 IndexedDB。

## Docker

本项目可直接构建 Docker 镜像：

```bash
docker build -t chatui:local .
docker run --rm -p 8765:8765 chatui:local
```

访问：

```text
http://127.0.0.1:8765
```

## GitHub Actions 自动推送 Docker Hub

仓库已包含 `.github/workflows/dockerhub.yml`。推送到 `main` 分支或推送 `v*.*.*` tag 后，会自动构建并推送 Docker 镜像到 Docker Hub。

需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名
- `DOCKERHUB_TOKEN`：Docker Hub Access Token

默认镜像名：

```text
<DOCKERHUB_USERNAME>/chatui:latest
<DOCKERHUB_USERNAME>/chatui:sha-<commit>
```
