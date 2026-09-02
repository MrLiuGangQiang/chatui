(function initChatUIRouteSemanticNormalizer(root) {
  'use strict';

  const UNVERIFIED_IMAGE_DELIVERY_QUERY_PATTERN = /^(?:图片呢|图呢|图片在哪里|图在哪里|还没(?:看到|收到)图片|没有(?:看到|收到)图片|结果呢|结果在哪里|发图了吗|图片还没来)[。！？!?\s]*$/i;
  const DEFAULT_IMAGE_GENERATION_INTENT_PATTERN = /(?:生成|画|绘制|制作|创建|\bgenerate\b|\bdraw\b|\bcreate\b)/i;

  function createRouteSemanticNormalizer({
    maxGoalLength = 1000,
    imageRelationOperations = ['text_to_image', 'image_reference_gen', 'edit_image'],
    imageTaskStateOperations = ['text_to_image', 'image_reference_gen', 'edit_image'],
    imageGenerationIntentPattern = DEFAULT_IMAGE_GENERATION_INTENT_PATTERN,
    taskContinuityFromExecution = null,
    renderTaskContinuity = null,
  } = {}) {
    const goalLimit = Number.isSafeInteger(Number(maxGoalLength)) && Number(maxGoalLength) >= 1
      ? Number(maxGoalLength)
      : 1000;
    const relationOperations = new Set(imageRelationOperations || []);
    const taskStateOperations = new Set(imageTaskStateOperations || []);
    const generationPattern = imageGenerationIntentPattern instanceof RegExp
      ? imageGenerationIntentPattern
      : DEFAULT_IMAGE_GENERATION_INTENT_PATTERN;

    function stringValue(value) {
      return String(value ?? '').trim();
    }

    function isImageGenerationIntent(value = '') {
      generationPattern.lastIndex = 0;
      return generationPattern.test(stringValue(value));
    }

    function recentUserMessages(context = {}) {
      return (Array.isArray(context?.recent_messages) ? context.recent_messages : [])
        .filter(message => message?.role === 'user' && stringValue(message?.content || message?.rawText))
        .map(message => stringValue(message.content || message.rawText));
    }

    function previousImageTaskGoal(options = {}) {
      const previous = options.context?.previous_execution || {};
      const previousState = typeof taskContinuityFromExecution === 'function'
        ? taskContinuityFromExecution(previous)
        : null;
      if (previousState && typeof renderTaskContinuity === 'function') return stringValue(renderTaskContinuity(previousState));
      if (stringValue(previous.resolved_goal || previous.input)) return stringValue(previous.resolved_goal || previous.input);
      const messages = recentUserMessages(options.context).reverse();
      // Fall back to an explicit generation request only. A domain-noun list is not a reliable signal that the conversation had a visual task.
      return messages.find(message => isImageGenerationIntent(message)) || '';
    }

    function comparableImageTaskText(value = '') {
      return stringValue(value)
        .toLocaleLowerCase()
        .replace(/(?:旧|原|上一版|上版|前一版)(?:的)?(?:方案|版本)/g, '')
        .replace(/[\s\u3000，。；：、,.!?！？:;'"“”‘’（）()\[\]【】{}《》<>·—_\-]/g, '');
    }

    function repeatsPreviousImageBase(value = '', baseTexts = []) {
      const candidate = comparableImageTaskText(value);
      if (candidate.length < 12) return false;
      return baseTexts.some((base) => {
        const previous = comparableImageTaskText(base);
        if (previous.length < 12) return false;
        if (candidate === previous) return true;
        const shorter = candidate.length < previous.length ? candidate : previous;
        const longer = candidate.length < previous.length ? previous : candidate;
        return longer.includes(shorter) && (shorter.length / longer.length) >= 0.92;
      });
    }

    function normalizeImageAmendmentGoal(goal = '', options = {}) {
      const original = stringValue(goal).slice(0, goalLimit);
      let text = original;
      if (!text || !options.context?.previous_execution) return text;
      const previous = options.context.previous_execution;
      const previousState = typeof taskContinuityFromExecution === 'function'
        ? taskContinuityFromExecution(previous)
        : null;
      const baseTexts = previousState?.segments
        ?.filter(segment => segment?.kind === 'base')
        .map(segment => stringValue(segment.text)) || [];
      if (!baseTexts.length) {
        const fallbackBase = stringValue(previous.resolved_goal || previous.input);
        if (fallbackBase) baseTexts.push(fallbackBase);
      }
      for (const base of baseTexts) {
        if (base && text.includes(base)) text = text.replace(base, '');
      }
      // Only a high-confidence duplicate base before the first semicolon may
      // be removed. The first real amendment clause must always survive.
      const amendmentLead = text.match(/^(?:(?:在|基于)[^：:；;。]{0,120}(?:(?:基础上|要求上?|规范上?)(?:继续)?(?:修订|调整|修改)?|(?:继续)?(?:修订|调整|修改))|(?:沿用|按照|依照)[^：:；;。]{0,120}(?:要求|规范)|(?:上一版|上版|前一版|之前|刚才)(?:的)?(?:完整)?(?:户型)?(?:文字)?(?:任务)?(?:要求|规范))[:：，,]/i);
      if (amendmentLead) text = text.slice(amendmentLead[0].length);
      text = text.replace(/^[\s：:，,；;]+/, '');
      const firstSemicolon = text.search(/[；;]/);
      if (firstSemicolon >= 0 && repeatsPreviousImageBase(text.slice(0, firstSemicolon), baseTexts)) {
        text = text.slice(firstSemicolon + 1);
      }
      text = text.replace(/^[\s：:，,；;]+/, '').trim();
      return text || original;
    }

    function goalModeForIntentSafe(intent = {}) {
      const value = stringValue(intent.goal_mode);
      return value === 'replace' || value === 'amend' ? value : '';
    }

    function repairQuotedAndSelfContainedRefs(intent = {}, input = '', candidateCatalog = []) {
      const operation = stringValue(intent.operation);
      if (operation !== 'text_to_image') return intent;
      const refs = Array.isArray(intent.resource_refs) ? intent.resource_refs : [];
      if (!refs.length) return intent;
      const byKey = new Map((Array.isArray(candidateCatalog) ? candidateCatalog : [])
        .map(candidate => [stringValue(candidate?.candidate_key), candidate]));
      const explicitReference = /(?:基于|按照|根据|引用|这个描述|上述|刚才|之前|上一轮|quoted|history)/i.test(stringValue(input));
      if (explicitReference) return intent;
      const resource_refs = refs.filter(ref => {
        const candidate = byKey.get(stringValue(ref?.candidate_key));
        return stringValue(candidate?.type) !== 'message';
      });
      return resource_refs.length === refs.length ? intent : { ...intent, resource_refs };
    }

    function repairExplicitImageCardinality(intent = {}, input = '') {
      if (stringValue(intent.operation) !== 'text_to_image' || stringValue(intent.task_shape) !== 'multi') return intent;
      const text = stringValue(input);
      const goal = stringValue(intent.goal);
      const countMatch = text.match(/(?:两张|两幅|2张|2幅|三张|三幅|3张|3幅|四张|四幅|4张|4幅)/i);
      if (!countMatch || /(?:两张|两幅|2张|2幅|三张|三幅|3张|3幅|四张|四幅|4张|4幅)/i.test(goal)) return intent;
      return { ...intent, goal: `${goal}（共${countMatch[0]}）`.slice(0, goalLimit) };
    }

    function repairShortVisualGoal(intent = {}, input = '', options = {}) {
      const operation = stringValue(intent.operation);
      const text = stringValue(input);
      if (operation !== 'text_to_image'
          || goalModeForIntentSafe(intent) === 'amend'
          || !text
          || text.length > 80
          || isImageGenerationIntent(text)
          || stringValue(intent.relation) !== 'followup') return intent;
      const previousGoal = previousImageTaskGoal(options);
      const currentGoal = stringValue(intent.goal);
      if (!previousGoal || !currentGoal || currentGoal.length > 160
          || /(?:重新设计|完整重做|从头|新主题|新的方案|改为新的)/i.test(currentGoal)) return intent;
      // Compare with punctuation and whitespace stripped so a model goal that already carries the base subject is not duplicated again.
      const comparableCurrent = comparableImageTaskText(currentGoal);
      const comparablePrevious = comparableImageTaskText(previousGoal);
      if (comparableCurrent.includes(comparablePrevious) || comparablePrevious.includes(comparableCurrent)) {
        return { ...intent, goal: `${previousGoal}；${text}`.slice(0, goalLimit) };
      }
      return { ...intent, goal: `${previousGoal}；${currentGoal}`.slice(0, goalLimit) };
    }

    function repairDisallowedMediaRefs(intent = {}, candidateCatalog = []) {
      const operation = stringValue(intent.operation);
      if (!['plain_chat', 'web_search', 'text_to_image'].includes(operation)) return intent;
      const byKey = new Map((Array.isArray(candidateCatalog) ? candidateCatalog : [])
        .map(candidate => [stringValue(candidate?.candidate_key), stringValue(candidate?.type)]));
      const resource_refs = (Array.isArray(intent.resource_refs) ? intent.resource_refs : []).filter(ref => {
        const key = stringValue(ref?.candidate_key);
        const type = byKey.get(key) || (key.startsWith('i') ? 'image' : key.startsWith('f') ? 'file' : '');
        return !['image', 'file'].includes(type);
      });
      return resource_refs.length === (Array.isArray(intent.resource_refs) ? intent.resource_refs.length : 0)
        ? intent
        : { ...intent, resource_refs };
    }

    function repairReferenceRolesFromExplicitStyleEvidence(intent = {}, input = '') {
      if (stringValue(intent.operation) !== 'image_reference_gen') return intent;
      const text = stringValue(input);
      const styleCue = /(?:配色|颜色|色调|色彩|画风|风格|palette|colou?r|style)/i.test(text);
      if (!styleCue) return intent;
      // Style-only reference requests should not be downgraded to a generic
      // content reference. Keep reference when the user also names content,
      // structure, subject, composition, or layout to be carried over.
      const contentCue = /(?:主体|构图|结构|内容|人物|场景|版式|布局|素材|形状|外观|subject|composition|layout|content|structure)/i.test(text);
      if (contentCue) return intent;
      const refs = Array.isArray(intent.resource_refs) ? intent.resource_refs : [];
      if (!refs.length) return intent;
      let changed = false;
      const resource_refs = refs.map(ref => {
        if (stringValue(ref?.role) !== 'reference') return ref;
        changed = true;
        return { ...ref, role: 'style_reference' };
      });
      return changed ? { ...intent, resource_refs } : intent;
    }

    // The model is the primary semantic recognizer. This reconciler repairs a
    // model proposal only when stronger structured evidence exists in the
    // current user turn or verified conversation state. A prior visual task is
    // identified by previous_execution.operation or an explicit generation
    // verb, never by a domain-noun whitelist.
    function reconcileModelIntent(intent = {}, options = {}, candidateCatalog = []) {
      let next = { ...intent };
      const input = stringValue(options.input || options.current_input);
      const previousExecution = options.context?.previous_execution || null;
      const priorUsers = recentUserMessages(options.context);
      const hasPriorVisualTask = relationOperations.has(stringValue(previousExecution?.operation))
        || priorUsers.some(message => isImageGenerationIntent(message));
      const imageOperation = relationOperations.has(stringValue(next.operation));

      const evidence = options.context?.delivery_evidence || {};
      const imageAvailable = evidence.actual_image_result?.available === true
        || evidence.image_delivery_confirmed === true;
      if (!imageAvailable && UNVERIFIED_IMAGE_DELIVERY_QUERY_PATTERN.test(input)) {
        const previousOperation = stringValue(previousExecution?.operation);
        next = {
          ...next,
          operation: relationOperations.has(previousOperation) ? previousOperation : 'text_to_image',
          relation: 'followup',
          goal_mode: 'replace',
          resource_refs: [],
          goal: stringValue(next.goal) || previousImageTaskGoal(options) || input,
        };
      }

      // A terse visual delta following a known visual task is a high-confidence
      // continuation/follow-up distinction. Repair the model relation and
      // preserve the model's goal rather than synthesizing a new prompt.
      if (hasPriorVisualTask
          && imageOperation
          && stringValue(next.relation) === 'continuation'
          && input.length <= 80
          && !isImageGenerationIntent(input)) {
        next = { ...next, relation: 'followup' };
      }

      next = repairReferenceRolesFromExplicitStyleEvidence(next, input);
      next = repairDisallowedMediaRefs(next, candidateCatalog);
      next = repairQuotedAndSelfContainedRefs(next, input, candidateCatalog);
      next = repairShortVisualGoal(next, input, options);
      next = repairExplicitImageCardinality(next, input);

      const hasQuotedMessageRef = (Array.isArray(next.resource_refs) ? next.resource_refs : []).some(ref => {
        const candidate = (Array.isArray(candidateCatalog) ? candidateCatalog : [])
          .find(item => stringValue(item?.candidate_key) === stringValue(ref?.candidate_key));
        return stringValue(candidate?.type) === 'message' && stringValue(candidate?.source) === 'quoted';
      });
      if (hasQuotedMessageRef && imageOperation && stringValue(next.relation) === 'continuation') {
        next = { ...next, relation: 'followup' };
      }

      // Explicit reference-generation wording outranks a contradictory edit
      // operation. The resource role is repaired together with the operation,
      // so the downstream compiler receives one coherent semantic proposal.
      const explicitReferenceReuse = /(?:继续)?(?:沿用|使用|基于)[^。！？!?\n]{0,24}(?:参考图|参考图片|风格图|配色图)/i.test(input)
        && /(?:版本|生成|新图|方案|再来|再出)/i.test(input);
      if (explicitReferenceReuse && imageOperation
          && ['edit_image', 'image_reference_gen'].includes(stringValue(next.operation))) {
        next = {
          ...next,
          operation: 'image_reference_gen',
          goal_mode: 'replace',
          resource_refs: (Array.isArray(next.resource_refs) ? next.resource_refs : []).map(ref => ({
            ...ref,
            role: stringValue(ref?.role) === 'style_reference' ? 'style_reference' : 'reference',
          })),
        };
      }

      // "基于这个描述再生成一张图片" has no image resource, only a quoted
      // text description. The model sometimes labels that image_reference_gen,
      // which then asks for a missing reference image. Strong quoted-text
      // evidence makes this text_to_image with the message as context.
      const quotedTextOnlyGeneration = stringValue(next.operation) === 'image_reference_gen'
        && /(?:基于|按照|根据)[^。！？!?\n]{0,24}(?:这个描述|上述描述|这段描述|描述)[^。！？!?\n]{0,24}(?:生成|画|创建|制作)/i.test(input)
        && Array.isArray(next.resource_refs) && next.resource_refs.length > 0
        && next.resource_refs.every(ref => {
          const candidate = (Array.isArray(candidateCatalog) ? candidateCatalog : [])
            .find(item => stringValue(item?.candidate_key) === stringValue(ref?.candidate_key));
          return stringValue(candidate?.type) === 'message';
        });
      if (quotedTextOnlyGeneration) {
        next = { ...next, operation: 'text_to_image', goal_mode: 'replace' };
      }

      // An explicit rejection of the prior task establishes conversational
      // dependency but does not invent new visual content. This repairs only
      // relation; goal and goal_mode remain model-owned.
      const rejectsPreviousTask = /(?:不要继续|不要再继续|不要使用|不要沿用|不用旧图|不使用旧图|改为|改成|换成)/i.test(input);
      if (rejectsPreviousTask && previousExecution && imageOperation && stringValue(next.relation) === 'new') {
        next = { ...next, relation: 'followup' };
      }

      if (goalModeForIntentSafe(next) === 'amend' && taskStateOperations.has(stringValue(next.operation))) {
        const normalizedGoal = normalizeImageAmendmentGoal(next.goal, options);
        if (normalizedGoal !== stringValue(next.goal)) next = { ...next, goal: normalizedGoal };
      }

      // Unknown passive-chat resource keys are protocol errors, not semantic
      // evidence. Remove only those keys; never alter an explicit resource
      // reference or any semantic field to make validation pass.
      if (stringValue(next.operation) === 'plain_chat'
          && Array.isArray(next.resource_refs) && next.resource_refs.length) {
        const known = new Set((Array.isArray(candidateCatalog) ? candidateCatalog : [])
          .map(candidate => candidate?.candidate_key).filter(Boolean));
        const explicitResource = /(?:第\s*[一二两三四五六七八九十0-9]+|上一条|下一条|刚才|之前|历史|引用|这张图|这个文件|这份文件|上述)/i.test(input);
        if (!explicitResource && next.resource_refs.every(ref => !known.has(stringValue(ref?.candidate_key)))) {
          next = { ...next, resource_refs: [] };
        }
      }
      return next;
    }

    return Object.freeze({
      normalizeImageAmendmentGoal,
      reconcileModelIntent,
    });
  }

  const api = Object.freeze({ createRouteSemanticNormalizer });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeSemanticNormalizer', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);