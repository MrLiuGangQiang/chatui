(function initChatUISubmitWorkflowHelpers(root) {
  'use strict';

function parseContextValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' ? value : null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function previewQuoteText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function withPendingQuotePreview(html = '', quoteContextValue = '') {
  if (!quoteContextValue || /class=["'][^"']*sent-quote-preview/.test(String(html || ''))) return String(html || '');
  const quote = parseContextValue(quoteContextValue);
  if (!quote) return String(html || '');
  const label = quote.role === 'assistant' ? 'AI' : '用户';
  const text = previewQuoteText(quote.content || quote.rawText || '追问来源');
  return `<button class="sent-quote-preview pending-clarification-source" type="button" data-quote-context="${escapeHtml(JSON.stringify(quote))}" title="基于这条消息追问"><span class="sent-quote-label">追问 ${escapeHtml(label)}</span><span class="sent-quote-text">${escapeHtml(text)}</span></button>${String(html || '')}`;
}

function isImageUnderstandingChat(promptText = '') {
  return /(图里|图片里|画面|这张图|这张图片|这些图|这些图片|哪张|看图|看一下|看下|看看|看看这个|识别|描述|分析|评价|适合|像什么|是什么|这是什么|这个是什么|有什么|对比|比较|提取文字|提取.*文字|识别文字|文字识别|读文字|读取文字|ocr|OCR|image|picture|photo|describe|analy[sz]e|what.*(in|on).*image)/i.test(String(promptText || ''));
}

function isFileUnderstandingChat(promptText = '') {
  return /(附件|文件|文档|PDF|pdf|表格|Excel|excel|Word|word|TXT|txt|CSV|csv|内容|里面|其中|多少|几个|几条|统计|数量|列举|列出来|邮箱|邮件|地址|包含|有没有|总结|摘要|提取|分析|翻译|解释|改写|整理|读取|读一下|看一下|这个文件|这个文档|这个附件|这是什么|这个是什么|看看这个|看下这个|说说这个|attachment|file|document|summari[sz]e|extract|analy[sz]e|translate)/i.test(String(promptText || ''));
}

function originalImageIndex(item, index) {
  return Number(item?.sourceIndex) || Number(String(item?.imageId || item?.image_id || item?.id || '').match(/_(\d+)$/)?.[1]) || index + 1;
}

function defaultIsImageFile(item) {
  return String(item?.type || item?.file?.type || '').startsWith('image/');
}

function imageAttachmentIndexGuide(list = [], { isImageFile = defaultIsImageFile, originalIndex = originalImageIndex } = {}) {
  const images = (list || []).filter(item => isImageFile(item));
  if (!images.length) return '';
  const rows = images.map((item, index) => ({
    sent: index + 1,
    source: originalIndex(item, index),
    id: item.imageId || item.image_id || item.id || '',
    name: item.name || item.file?.name || '',
  }));
  if (rows.every(row => row.sent === row.source)) return '';
  return [
    '图片引用说明：本轮实际随附的图片可能只是原消息图片的一部分，用户说“第N张”时按原消息里的图片编号理解，不按当前随附图片顺序重新编号。',
    ...rows.map(row => `- 当前随附图片${row.sent} = 原消息第${row.source}张${row.id ? `，image_id=${row.id}` : ''}${row.name ? `，文件名=${row.name}` : ''}`),
    '请按这个编号映射回答用户问题。',
  ].join('\n');
}

const api = Object.freeze({
  parseContextValue,
  escapeHtml,
  previewQuoteText,
  withPendingQuotePreview,
  isImageUnderstandingChat,
  isFileUnderstandingChat,
  originalImageIndex,
  imageAttachmentIndexGuide,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUISubmitWorkflowHelpers = api;
if (root?.window) root.window.ChatUISubmitWorkflowHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
