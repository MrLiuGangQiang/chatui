(function initChatUIPromptComposerService(root) {
  'use strict';

  function compact(value = '', max = 2400) {
    const text = String(value || '').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function unique(values = [], max = 16) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const text = compact(value, 800);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
      if (result.length >= max) break;
    }
    return result;
  }

  function candidateForResource(resource = {}, context = {}) {
    const candidates = resource.type === 'file' ? context?.file_candidates : context?.image_candidates;
    if (!Array.isArray(candidates)) return null;
    return candidates.find(candidate => {
      const candidateId = resource.type === 'file' ? candidate?.file_id : candidate?.image_id;
      if (resource.id && candidateId === resource.id) return true;
      if (resource.reference_id && candidate?.reference_id === resource.reference_id && Number(candidate?.index) === Number(resource.index)) return true;
      return candidate?.source === resource.source && Number(candidate?.index) === Number(resource.index);
    }) || null;
  }

  function resolveBaseText(resource = {}, context = {}) {
    const candidate = candidateForResource(resource, context);
    if (candidate?.prompt) return compact(candidate.prompt, 1600);
    if (resource.type === 'image' && resource.source === 'history') {
      const last = context?.last_generated_image;
      if (last?.prompt && (!resource.reference_id || !last.reference_id || last.reference_id === resource.reference_id)) return compact(last.prompt, 1600);
      if (context?.latest_assistant_image_result?.content) return compact(context.latest_assistant_image_result.content, 1600);
    }
    if (resource.source === 'quoted') {
      const suggested = compact(context?.suggested_contextual_image_prompt, 3200);
      if (suggested) return suggested;
    }
    if (resource.type === 'message' && Array.isArray(context?.recent_messages)) {
      const message = context.recent_messages.find(item => Number(item?.index) === Number(resource.index));
      if (message?.content) return compact(message.content, 1600);
    }
    return '';
  }

  function operationLine(operation = {}) {
    const target = compact(operation.target, 240);
    const value = compact(operation.value, 800);
    if (operation.op === 'preserve') return `保留：${target}`;
    if (operation.op === 'remove') return `删除：${target}`;
    if (operation.op === 'replace') return `替换：${target} → ${value}`;
    return `新增：${target}${value && value !== target ? ` = ${value}` : ''}`;
  }

  function composePatchPrompt(task = {}, context = {}, input = '', { includeBaseText = false } = {}) {
    const directive = task.directive || {};
    const resourcesByKey = new Map((task.resources || []).map(resource => [resource.key, resource]));
    const baseResources = (directive.base_resource_keys || []).map(key => resourcesByKey.get(key)).filter(Boolean);
    const baseTexts = includeBaseText ? unique(baseResources.map(resource => resolveBaseText(resource, context)), 6) : [];
    const operations = (directive.operations || []).map(operationLine).filter(Boolean);
    const constraints = unique(directive.constraints || []);
    const parts = [];

    if (baseTexts.length) parts.push(`补丁基线：\n${baseTexts.map(text => `- ${text}`).join('\n')}`);
    parts.push(`用户当前请求：\n${compact(input, 3200)}`);
    if (operations.length) parts.push(`结构化变更：\n${operations.map(line => `- ${line}`).join('\n')}`);
    if (constraints.length) parts.push(`硬性约束：\n${constraints.map(line => `- ${line}`).join('\n')}`);
    if (directive.unmentioned_policy === 'preserve') {
      parts.push('修改边界：只执行用户明确要求及上述结构化变更；未提及的主体、构图、身份、数量、位置、风格和细节保持不变，不得自行扩写。');
    } else {
      parts.push('修改边界：允许为完成当前请求调整未明确锁定的细节，但不得增加与请求无关的主体或要求。');
    }
    return parts.filter(Boolean).join('\n\n').trim();
  }

  function isImageCompositionTask(task = {}) {
    if (task.operation !== 'image_reference_gen') return false;
    const resources = Array.isArray(task.resources) ? task.resources.filter(resource => resource?.type === 'image' && !resource.missing) : [];
    const operations = Array.isArray(task.directive?.operations) ? task.directive.operations : [];
    return resources.length >= 2 && operations.some(operation => operation?.target === 'composition');
  }


  function composeImageGeneratePrompt(task = {}, context = {}, input = '') {
    if (isImageCompositionTask(task)) return compact(input, 3200);
    if (task.directive?.mode !== 'patch') return compact(input, 3200);
    return composePatchPrompt(task, context, input, { includeBaseText: true }) || compact(input, 3200);
  }

  function composeImageEditPrompt(task = {}, context = {}, input = '') {
    return composePatchPrompt(task, context, input, { includeBaseText: false }) || compact(input, 3200);
  }



  const api = Object.freeze({
    candidateForResource,
    resolveBaseText,
    isImageCompositionTask,
    composeImageGeneratePrompt,
    composeImageEditPrompt,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIPromptComposerService = api;
  if (root?.window) root.window.ChatUIPromptComposerService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
