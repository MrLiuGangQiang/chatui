# 极简聊天

一个支持 OpenAI 兼容接口的极简聊天网页，支持：

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
