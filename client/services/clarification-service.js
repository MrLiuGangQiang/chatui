(function initChatUIClarificationService(root) {
  'use strict';

  function textOfMessage(message = {}) {
    return String(message.rawText || message.content || '').trim();
  }

  function hasImageAttachment(list = [], isImageFile = () => false) {
    return (list || []).some(item => isImageFile(item) || String(item?.type || item?.file?.type || '').startsWith('image/'));
  }

  function hasAnyAttachment(list = []) {
    return Array.isArray(list) && list.length > 0;
  }

  function isUploadImageClarification(text = '') {
    return /(上传|提供|补充|发送).*(图片|图)|没有可编辑的图片|要修改的图片|请.*图片/i.test(String(text || ''));
  }

  function isClarificationResponse(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    return /((请|需要|麻烦).*(上传|提供|补充|明确|选择)|请.*说明.*(哪|哪个|哪张|哪个文件|哪个附件|要处理什么|想让我怎么)|哪一张|第几张|哪个文件|哪个附件|要处理什么|想让我怎么|没有可编辑的图片|请先上传|请上传|请明确)/i.test(value);
  }

  function isImageEditIntent(text = '') {
    return /(改|修改|换|变成|改成|替换|去掉|去除|删除|加上|添加|背景|风格|漫画|红色|蓝色|黑白|修复|变清晰|抠图|edit|change|replace|remove|background|style)/i.test(String(text || ''));
  }

  function inferPendingKind({ originalText = '', clarificationText = '' } = {}) {
    const combined = `${originalText}\n${clarificationText}`;
    if (isImageEditIntent(combined) || isUploadImageClarification(combined)) return 'image_edit';
    if (/(文件|文档|附件|file|document|pdf|表格|总结|提取)/i.test(combined)) return 'file_qa';
    if (/(第几张|哪一张|这些图|图片|图)/i.test(combined)) return 'image';
    return 'general';
  }

  function expectsSelection(text = '') {
    return /(第几|哪一?张|哪几张|哪一个|哪个|选择|指定.*(编号|序号)|全部|全都)/i.test(String(text || ''));
  }

  function expectsUpload(text = '') {
    return /(上传|提供|补充|发送|引用).*(图片|图|文件|文档|附件)|请先上传|请上传|没有可编辑的图片/i.test(String(text || ''));
  }

  function expectsEditDetail(text = '') {
    return /(改成什么|什么风格|怎么改|如何修改|修改成|具体.*(风格|颜色|背景|效果|要求)|补充.*(风格|颜色|背景|效果|要求))/i.test(String(text || ''));
  }

  function expectsImageVariant(text = '') {
    const value = String(text || '');
    return /(哪一?种|什么样|具体.*(样式|类型|款式|风格|用途)|补充.*(样式|类型|款式|用途)|样式|类型|款式|用途|效果|结构|示意|实物|安装)/i.test(value)
      && /(图|图片|画面|照片|示意|轨道|窗帘|产品|生成)/i.test(value);
  }

  function expectedAnswerTypes({ kind = 'general', originalText = '', clarificationText = '' } = {}) {
    const combined = `${originalText}\n${clarificationText}`;
    const expects = [];
    if (expectsUpload(combined)) expects.push('upload');
    if (expectsSelection(combined)) expects.push('selection');
    if (expectsImageVariant(combined)) expects.push('image_variant');
    if (expectsEditDetail(combined)) expects.push('edit_detail');
    if (kind === 'file_qa' && !expects.includes('upload')) expects.push('file_reference');
    if ((kind === 'image' || kind === 'image_edit') && !expects.length) expects.push('image_detail');
    if (!expects.length) expects.push('confirmation_or_detail');
    return [...new Set(expects)];
  }

  function normalizePendingClarification(value = null) {
    if (!value || typeof value !== 'object') return null;
    const originalText = String(value.originalText || value.original_text || '').trim();
    if (!originalText) return null;
    return {
      id: value.id || `clarify-${Date.now().toString(36)}`,
      kind: value.kind || 'general',
      originalText,
      clarificationText: String(value.clarificationText || value.clarification_text || '').trim(),
      supplements: Array.isArray(value.supplements) ? value.supplements : [],
      expects: Array.isArray(value.expects) && value.expects.length ? value.expects : expectedAnswerTypes({ kind: value.kind || 'general', originalText, clarificationText: value.clarificationText || value.clarification_text || '' }),
      routeInfo: value.routeInfo || value.route_info || null,
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext: value.sourceAttachmentContext || value.source_attachment_context || null,
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
      updatedAt: Number(value.updatedAt || value.updated_at) || Date.now(),
      rounds: Number(value.rounds || 1) || 1,
    };
  }

  function findLastUserBeforeAssistant(messages = [], assistantIndex = messages.length - 1) {
    for (let i = Math.min(assistantIndex - 1, messages.length - 1); i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'user') {
        const text = textOfMessage(message).replace(/\n\s*\[(image|file) id=.*$/is, '').trim();
        if (text) return { text, index: i, message };
      }
    }
    return null;
  }

  function isVagueImageFeedback(text = '') {
    return /^(不是(这个|这样|这种)?|不对|不太对|不满意|不满意[，,\s]*(帮我)?改(一下)?|换一个|重新来|重做|不要这个|不是这个啊|不行)$/i.test(String(text || '').trim());
  }

  function findPreviousImageRequest(messages = [], beforeIndex = messages.length) {
    for (let i = Math.min(beforeIndex - 1, messages.length - 1); i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      const text = textOfMessage(message).replace(/\n\s*\[(image|file) id=.*$/is, '').trim();
      if (!text || isVagueImageFeedback(text)) continue;
      if (/(画|生成|图片|图|海报|头像|插画|logo|图标|照片|示意|产品图|效果图|窗帘|轨道|修改|编辑|改)/i.test(text)) return { text, index: i, message };
    }
    return null;
  }

  function findPreviousImageResultContext(messages = [], beforeIndex = messages.length) {
    for (let i = Math.min(beforeIndex - 1, messages.length - 1); i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      const context = message.imageContext || message.image_context;
      if (context) return context;
    }
    return null;
  }

  const CONTINUATION_SCHEMA_VERSION = 'pending_continuation.v1';
  const CONTINUATION_SYSTEM_PROMPT = `你是 ChatUI 任务延续分类器，只返回 JSON。

你的任务：判断最新用户输入是否在回答/延续一个未完成的追问，并生成 final_prompt。

重要原则：你不是提示词优化器。final_prompt 只做最小语义补全：根据 base_task 和当前回答补齐省略对象或引用。不要添加用户没说的风格、画质、镜头、构图、氛围、细节或创意发挥。尽量保留用户原话。

  必须返回且只能返回以下 schema_version 的完整 JSON；字段不得增删，不得返回 task_contract.v3：
  {"schema_version":"pending_continuation.v1","relation":"pending_answer|revision|continuation|new_task|unclear","confidence":0,"final_prompt":"","final_task_mode":"image|edit_image|chat|file_qa|unknown","selected_indexes":[],"should_merge":false,"should_clear_pending":false,"reason":""}

规则：
  - 只有确信最新输入是在回答 pending.question 时，才可将 relation 设为 pending_answer/revision/continuation，且 should_merge=true。
  - 任何完整的新需求、编号需求列表、与追问无关的请求，都必须 relation=new_task、should_merge=false、should_clear_pending=true。
  - 不确定时按 new_task 处理，绝不能合并旧任务。
  - pending_answer：用户在回答追问。
- revision/continuation：用户在延续或修改 base_task。
- new_task：用户开启无关新任务。
- unclear：信息不足。
- final_prompt 必须是可直接执行的自然请求，不能包含“本轮补充/原始任务”等内部事务文本。
- 如果生成 final_prompt 需要加入 base_task/current_input 都没有的信息，就不要加入。
- 示例：base_task=晚霞图，current_input=山巅的 => final_prompt=山巅的晚霞图。
- 示例：base_task=晚霞图，current_input=不要湖泊 => final_prompt=晚霞图，不要湖泊。`;

  function buildContinuationClassifierPayload({ model, pending, currentInput = '', attachments = [], quoteText = '', recentMessages = [] } = {}) {
    const normalized = normalizePendingClarification(pending);
    return {
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: CONTINUATION_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({
          pending: normalized ? {
            kind: normalized.kind,
            base_task: normalized.originalText,
            question: normalized.clarificationText,
            expects: normalized.expects || [],
            route_info: normalized.routeInfo || null,
            has_source_image: !!normalized.sourceImageContext,
            has_source_attachment: !!normalized.sourceAttachmentContext,
            supplements: normalized.supplements || [],
          } : null,
          contract_schema: CONTINUATION_SCHEMA_VERSION,
          current_input: String(currentInput || '').trim(),
          attachments: (attachments || []).map((item, index) => ({
            index: index + 1,
            name: item?.name || item?.file?.name || '',
            type: item?.type || item?.file?.type || '',
            is_image: /^image\//i.test(String(item?.type || item?.file?.type || '')),
          })),
          quote_text: String(quoteText || '').trim(),
          recent_messages: (recentMessages || []).slice(-6).map((item, index) => ({ index: index + 1, role: item?.role || '', content: textOfMessage(item).slice(0, 500) })),
        }) },
      ],
    };
  }

  function parseContinuationClassifierResult(text = '') {
    const value = String(text || '').trim();
    if (!value) return null;
    try {
      const raw = JSON.parse(value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
      const fields = ['schema_version', 'relation', 'confidence', 'final_prompt', 'final_task_mode', 'selected_indexes', 'should_merge', 'should_clear_pending', 'reason'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(raw, field))) return null;
      if (raw.schema_version !== CONTINUATION_SCHEMA_VERSION) return null;
      const relation = String(raw.relation || '');
      if (!['pending_answer', 'revision', 'continuation', 'new_task', 'unclear'].includes(relation)) return null;
      if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return null;
      if (typeof raw.final_prompt !== 'string' || typeof raw.final_task_mode !== 'string' || typeof raw.should_merge !== 'boolean' || typeof raw.should_clear_pending !== 'boolean' || typeof raw.reason !== 'string') return null;
      if (!['image', 'edit_image', 'chat', 'file_qa', 'unknown'].includes(raw.final_task_mode) || !Array.isArray(raw.selected_indexes) || raw.selected_indexes.some(item => !Number.isInteger(item) || item < 1)) return null;
      const continuation = ['pending_answer', 'revision', 'continuation'].includes(relation);
      if (raw.should_merge !== continuation) return null;
      if (continuation && (!raw.final_prompt.trim() || raw.final_task_mode === 'unknown' || raw.confidence < 0.85)) return null;
      if (!continuation && (raw.final_prompt || raw.final_task_mode !== 'unknown' || raw.selected_indexes.length)) return null;
      return {
        relation,
        confidence: raw.confidence,
        finalPrompt: raw.final_prompt.trim(),
        finalTaskMode: raw.final_task_mode,
        selectedIndexes: raw.selected_indexes,
        shouldMerge: raw.should_merge,
        shouldClearPending: raw.should_clear_pending,
        reason: raw.reason.trim(),
      };
    } catch { return null; }
  }

  function createPendingClarification({ messages = [], clarificationText = '', routeInfo = null, sourceImageContext = null, sourceAttachmentContext = null, sourceQuoteContext = null } = {}) {
    const latestUser = findLastUserBeforeAssistant(messages, messages.length);
    if (!latestUser?.text) return null;
    const routePrompt = String(routeInfo?.contextualImagePrompt || routeInfo?.contextual_image_prompt || routeInfo?.editInstruction || routeInfo?.edit_instruction || '').trim();
    const routeLooksImage = /image|edit|图|图片|生成|修改|编辑/i.test(`${routeInfo?.mode || ''} ${routeInfo?.intent || ''} ${clarificationText}`);
    const previousImageRequest = routeLooksImage && isVagueImageFeedback(latestUser.text)
      ? (routePrompt ? { text: routePrompt, index: latestUser.index, message: latestUser.message } : findPreviousImageRequest(messages, latestUser.index))
      : null;
    const originalText = previousImageRequest?.text || latestUser.text;
    const kind = inferPendingKind({ originalText, clarificationText });
    const previousImageContext = !sourceImageContext && routeLooksImage ? findPreviousImageResultContext(messages, latestUser.index) : null;
    return normalizePendingClarification({
      kind,
      originalText,
      clarificationText,
      expects: expectedAnswerTypes({ kind, originalText, clarificationText }),
      routeInfo: routeInfo ? { mode: routeInfo.mode, target: routeInfo.target, intent: routeInfo.intent } : null,
      sourceImageContext: sourceImageContext || previousImageContext,
      sourceAttachmentContext,
      sourceQuoteContext,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function findPendingFromHistory(messages = []) {
    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role === 'assistant' && isClarificationResponse(textOfMessage(msg))) {
        assistantIndex = i;
        break;
      }
      if (msg?.role === 'assistant' && !isClarificationResponse(textOfMessage(msg))) break;
    }
    if (assistantIndex < 0) return null;
    const clarificationText = textOfMessage(messages[assistantIndex]);
    const latestUser = findLastUserBeforeAssistant(messages, assistantIndex);
    if (!latestUser?.text) return null;
    return normalizePendingClarification({
      kind: inferPendingKind({ originalText: latestUser.text, clarificationText }),
      originalText: latestUser.text,
      clarificationText,
      expects: expectedAnswerTypes({ kind: inferPendingKind({ originalText: latestUser.text, clarificationText }), originalText: latestUser.text, clarificationText }),
      sourceImageContext: latestUser.message?.imageContext || latestUser.message?.image_context || null,
      sourceAttachmentContext: latestUser.message?.attachmentContext || latestUser.message?.attachment_context || null,
      sourceQuoteContext: latestUser.message?.quoteContext || latestUser.message?.quote_context || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function isSelectionAnswer(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    return /^(第?[一二三四五六七八九十\d]+[张个份]?|[一二三四五六七八九十\d]+|全部|全都|都要|都处理|这张|那张|这个|那个|前者|后者|第一张|第二张|第三张|last|latest|previous|all)$/i.test(value)
      || /(第\s*\d+\s*张|第[一二三四五六七八九十]+张|图片?\s*\d+|image\s*\d+)/i.test(value);
  }

  function isShortClarificationPhrase(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/[？?。.!！]/.test(value)) return false;
    if (value.length > 24) return false;
    if (/^(讲讲|介绍|解释|为什么|怎么|如何|多少|今天|天气|新闻|搜索|查询|打开|帮我写|写一篇)/i.test(value)) return false;
    return /^[\p{Script=Han}\w\s\-_/、，,]+$/u.test(value);
  }

  function asksForImageVariant(text = '') {
    return expectsImageVariant(text);
  }

  function isClearlyNewTask(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/^(讲讲|介绍|解释|搜索|查询|打开|帮我写|写一篇|生成一篇|总结一下|翻译一下|计算|对比一下)/i.test(value)) return true;
    if (/^(为什么|怎么|如何|多少|今天|天气|新闻|几点|哪里|谁|什么是)/i.test(value)) return true;
    return false;
  }

  // Pending clarification is a narrow, one-shot state. It must never absorb a
  // complete new request just because the request happens to mention images,
  // diagrams, or generation.
  function isStandaloneTaskRequest(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    if (value.length > 120) return true;

    const numberedItems = value.match(/(?:^|\n)\s*\d{1,3}\s*[、.．)）]/g) || [];
    if (numberedItems.length >= 2) return true;

    const lines = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    if (lines.length >= 3) return true;

    // Short replies such as “第一张” and “红色背景” remain valid answers.
    return value.length > 32
      && /(?:\u54a8\u8be2|\u8bf7|\u5e2e\u6211|\u9700\u8981|\u5e0c\u671b|\u751f\u6210|\u8bbe\u8ba1|\u5206\u6790|\u7f16\u5199|\u603b\u7ed3|\u7ffb\u8bd1)/.test(value);
  }

  function classifyPendingTurn(pending, { promptText = '', attachments = [], quotedMessage = null, isImageFile = () => false } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return { action: 'none', reason: 'no_pending', pending: null };
    const text = String(promptText || '').trim();
    const hasAttachments = hasAnyAttachment(attachments);
    const hasImages = hasImageAttachment(attachments, isImageFile);
    const expects = Array.isArray(normalized.expects) && normalized.expects.length ? normalized.expects : expectedAnswerTypes(normalized);
    if (isStandaloneTaskRequest(text)) return { action: 'clear', reason: 'standalone_new_task', pending: normalized };
    if (hasAttachments) {
      if (expects.includes('upload') || expects.includes('file_reference')) {
        if (normalized.kind === 'image_edit' || normalized.kind === 'image') return { action: hasImages ? 'apply' : 'clear', reason: hasImages ? 'image_upload' : 'wrong_attachment_type', pending: normalized };
        return { action: 'apply', reason: 'attachment_answer', pending: normalized };
      }
      if (normalized.kind === 'image_edit' || normalized.kind === 'image') return { action: hasImages ? 'apply' : 'clear', reason: hasImages ? 'image_attachment_answer' : 'wrong_attachment_type', pending: normalized };
      return { action: 'apply', reason: 'attachment_answer', pending: normalized };
    }
    if (quotedMessage && (expects.includes('upload') || expects.includes('file_reference'))) return { action: 'apply', reason: 'quoted_message', pending: normalized };
    if (!text) return { action: 'clear', reason: 'empty_next_turn', pending: normalized };
    if (isSelectionAnswer(text)) return { action: 'apply', reason: 'selection_answer', pending: normalized };
    if (isClearlyNewTask(text) && !isShortClarificationPhrase(text)) return { action: 'clear', reason: 'new_task', pending: normalized };
    if (expects.includes('image_variant') && isShortClarificationPhrase(text)) return { action: 'apply', reason: 'short_image_variant', pending: normalized };
    if (expects.includes('edit_detail') && (isImageEditIntent(text) || isShortClarificationPhrase(text))) return { action: 'apply', reason: 'edit_detail', pending: normalized };
    if (expects.includes('file_reference')) return /(这个|该|上面|刚才|文件|文档|附件|重点|结论|摘要|页|表|列|行)/i.test(text)
      ? { action: 'apply', reason: 'file_reference_text', pending: normalized }
      : { action: 'clear', reason: 'not_file_answer', pending: normalized };
    if (normalized.kind === 'image_edit' || normalized.kind === 'image') {
      if (/(这张|那张|上面|刚才|原图|图片|图\d*|背景|主体|颜色|风格|保留|去掉|删除|替换|改成|换成|清晰|抠图)/i.test(text)) return { action: 'apply', reason: 'image_context_text', pending: normalized };
      return { action: 'clear', reason: 'not_image_answer', pending: normalized };
    }
    if (/^(是|不是|对|不对|可以|继续|确认|好|就这样|按这个|没错)$/i.test(text) || isShortClarificationPhrase(text)) return { action: 'apply', reason: 'general_detail', pending: normalized };
    return { action: 'clear', reason: 'not_pending_answer', pending: normalized };
  }

  function isLikelyClarificationAnswer(pending, { promptText = '', attachments = [], quotedMessage = null, isImageFile = () => false } = {}) {
    return classifyPendingTurn(pending, { promptText, attachments, quotedMessage, isImageFile }).action === 'apply';
  }

  function shouldApplyPending(pending, { promptText = '', attachments = [], quotedMessage = null, isImageFile = () => false } = {}) {
    // Deliberately fail closed. Continuation is authorized only by a valid
    // pending_continuation.v1 model result, never by local keyword heuristics.
    return false;
  }

  function mergePendingInput(pending, { promptText = '', attachments = [], quotedMessage = null, quoteText = '', finalPrompt = '', finalTaskMode = '', selectedIndexes = [] } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return { promptText, merged: false, pending: null };
    const supplementText = String(promptText || '').trim();
    const modelFinalPrompt = String(finalPrompt || '').trim();
    const parts = modelFinalPrompt ? [modelFinalPrompt] : [normalized.originalText];
    if (!modelFinalPrompt && normalized.supplements?.length) {
      normalized.supplements.forEach((item, index) => {
        const text = String(item?.text || '').trim();
        const notes = [];
        if (item?.attachments) notes.push(`附件 ${item.attachments} 个`);
        if (item?.quoted) notes.push('包含引用消息');
        if (text || notes.length) parts.push(`补充${index + 1}：${[text, notes.join('，')].filter(Boolean).join('；')}`);
      });
    }
    if (!modelFinalPrompt && supplementText) parts.push(`本轮补充：${supplementText}`);
    if (!modelFinalPrompt && quotedMessage) parts.push(`本轮引用：${quoteText || textOfMessage(quotedMessage) || '[quoted_message]'}`);
    if (!modelFinalPrompt && attachments?.length && !supplementText) parts.push(`本轮补充：用户上传了 ${attachments.length} 个附件。`);
    const mergedPrompt = parts.filter(Boolean).join('\n\n');
    return {
      promptText: mergedPrompt,
      originalPromptText: normalized.originalText,
      supplementText,
      finalPrompt: modelFinalPrompt,
      finalTaskMode: String(finalTaskMode || '').trim(),
      selectedIndexes: Array.isArray(selectedIndexes) ? selectedIndexes : [],
      merged: true,
      pending: {
        ...normalized,
        supplements: [
          ...(normalized.supplements || []),
          { text: supplementText, attachments: attachments?.length || 0, quoted: !!quotedMessage, at: Date.now() },
        ],
        updatedAt: Date.now(),
        rounds: (normalized.rounds || 1) + 1,
      },
    };
  }

  function clearPendingIfResolved(routeInfo = {}) {
    return !routeInfo?.needClarification;
  }

  const api = Object.freeze({
    CONTINUATION_SCHEMA_VERSION,
    CONTINUATION_SYSTEM_PROMPT,
    buildContinuationClassifierPayload,
    parseContinuationClassifierResult,
    findPreviousImageResultContext,
    isClarificationResponse,
    isUploadImageClarification,
    isImageEditIntent,
    inferPendingKind,
    expectedAnswerTypes,
    normalizePendingClarification,
    createPendingClarification,
    findPendingFromHistory,
    findPreviousImageRequest,
    isVagueImageFeedback,
    mergePendingInput,
    clearPendingIfResolved,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIClarificationService = api;
  if (root?.window) root.window.ChatUIClarificationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
