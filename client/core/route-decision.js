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

function isImageUnderstandingInput(input = '') {
  return /(图里|图片里|画面|这张图|这张图片|这些图|这些图片|哪张|看图|看一下|看下|看看|看看这个|识别|描述|分析|评价|评语|逐项|每一项|哪里不对|适合|像什么|是什么|这是什么|这个是什么|有什么|对比|比较|提取文字|提取.*文字|识别文字|文字识别|读文字|读取文字|ocr|OCR|image|picture|photo|describe|analy[sz]e|what.*(in|on).*image)/i.test(String(input || ''));
}

function isImageEditInput(input = '') {
  return /(改|修改|编辑|调整|优化|重做|修复|修一下|去掉|去除|删除|移除|抠图|加上|添加|加个|放大|缩小|裁剪|变成|改成|换成|替换|换个|边框|水印|背景|颜色|字体|样式|清晰|高清|漫画|卡通|黑白|美化|edit|change|remove|replace|add|background|style|color|enhance|upscale)/i.test(String(input || ''));
}

function isExplicitTextOnlyInput(input = '') {
  const text = String(input || '').trim();
  if (!text) return false;
  if (/(不用|不要|无需).{0,8}(看图|看图片|分析图|处理图|编辑图|改图|图片|图像)|只聊文字|纯文本|不处理图片|ignore (the )?(image|picture|photo)|text[-\s]?only/i.test(text)) return true;
  if (isPromptWritingInput(text)) return true;
  if (/(解释|说明|介绍|讲讲|科普|翻译|改写|润色|总结|写一[篇段封]|起草|生成文案|代码|函数|报错|bug|算法|Promise|JavaScript|Python|SQL|Linux|Docker|Git|API|接口|数据库|正则|作文|邮件|合同|方案|计划|文档|脚本)/i.test(text) && !/(这张|这个|图|图片|画面|照片|附件|上面|里面|每一项|逐项|标注|截图)/i.test(text)) return true;
  return false;
}

function isExplicitHistoryImageInput(input = '') {
  return /(上一张|上张|前一张|刚才那张|刚刚那张|之前那张|历史|原图|继续|基于刚才|基于上一张|那张图|那个图)/i.test(String(input || ''));
}

function isImageComparisonWithHistoryInput(input = '') {
  const text = String(input || '').trim();
  if (!text) return false;
  const hasCurrent = /(这张|这个|这幅|这图|当前|本轮|新图|现在这张|this|current|new)/i.test(text);
  const hasHistory = isExplicitHistoryImageInput(text) || /(上一个|前一个|之前的|刚才的|last|previous)/i.test(text);
  const hasRelation = /(区别|差别|不同|差异|变化|对比|比较|相比|比一比|哪里不一样|哪里变了|difference|compare|versus|vs\.?)/i.test(text);
  return hasCurrent && hasHistory && hasRelation;
}

function isHistoryOnlyImageInput(input = '') {
  const text = String(input || '').trim();
  if (!isExplicitHistoryImageInput(text)) return false;
  return /(不要|别|不用|无需).{0,8}(这张|这个|当前|本轮|新图)|只(看|处理|改|编辑|用).{0,12}(上一张|上张|前一张|刚才那张|之前那张|历史|原图)|继续|基于刚才|基于上一张/i.test(text);
}

function isCurrentImageDeicticInput(input = '') {
  const text = String(input || '').trim();
  return /(这张图|这张图片|这幅图|这个图|这图|当前图|当前图片|这张|这个图片)/i.test(text);
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
  isImageUnderstandingInput,
  isImageEditInput,
  isExplicitTextOnlyInput,
  isExplicitHistoryImageInput,
  isImageComparisonWithHistoryInput,
  isHistoryOnlyImageInput,
  isCurrentImageDeicticInput,
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
