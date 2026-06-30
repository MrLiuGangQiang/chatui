(function initChatUICoreRouteDecision(root) {
  'use strict';

const API_ROUTES = new Set(['chat', 'vision', 'image_generate', 'image_edit', 'unclear', 'unsafe']);
const IMAGE_SOURCES = new Set(['none', 'current', 'quoted', 'history']);

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

function isImagePromptExtractionInput(input = '') {
  return /(提取|总结|分析|拆解|反推|逆向|还原).*(图片|图|画面).*(提示词|prompt|Prompt)|(?:图片|图|画面).*(提取|总结|分析|拆解|反推|逆向|还原|生成|生图).*(提示词|prompt|Prompt)|(?:图片|图|画面).*(元素|要素).*(提示词|prompt|Prompt)|(?:根据|基于|参考|按照).*(图片|图|画面).*(提示词|prompt|Prompt)|(?:生成|生图).*(提示词|prompt|Prompt)|(?:prompt|Prompt).*(反推|逆向|还原|提取)|(?:generate|write|create|make|infer|extract|reverse[-\s]?engineer|reverse).*(?:prompt).*(?:from|based on|for).*(?:image|picture|photo)|(?:image|picture|photo).*(?:prompt).*(?:generate|write|create|infer|extract|reverse)/i.test(String(input || ''));
}

function isImplicitImagePromptExtractionInput(input = '') {
  return /(?:反推|逆向|还原|提取|拆解|分析|总结|生成|生图|写|整理).*(?:提示词|prompt|Prompt)|(?:提示词|prompt|Prompt).*(?:反推|逆向|还原|提取|拆解|分析|总结|生成|生图|详细|尽量详细)|(?:reverse[-\s]?engineer|reverse|infer|extract|write|generate|create|make).*(?:prompt)|(?:prompt).*(?:reverse|infer|extract|write|generate|create|detailed|detail)/i.test(String(input || ''));
}

function isPromptWritingInput(input = '') {
  const text = String(input || '').trim();
  if (!text) return false;
  const promptWord = '(?:提示词|prompt|Prompt|咒语|关键词)';
  const writingVerb = '(?:优化|润色|改写|重写|扩写|完善|修改|调整|翻译|整理|提炼|生成|写|起草|补全|polish|optimi[sz]e|rewrite|revise|improve|translate|expand|write|draft|create|generate)';
  const actualImageVerb = /(?:用|按|根据|基于|照着|拿|把).{0,12}(?:提示词|prompt|Prompt).{0,12}(?:画|绘制|生成|创建|做|出|渲染|生图|render|draw|generate|create).{0,8}(?:图|图片|image|picture|photo)|(?:画|绘制|生成|创建|做|出|渲染|生图|render|draw|generate|create).{0,8}(?:图|图片|image|picture|photo).{0,12}(?:用|按|根据|基于).{0,12}(?:提示词|prompt|Prompt)/i;
  if (actualImageVerb.test(text)) return false;
  return new RegExp(`${writingVerb}.{0,24}${promptWord}|${promptWord}.{0,24}${writingVerb}`, 'i').test(text);
}

function normalizeSelectedIndexes(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => Number(item)).filter(item => Number.isInteger(item) && item >= 1).filter((item, index, list) => list.indexOf(item) === index);
}

function currentImageCount(attachments = []) {
  return (attachments || []).filter(item => item && item.is_image).length;
}

function currentFileCount(attachments = []) {
  return (attachments || []).filter(item => item && !item.is_image).length;
}

function contextImageCandidates(context = {}, source = '') {
  const list = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
  if (!source || source === 'none') return [];
  if (source === 'history') return list.filter(item => item?.source !== 'quoted');
  return list.filter(item => item?.source === source || (source === 'current' && item?.target === 'uploaded'));
}

function contextFileCandidates(context = {}, source = '') {
  const list = Array.isArray(context?.file_candidates) ? context.file_candidates : [];
  if (!source || source === 'none') return [];
  return list.filter(item => !item?.source || item.source === source);
}

function inferSourceFromContext(route, simpleSource, attachments = [], context = {}) {
  if (IMAGE_SOURCES.has(simpleSource) && simpleSource !== 'none') return simpleSource;
  const needsImage = route === 'vision' || route === 'image_edit';
  if (!needsImage) return 'none';
  if (currentImageCount(attachments)) return 'current';
  const candidates = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
  if (candidates.some(item => item?.source === 'quoted')) return 'quoted';
  if (candidates.length || context?.latest_image_reference || context?.last_generated_image || context?.latest_uploaded_image) return 'history';
  return 'none';
}

function defaultIndexesForSource(source, attachments = [], context = {}) {
  const count = source === 'current' ? currentImageCount(attachments) : contextImageCandidates(context, source).length;
  return count === 1 ? [1] : [];
}

function selectedCandidatesForSource(source, indexes = [], attachments = [], context = {}) {
  if (source === 'current') return [];
  const candidates = contextImageCandidates(context, source);
  if (!indexes.length) return candidates.length === 1 ? [candidates[0]] : [];
  return candidates.filter(item => indexes.includes(Number(item.index)));
}

function candidateExecutionIndexes(selected = []) {
  return selected
    .map(item => Number(item && (item.source_index || item.sourceIndex || item.index)))
    .filter(item => Number.isInteger(item) && item >= 1)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function targetForEditSource(source, candidate = null) {
  if (source === 'current') return 'uploaded';
  if (candidate?.target === 'uploaded') return 'uploaded';
  return 'previous';
}

function imageRefTargetForSource(source, candidate = null) {
  if (source === 'current') return 'uploaded';
  return candidate?.target === 'uploaded' ? 'uploaded' : 'previous';
}

function referenceIdForSource(source, selected = [], context = {}, usePreviousImage = false) {
  const fromCandidate = selected.find(item => item?.reference_id)?.reference_id;
  if (fromCandidate) return fromCandidate;
  if (source === 'history' && context?.latest_image_reference?.reference_id) return context.latest_image_reference.reference_id;
  if (source === 'history' && usePreviousImage) return 'imgref_latest';
  return '';
}

const api = Object.freeze({
  API_ROUTES,
  IMAGE_SOURCES,
  cleanQuotedContent,
  stripJsonFence,
  isPlainTextChatInput,
  isImagePromptExtractionInput,
  isImplicitImagePromptExtractionInput,
  isPromptWritingInput,
  normalizeSelectedIndexes,
  currentImageCount,
  currentFileCount,
  contextImageCandidates,
  contextFileCandidates,
  inferSourceFromContext,
  defaultIndexesForSource,
  selectedCandidatesForSource,
  candidateExecutionIndexes,
  targetForEditSource,
  imageRefTargetForSource,
  referenceIdForSource,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreRouteDecision = api;
if (root?.window) root.window.ChatUICoreRouteDecision = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
