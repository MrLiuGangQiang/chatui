# 运行期目录

## 公告文件

公告只认一个固定文件名：

```text
announcement.md
```

1. 复制 `_template.md`，保存为 `announcement.md`；
2. 填写 `published_at`、`badge`、`summary`、一级标题和正文；
3. 保存后刷新页面即可，无需发版或重启。

说明：

- 其他 Markdown 文件名不会被读取。
- 修改 `announcement.md` 内容会重新触发未读/强制阅读。
- 文件缺失、标题为空或正文为空时显示“暂无公告”，不影响聊天和生图。

## 推荐模型配置

直接编辑 `model-recommendation.json`：

```json
{
  "route_model": "gpt-6-astra",
  "chat_model": "gpt-6-astra",
  "image_model": "gpt-image-2",
  "note": "处理文档、联网搜索请使用 GPT 系列。"
}
```

保存后刷新页面，公告侧栏和新会话欢迎页会使用新推荐值。文件缺失或格式错误时继续使用内置推荐值。

Docker 部署建议把包含这两个文件的宿主机目录只读挂载到 `/app/data/announcements`。
