(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = '你是 ChatUI 路由器，只输出 JSON。目标：判断本轮要做什么，并返回执行所需的文件/图片引用。\n\n输出字段：\n{\"mode\":\"chat|image|edit_image\",\"operation\":{\"type\":\"plain_chat|file_qa|image_qa|ocr|text_to_image|image_reference_gen|image_edit\",\"scope\":\"current|quoted|history|none\",\"prompt\":\"\",\"edit_instruction\":\"\"},\"image_refs\":[{\"role\":\"target|reference\",\"image_id\":\"\",\"reference_id\":\"\",\"index\":1,\"target\":\"uploaded|previous\",\"source\":\"current|quoted|history\"}],\"file_refs\":[{\"role\":\"source\",\"file_id\":\"\",\"index\":1,\"name\":\"\",\"source\":\"current|quoted\"}],\"target\":\"none|new|uploaded|previous\",\"use_previous_image\":false,\"selected_reference_id\":\"\",\"selected_indexes\":[],\"selected_image_ids\":[],\"need_clarification\":false,\"clarification_question\":\"\",\"intent\":\"text_to_image|image_edit|image_reference_gen|unknown\",\"edit_instruction\":\"\",\"contextual_image_prompt\":\"\",\"tasks\":[],\"confidence\":0,\"evidence\":\"\"}\n\n规则：\n1. [file id=...] / [image id=...] 只是附件索引，不是正文或图片内容。route 不接收文件正文/图片真实内容，不要编造内容。\n2. 文件只从 attachments/context.file_candidates 选；需要读文件回答时 mode=chat，operation.type=file_qa，填 file_refs。\n3. 图片只从 context.image_candidates 选；问图/OCR 用 mode=chat + image_qa/ocr + image_refs；修图用 mode=edit_image + image_edit + image_refs(role=target)。\n4. 引用场景 scope/source=quoted，只能选引用消息内候选；普通聊天不要选文件/图片。\n5. 生图 mode=image；引用型生图才填 contextual_image_prompt=引用描述+当前请求；普通生图不改写用户原文。\n6. 多图目标不明确要 need_clarification=true；不要输出 size/quality/background/format/n。' ;

const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});

const UPLOADED_IMAGE_ROUTE_PROMPT = '';

function cleanQuotedContent(text = '') {
  return String(text || '')
    .replace(/\[base64 image\]/gi, '')
    .replace(/耗时：[^\n]+/g, '')
    .replace(/RT\s+[^\n]+/gi, '')
    .replace(/TTFT\s+[^\n]+/gi, '')
    .replace(/^\[图片(?:生成|编辑|修改)完成\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function isPlainTextChatInput(input = '', attachments = []) {
  const text = String(input || '').trim();
  if (!text || (attachments || []).some(item => item && item.is_image)) return false;
  if (/(画|绘制|生成|创建|做一张|出一张|来一张|生图|图片|图像|海报|头像|插画|漫画|logo|图标|配图|封面|\d+\s*张图|[一二两三四五六七八九十]+张图|多张图|几张图|render|draw|generate image|create image)/i.test(text)) return false;
  if (/(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|删除|移除|加上|添加|加个|放大|缩小|变成|换个|换成|边框|水印|背景|颜色|字体|样式|清晰|高清|edit|change|remove|replace|add)/i.test(text)) return false;
  return true;
}

function parseRouteResult(text = '', normalizeRoute, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalize = normalizeRoute || imageRouteContext.normalizeRoute;
  if (typeof normalize !== 'function') throw new TypeError('normalizeRoute is required');
  try {
    const parsed = normalize(JSON.parse(stripJsonFence(value)));
    if (isPlainTextChatInput(options.input, options.attachments)) {
      const selectedReferenceId = String(parsed.selectedReferenceId || '');
      const hasExplicitReference = !!selectedReferenceId && selectedReferenceId !== 'imgref_latest';
      const hasSelectedImage = !!(parsed.selectedImageIds?.length || parsed.selectedIndexes?.length || hasExplicitReference);
      if (parsed.mode === 'image' || (parsed.mode === 'edit_image' && !hasSelectedImage)) {
        return normalize({ mode: 'chat', target: 'none', use_previous_image: false, intent: 'unknown', confidence: 1, evidence: '普通文本输入，没有明确生图或可定位修图意图，强制走聊天' }, 'chat');
      }
    }
    return parsed;
  } catch { return null; }
}

function buildFileCandidatesFromAttachments(attachments = []) {
  return (attachments || [])
    .filter(item => item && !item.is_image)
    .map((item, index) => ({
      index: index + 1,
      file_id: item.file_id || item.id || item.attachmentId || item.attachment_id || '',
      name: item.name || 'attachment',
      type: item.type || '',
      size: Number(item.size) || 0,
      has_extracted_text: !!item.has_extracted_text,
      unsupported_reason: item.unsupported_reason || '',
    }));
}

function compactRoutePayloadContext(context = {}, input = '', attachments = []) {
  const next = context && typeof context === 'object' ? { ...context } : {};
  const currentFiles = buildFileCandidatesFromAttachments(attachments);
  if (currentFiles.length) next.file_candidates = currentFiles;
  else if (!Array.isArray(next.file_candidates)) next.file_candidates = [];
  const current = String(input || '').trim();
  const messages = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
  if (current && messages.length) {
    const last = messages[messages.length - 1];
    const content = String(last?.content || '').trim();
    const duplicateCurrent = last?.role === 'user' && (content === current || content.startsWith(`${current}\n\n[image `) || content.startsWith(`${current}\n\n[file `));
    if (duplicateCurrent) messages.pop();
  }
  next.recent_messages = messages;
  return next;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
  const routeContext = compactRoutePayloadContext(context, input, attachments);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt + UPLOADED_IMAGE_ROUTE_PROMPT },
      { role: 'user', content: JSON.stringify({ current_input: input, current_mode: currentMode, auto_mode: autoMode, attachments, context: routeContext }, null, 2) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  UPLOADED_IMAGE_ROUTE_PROMPT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  stripJsonFence,
  isPlainTextChatInput,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  buildRoutePayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
