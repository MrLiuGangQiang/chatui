#!/usr/bin/env node
const assert = require('assert');
const { copySuccessState, copyText, normalizeRenderedCopyText, visibleCopyTextFromElement, messageCopyText } = require('../../client/ui/message-actions');

(async () => {
  assert.deepStrictEqual(copySuccessState('<ok>', '<old>'), { className: 'copied', html: '<ok>', restoreHtml: '<old>', timeoutMs: 2000 });
  assert.strictEqual(normalizeRenderedCopyText('第一行\n\n第二行\n\n第三行'), '第一行\n第二行\n第三行');
  assert.strictEqual(normalizeRenderedCopyText('第一段\n\n第二段\n\n\n第三段'), '第一段\n第二段\n第三段');
  assert.strictEqual(messageCopyText('**原始**\n文本', '原始\n\n文本'), '原始\n文本');
  assert.strictEqual(messageCopyText('原始\n里有换行', '显示没有换行'), '显示没有换行');
  assert.strictEqual(messageCopyText('', '第一行\n\n第二行\n\n第三行'), '第一行\n第二行\n第三行');
  const renderedAnnouncement = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [
      { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: '关于 AI 大模型统一使用的公告' }] },
      { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: '各位好，目前已为每位成员分配了专属 API Key。' }] },
      { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: 'Claude Code：' }] },
      { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: 'API_KEY="你的专属 key"' }] },
      { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: 'BASE_URL="https://ingress.lfans.cn/anthropic"' }] },
    ],
  };
  assert.strictEqual(visibleCopyTextFromElement(renderedAnnouncement), '关于 AI 大模型统一使用的公告\n各位好，目前已为每位成员分配了专属 API Key。\nClaude Code：\nAPI_KEY="你的专属 key"\nBASE_URL="https://ingress.lfans.cn/anthropic"');
  assert.strictEqual(messageCopyText('关于 AI\n\n\n公告', '', renderedAnnouncement), visibleCopyTextFromElement(renderedAnnouncement));
  let copied = '';
  const ok = await copyText('hello', { writeText: async text => { copied = text; } });
  assert.strictEqual(ok, true);
  assert.strictEqual(copied, 'hello');
  const fallbackDoc = {
    body: { appendChild(node) { this.node = node; } },
    createElement() { return { style: {}, setAttribute() {}, focus() { this.focused = true; }, select() { this.selected = true; }, remove() { this.removed = true; } }; },
    execCommand(command) { this.command = command; return command === 'copy'; },
  };
  const fallbackOk = await copyText('fallback', { writeText: async () => { throw new Error('blocked'); } }, fallbackDoc);
  assert.strictEqual(fallbackOk, true);
  assert.strictEqual(fallbackDoc.body.node.value, 'fallback');
  assert.strictEqual(fallbackDoc.body.node.removed, true);
  console.log('message actions ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
