(function initChatUIPromptComposerService(root) {
  'use strict';

  const intentContract = root?.ChatUICoreIntentContract
    || root?.ChatUICore?.intentContract
    || root?.window?.ChatUICoreIntentContract
    || root?.window?.ChatUICore?.intentContract
    || (typeof require === 'function' ? require('../core/intent-contract') : {});

  function compact(value = '', max = 2000) {
    const text = String(value || '').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function uniqueLines(values = []) {
    const seen = new Set();
    const lines = [];
    for (const value of values) {
      const text = compact(value, 600);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lines.push(text);
    }
    return lines;
  }

  function latestImagePromptFromContext(context = {}) {
    return compact(context?.last_generated_image?.prompt || context?.latest_assistant_image_result?.content || context?.suggested_contextual_image_prompt || context?.latest_user_image_request?.content || '', 1600);
  }

  function explicitQuotedImagePrompt(context = {}, input = '') {
    const suggested = compact(context?.suggested_contextual_image_prompt || '', 4800);
    const current = compact(input, 2400);
    if (!suggested || suggested === current) return '';
    const currentSuffix = current ? `\n\n${current}` : '';
    return currentSuffix && suggested.endsWith(currentSuffix)
      ? suggested.slice(0, -currentSuffix.length).trim()
      : suggested;
  }

  function mergeExplicitQuotedImagePrompt(prompt = '', context = {}, input = '') {
    const quoted = explicitQuotedImagePrompt(context, input);
    const current = compact(prompt || input, 4800);
    if (!quoted) return current;
    if (!current || quoted.includes(current)) return quoted;
    if (current.includes(quoted)) return current;
    return compact(`${quoted}\n\n${current}`, 6400);
  }

  function composePromptFromPlan(plan = {}, { input = '', context = {}, includeContext = true, includeGuardrail = false } = {}) {
    const current = compact(plan.current_user_intent || input, 1200);
    const preserved = includeContext ? compact(plan.context_to_preserve, 1600) : '';
    const constraints = uniqueLines(plan.constraints || []);
    const finalInstruction = compact(plan.final_instruction || current, 2400);
    const doNotAdd = uniqueLines(plan.do_not_add || []);
    const parts = [];
    if (preserved && preserved !== finalInstruction && preserved !== current && !finalInstruction.includes(preserved)) parts.push(`需要保留的上下文：${preserved}`);
    if (current && current !== finalInstruction && !finalInstruction.includes(current)) parts.push(`用户当前意图：${current}`);
    if (constraints.length) parts.push(`明确约束：\n${constraints.map(item => `- ${item}`).join('\n')}`);
    parts.push(finalInstruction || current || preserved);
    if (doNotAdd.length) {
      parts.push(`不要做：\n${doNotAdd.map(item => `- ${item}`).join('\n')}`);
    }
    return parts.filter(Boolean).join('\n\n').trim();
  }

  function composeChatPrompt(task = {}, context = {}, input = '') {
    const normalized = intentContract.normalizeTaskContract ? intentContract.normalizeTaskContract(task, { input }) : task;
    return composePromptFromPlan(normalized.prompt_plan || {}, { input, context, includeContext: false, includeGuardrail: false }) || compact(input, 2400);
  }

  function composeImageGeneratePrompt(task = {}, context = {}, input = '') {
    const normalized = intentContract.normalizeTaskContract ? intentContract.normalizeTaskContract(task, { input }) : task;
    let prompt = '';
    if (normalized.task_type === 'new_task') {
      prompt = compact(input || normalized.prompt_plan?.current_user_intent || normalized.prompt_plan?.final_instruction, 2400);
    } else {
      const promptPlan = { ...(normalized.prompt_plan || {}) };
      if (!promptPlan.context_to_preserve) promptPlan.context_to_preserve = latestImagePromptFromContext(context);
      prompt = composePromptFromPlan(promptPlan, { input, context, includeContext: true, includeGuardrail: true }) || compact(input, 2400);
    }
    return mergeExplicitQuotedImagePrompt(prompt, context, input);
  }

  function composeImageEditPrompt(task = {}, context = {}, input = '') {
    const normalized = intentContract.normalizeTaskContract ? intentContract.normalizeTaskContract(task, { input }) : task;
    const promptPlan = { ...(normalized.prompt_plan || {}) };
    if (!promptPlan.context_to_preserve) promptPlan.context_to_preserve = latestImagePromptFromContext(context);
    return composePromptFromPlan(promptPlan, { input, context, includeContext: true, includeGuardrail: true }) || compact(input, 2400);
  }

  function composeForTask(task = {}, context = {}, input = '') {
    const normalized = intentContract.normalizeTaskContract ? intentContract.normalizeTaskContract(task, { input }) : task;
    if (normalized.intent === 'image.generate') return composeImageGeneratePrompt(normalized, context, input);
    if (normalized.intent === 'image.edit') return composeImageEditPrompt(normalized, context, input);
    return composeChatPrompt(normalized, context, input);
  }

  const api = Object.freeze({
    latestImagePromptFromContext,
    explicitQuotedImagePrompt,
    mergeExplicitQuotedImagePrompt,
    composeChatPrompt,
    composeImageGeneratePrompt,
    composeImageEditPrompt,
    composeForTask,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIPromptComposerService = api;
  if (root?.window) root.window.ChatUIPromptComposerService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
