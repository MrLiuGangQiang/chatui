# ChatUI v1.3.80

相对上一正式版本 **v1.3.79**，本版本重构了会话消息与本地持久化链路，统一以 canonical message 作为已完成消息的数据源，并补齐会话删除时的任务、快照和图片资源回收。同时修复单张上传图片被重复写入 IndexedDB 三次的问题。

## 新增

- 新增 IndexedDB 会话快照库 `openapi-chat-session-db-v2`，完整保存 canonical messages、待恢复任务和最近生成图片，降低 localStorage 容量限制对长会话的影响。
- 新增 canonical message schema 与 presentation 描述，统一表达文本、用户附件和图片结果，并支持从旧版 `messages + display` 数据自动迁移。
- 新增会话资源生命周期管理：删除单个会话或清空全部会话时，会同步清理本地快照、任务状态、对象 URL 和不再被其他会话引用的图片 Blob。
- 新增聊天与图片任务的 `DELETE /api/chat-jobs/:id`、`DELETE /api/image-jobs/:id` 回收接口，用于会话删除后释放服务端任务和订阅资源。

## 删除

- 删除已完成消息在 `display` 中的第二份持久化副本；`display` 现在只保存仍在执行或可恢复的 pending 项，已完成内容统一来自 canonical messages。
- 删除 localStorage 写入超限时自动截断或清空会话历史的降级行为，避免因配额不足造成不可逆的数据丢失。

## 修改

- 会话读取、写入和刷新改为基于独立的快照修订时间，只有更新的 IndexedDB 快照才能覆盖当前内存状态，避免旧元数据遮蔽新消息。
- 历史消息渲染优先根据 canonical presentation 中的附件和图片描述重建界面；旧 HTML 仅作为兼容后备，提升刷新和迁移后的媒体恢复一致性。
- 本地持久化会过滤 `data:`、`blob:` 和已省略的临时媒体地址，只保留可恢复的持久引用。
- 会话删除改为先立即完成本地状态切换，再异步回收远端任务与图片资源，避免网络清理阻塞用户操作。
- 单张上传图片首次落库后会把同一个 `indexeddb://` 引用回写到附件对象，预览、`imageContext` 与 `attachmentContext` 共享一份 Blob。

## 修复

- 修复 localStorage 配额不足时完整会话历史被截断、清空或只保留尾部消息的问题。
- 修复 pending display 快照覆盖 canonical messages，导致刷新后消息缺失、重复或富媒体退化的问题。
- 修复较晚完成的快照写入在会话已删除后重新创建该会话记录的问题；删除墓碑会阻止排队中的旧写入复活数据。
- 修复删除会话后运行中的 Job、SSE 订阅、恢复标记、对象 URL 和图片缓存未被完整释放的问题。
- 修复旧版图片结果或附件消息迁移时错误选择纯文本展示项，导致图片、附件预览或下载入口丢失的问题。
- 修复单张上传图片分别被预览、`imageContext` 和 `attachmentContext` 写入三次的问题；新发送的一张图片现在只新增一个 IndexedDB Blob 对象。
- 修复恢复附件或断点续传时丢失既有持久图片引用、再次写入相同图片的问题。

## 兼容性说明

- 旧版本地会话会在读取时自动迁移到新的 canonical message 结构，无需手动转换。
- 已经由旧版本生成的重复图片对象不会自动合并；清理旧缓存后，新上传图片会按单 Blob 多引用方式保存。
- 服务端 CORS 预检允许方法新增 `DELETE`，以支持任务资源回收接口。

## 验证

- `npm test`
- `git diff --check`
- 单图片持久化回归验证：一次上传只调用一次 Blob 写入，预览、图片上下文和附件上下文指向同一个 `indexeddb://` 地址。