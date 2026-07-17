(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 意图路由器，只返回 JSON，不回答用户。
目标：精准识别 current_input，并输出结构化 task contract；steps 仅描述当前单次执行，不得输出未实现的多阶段执行协议。

核心原则：current_input 是最新用户输入，优先级最高；attachments 是本轮资源，图片/文件都是当前输入的一部分；context 只用于解析明确引用（上一张、刚才、引用消息、继续、那个文件等）和上一轮修正，历史不能覆盖新任务。image_candidates/file_candidates 是候选元数据；不要猜图片或文件内容，只判断任务、资源、角色和执行参数。

必须返回 task contract JSON：
{"schema_version":"task_contract.v2","intent":"chat|vision_qa|image.generate|image.edit|file.qa|clarify|refuse","task_type":"new_task|followup|correction|continuation","execution":{"api":"chat|vision|image_generation|image_edit|clarify|refuse","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image|clarify|refuse"},"resources":[{"type":"image|file|text|message","source":"current|quoted|history|context","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","index":1,"id":"","reference_id":"","name":"","required":true,"missing":false}],"steps":[{"id":"step_1","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image","input_roles":[],"output_role":"output","prompt":"","depends_on":[]}],"prompt_plan":{"current_user_intent":"","context_to_preserve":"","constraints":[],"do_not_add":[],"final_instruction":""},"clarification":{"needed":false,"question":"","missing_resources":[]},"confidence":0,"needs_review":false,"reason":""}

task_type：不依赖历史的完整请求=new_task，即使 context 有旧图；明确追问历史/引用=followup；指出上一结果错误=correction；仅“继续”=continuation。new_task 只允许 current 资源，context_to_preserve 必须为空。例：先画猫，再说“画一条鱼”必须是 new_task，不得带猫。

needs_review：意图两可、多个候选资源无法确定，或上下文冲突时为 true；否则 false。

意图：文字任务=chat；看图=vision_qa/image_qa；识字=vision_qa/ocr；多图比较=vision_qa/image_compare；文件问答=file.qa/file_qa；文件+图片=file.qa/multimodal_qa；纯文本生图=image.generate/text_to_image；参考图生图=image.generate/image_reference_gen；修图=image.edit/edit_image。“先分析再生成/编辑”按最终图片操作路由，分析要求写入 prompt_plan。

资源角色：编辑目标=target，参考图=reference，风格=style_reference，对比=compare_a/compare_b，看图=source，文件=attachment。source 取 current/quoted/history/context。

本轮有图默认参与；若同时指“上一张”并要求比较，输出 current+history，operation=image_compare；明确排除当前图时只用 history。

澄清：只有资源缺失、多个候选但用户必须指定、或操作目标不清时 intent=clarify；不要把可直接执行的任务澄清掉。

只返回 JSON，不要 Markdown。

Context boundary: new_task uses only current_input and current attachments; never inherit historical prompts. Only followup/correction/continuation may preserve context explicitly.`;

const INTENT_REVIEW_SYSTEM_PROMPT = `${ROUTE_SYSTEM_PROMPT}

Review the first task_contract.v2 using first_task_contract, current_input, attachments, and context. Return one complete task_contract.v2 only. Never return legacy route, image_source, use_previous_image, or instruction fields.`;


const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});

const intentContract = root?.ChatUICoreIntentContract
  || root?.ChatUICore?.intentContract
  || root?.window?.ChatUICoreIntentContract
  || root?.window?.ChatUICore?.intentContract
  || (typeof require === 'function' ? require('../core/intent-contract') : {});

const promptComposer = root?.ChatUIPromptComposerService
  || root?.ChatUIServices?.promptComposer
  || root?.window?.ChatUIPromptComposerService
  || root?.window?.ChatUIServices?.promptComposer
  || (typeof require === 'function' ? require('./prompt-composer-service') : {});

function cleanQuotedContent(text = '') {
  return String(text || '')
    .replace(/\[base64 image\]/gi, '')
    .replace(/\u8017\u65f6\uff1a[^\n]+/g, '')
    .replace(/RT\s+[^\n]+/gi, '')
    .replace(/TTFT\s+[^\n]+/gi, '')
    .replace(/^\[\u56fe\u7247(?:\u751f\u6210|\u7f16\u8f91|\u4fee\u6539)\u5b8c\u6210\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}


function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function attachComposedPrompt(route = {}, taskContract = {}, options = {}) {
  const input = String(options.input || '').trim();
  const context = options.context || {};
  let next = { ...route, taskContract };
  if (taskContract.intent === 'image.generate') {
    const prompt = promptComposer?.composeImageGeneratePrompt
      ? promptComposer.composeImageGeneratePrompt(taskContract, context, input)
      : input;
    next = { ...next, contextualImagePrompt: prompt, operation: { ...(next.operation || {}), prompt } };
  } else if (taskContract.intent === 'image.edit') {
    const editInstruction = promptComposer?.composeImageEditPrompt
      ? promptComposer.composeImageEditPrompt(taskContract, context, input)
      : input;
    next = { ...next, editInstruction, operation: { ...(next.operation || {}), edit_instruction: editInstruction } };
  }
  return next;
}

function isTaskContractResult(value = {}) {
  return typeof intentContract.hasExactContractShape === 'function'
    && intentContract.hasExactContractShape(value);
}

function parseRouteResult(text = '', normalizeRoute, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalize = normalizeRoute || imageRouteContext.normalizeRoute;
  if (typeof normalize !== 'function') throw new TypeError('normalizeRoute is required');
  try {
    const raw = JSON.parse(stripJsonFence(value));
    if (!isTaskContractResult(raw)) return null;
    const taskContract = intentContract.normalizeTaskContract(raw, options);
    const routeInput = intentContract.taskContractToExecutionRoute(taskContract, options);
    const parsedBase = normalize(routeInput);
    return attachComposedPrompt(parsedBase, taskContract, options);
  } catch {
    return null;
  }
}

function needsIntentReview(route = {}, context = {}) {
  if (!route?.taskContract) return false;
  return intentContract?.needsIntentReview ? intentContract.needsIntentReview(route.taskContract, context) : false;
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
      has_extracted_text: !!(item.has_extracted_text || item.hasExtractedText),
      unsupported_reason: item.unsupported_reason || item.unsupportedReason || '',
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

function compactRouteUserPayload({ input = '', attachments = [], context = {}, currentMode = 'chat', autoMode = true } = {}) {
  const routeContext = compactRoutePayloadContext(context, input, attachments);
  const payload = { current_input: input };
  if (currentMode && currentMode !== 'chat') payload.current_mode = currentMode;
  if (autoMode === false) payload.auto_mode = false;
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const compactContext = Object.fromEntries(Object.entries(routeContext || {}).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (!value) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }));
  if (Object.keys(compactContext).length) payload.context = compactContext;
  return payload;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
  const userPayload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode });
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };
}

function buildIntentReviewPayload({ model, input, attachments = [], context = {}, firstRoute = null, systemPrompt = INTENT_REVIEW_SYSTEM_PROMPT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  if (firstRoute?.taskContract) payload.first_task_contract = firstRoute.taskContract;
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  INTENT_REVIEW_SYSTEM_PROMPT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  stripJsonFence,
  needsIntentReview,
  isTaskContractResult,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentReviewPayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
