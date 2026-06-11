(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = '你是 ChatUI 意图路由器。你的任务是根据用户本次输入和给定图片候选，判断应该调用聊天、生成图片，还是编辑图片；只输出 JSON，不改写用户请求。\n\n输出：{"mode":"chat|image|edit_image","target":"none|new|uploaded|previous","use_previous_image":false,"selected_reference_id":"","selected_indexes":[],"selected_image_ids":[],"need_clarification":false,"clarification_question":"","intent":"text_to_image|image_edit|image_reference_gen|unknown","edit_instruction":"","contextual_image_prompt":"","confidence":0.0,"evidence":""}\n\n分类依据是用户期望的产物或动作：\n- chat：用户期望得到文本回答、文本创作、解释、总结、翻译、代码、计划、建议，或对图片/文件/引用内容进行问答、评价、分析、OCR/提取文字。\n- image：用户期望得到一张新的视觉图片/图像作品，而不是文本内容。\n- edit_image：用户期望对已有图片做视觉修改、处理、合成或风格变化。\n\n附件和占位符语义：\n- current_input 或 recent_messages 中的 [image id=...] / [file id=...] 只是附件索引占位符，不是用户正文内容，不能把它当作文件内容或答案依据。\n- 非图片文件由 attachments 元数据和 context.file_candidates 表示；file_candidates 只描述文件句柄、文件名、类型、大小和是否已解析出文本，不包含文件正文。\n- 用户问“这是什么/这个是什么/看看这个/解释这个/总结这个/里面有多少/列举出来”等且存在非图片附件或 file_candidates 时，mode=chat；后续聊天层会按需读取完整文件文本再回答。\n- route 不要根据 [file id=...] 猜文件内容；也不要要求或依赖附件正文。占位符只代表一个文件附件，不能当作正文或答案依据。\n\n图片候选语义：\n- context.image_candidates 是唯一图片候选索引；选图只使用里面的 reference_id、index、image_id、target。其它 latest/recent 字段只是摘要，不能当成新增图片列表重复选择。\n- 非引用场景：image_candidates 可来自用户当前/历史上传图、assistant 历史生成或编辑返回图。\n- 引用场景：image_candidates 只来自被引用消息本身；图片编号也只按引用消息内图片排序，不能扩散到全局上下文。\n\n判定要求：\n1. 不要只看关键词。"生成一段文案/写一首诗/做个计划"的产物是文本，mode=chat；"生成一张海报/画一只猫/出一张头像"的产物是图片，mode=image。\n2. edit_image 必须同时有可定位的输入图和明确的视觉编辑动作；缺目标图或动作不清时，need_clarification=true。\n3. 图片来源只从 image_candidates 选择：用户上传图 target=uploaded，assistant 返回/历史生成/引用图 target=previous，新图 target=new。\n4. 引用型生图：如果 current_input 表达新的图片数量、变体或继续生成需求，并且引用内容提供了图片描述，mode=image，contextual_image_prompt 必须由“引用描述 + current_input”组成。\n5. 图片理解型聊天：只有 current_input 明确要求理解、评价、描述、比较、OCR/提取文字、识别图片中文字或询问图片内容时，mode=chat 且必须选择对应图片；普通文本聊天即使上下文或附件含图片，也不要选择图片，target=none。\n6. 非引用生图 contextual_image_prompt 留空；edit_instruction 只在 edit_image 时填写修改动作；保留 imgref_/img_ ID 原样。';

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
