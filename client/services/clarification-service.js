(function initChatUIClarificationService(root) {
  'use strict';

  const CONTINUATION_SCHEMA_VERSION = 'pending_continuation.v5';
  const CLARIFICATION_CONTEXT_VERSION = 'clarification_context.v1';
  const CLARIFICATION_REPLAY_VERSION = 'clarification_replay.v1';
  const CONTINUATION_RELATIONS = Object.freeze([
    'pending_answer',
    'partial_answer',
    'revision',
    'continuation',
    'pending_assistance',
    'new_task',
    'unclear',
  ]);
  const MERGE_RELATIONS = new Set(['pending_answer', 'partial_answer', 'revision', 'continuation']);
  const RESOLVED_INPUT_DESCRIPTION = '可交给完整路由器重新检查的自然请求；partial_answer 可以保留尚未补齐的信息。若 selections 非空，只移除仅用于外部候选定位的编号、顺序、文件名、标签或左右位置词；必须保留 pending.base_task 和 current_input 中用户已经表达的对象、属性、动作、数值、颜色及约束，不得把具体对象泛化成“当前图片/当前文件”。';

  function strictObject(properties) {
    return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
  }

  const CONTINUATION_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_pending_continuation_v5',
      strict: true,
      schema: strictObject({
        schema_version: { type: 'string', const: CONTINUATION_SCHEMA_VERSION },
        relation: { type: 'string', enum: CONTINUATION_RELATIONS },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        resolved_input: { type: 'string', description: RESOLVED_INPUT_DESCRIPTION },
        selections: {
          type: 'array',
          items: strictObject({
            resource_key: { type: 'string', pattern: '^r[1-9][0-9]*$' },
            choice_key: { type: 'string', pattern: '^c[1-9][0-9]*$' },
          }),
        },
        should_merge: { type: 'boolean' },
        should_clear_pending: { type: 'boolean' },
        assistant_reply: { type: 'string' },
        reason: { type: 'string' },
      }),
    },
  });

  const CONTINUATION_SYSTEM_PROMPT = `你是 ChatUI 的未完成追问关系分类器。只返回严格的 pending_continuation.v5 JSON；不回答原任务，不返回 task_contract，不决定任何执行路线。

你的唯一职责：判断 current_input 是否在回答 pending.question，并在确实延续时给出最小语义补全后的 resolved_input。operation、API、mode、图片/文件角色、资源 source、资源数量和是否可执行，全部由后续完整任务路由器重新决定；你无权决定或暗示这些字段。

唯一结构：
{"schema_version":"pending_continuation.v5","relation":"pending_answer|partial_answer|revision|continuation|pending_assistance|new_task|unclear","confidence":0,"resolved_input":"","selections":[{"resource_key":"r2","choice_key":"c1"}],"should_merge":false,"should_clear_pending":false,"assistant_reply":"","reason":""}

状态规则：
1. pending_answer：直接且完整回答追问；partial_answer：明确回答了组合追问中的至少一项，但仍有其他必填项未回答；revision：修改未完成任务；continuation：补充未完成任务。这四类仅在置信度至少 0.85 时允许 should_merge=true、should_clear_pending=true，且 resolved_input 必须是可交给后续路由器重新识别的自然请求。partial_answer 不是失败：后续完整路由器会保留已回答内容并继续追问剩余项。
2. pending_assistance：用户没有回答追问，而是在当前追问中请求候选、示例或解释。此时 should_merge=false、should_clear_pending=false、resolved_input=""、selections=[]，assistant_reply 给出直接有用且不替用户做决定的简短帮助。不得把已经明确选择候选或补充某项信息的回复误判为 pending_assistance。
3. new_task：与追问无关的完整新任务，包括同时提出多个独立目标。unclear：无法可靠判断。二者都必须 should_merge=false、should_clear_pending=true、resolved_input=""、selections=[]、assistant_reply=""。不确定时使用 new_task 或 unclear，绝不合并旧任务。
4. resolved_input 只能合并 pending.base_task、current_input、显式 quote_text 和已记录 supplements 中用户已经表达的信息；不得加入风格、画质、镜头、构图、对象、约束或操作类型等未表达内容，不得出现“本轮补充”“原始任务”“追问来源”等内部事务措辞。若本轮只是回答 ambiguous 资源选择，应用会以 pending.base_task 作为执行语义权威，resolved_input 无权覆盖它。
5. prior_task_contract 只用于理解追问和校验显式选择，不能沿用其 operation 或把它改成 ready。对 ambiguous 槽，只有用户明确选择时才从原 choices 原样返回 resource_key/choice_key；不得猜测，不得返回未知 key。partial_answer 只返回本轮已经回答的 choices，不要求替用户补齐其他 ambiguous 槽。对 missing 槽不返回 selection，由后续路由器重新检查是否仍缺少信息。
6. 如果用户新增、替换或同时上传多个附件，只描述用户明确表达的任务，不判断附件角色，也不把附件数量解释成选择。附件是否满足任务由后续完整路由器决定。
7. 编号、中文序数、候选标签、文件名、左右位置及自然描述都可能是有效选择表达；必须结合 choices 判断，不得只识别固定格式。例如组合追问要求“选猫图并说明姿势”时，current_input="2"、"第二张"、"右边那只猫"或"选候选图二"若都明确指向 c2，均返回 partial_answer、对应 selection，并以 pending.base_task 作为 resolved_input；current_input="第二张，让它趴着"若同时补齐两项，则返回 pending_answer、对应 selection，并把“趴着”合入 resolved_input。
8. 输出字段必须完整且不得增删。reason 只写一行分类依据。`;
  const CONTINUATION_SINGLE_IMAGE_GUIDANCE = `图片 target 的 ambiguous 槽一次只能选择一个 choice。用户回答“全部”“都要”或同时指定多个编号时，不得返回 selection，也不得合并执行；返回 pending_assistance，assistant_reply 明确说明一次只能选择一张图片并请用户回复一个编号。

资源选择与执行指令必须正交：编号、顺序、候选标签、文件名以及“左边/右边那张”等仅用于回答候选选择问题时，只能体现在 selections 中，绝不能继续出现在 resolved_input 里，否则图片模型可能把它误解为图片内部区域。但这类定位词之外的原始语义绝不能丢失：必须保留 pending.base_task 和 current_input 中用户已经表达的对象、部位、属性、动作、数值、颜色及约束；“猫”“猫的颜色”是编辑对象/属性，不是候选定位词，不能改写成泛化的“当前图片”。如果用户只是回答候选编号，resolved_input 应以原始任务为主。例如 pending.base_task="把猫的颜色换成红色"、current_input="第二张图" 且选择第二个 choice 时，必须输出 resolved_input="把猫的颜色换成红色"；如果 current_input="第二张图改成红色"，也必须输出 resolved_input="把猫的颜色换成红色"，不能输出“把当前图片换成红色”或“把第二张图改成红色”。`;
  const CONTINUATION_REPAIR_PROMPT = '上一条输出未通过 pending_continuation.v5 严格校验。请依据最初提供的 pending、current_input 与 choices 重新分类；特别检查 partial_answer、selections、resolved_input 和所有必填字段。只返回一个符合 schema 的 JSON 对象。';

  function textOfMessage(message = {}) {
    return String(message.rawText || message.content || '').trim();
  }

  function latestUserMessage(messages = []) {
    for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'user') return { message, index, text: textOfMessage(message) };
    }
    return null;
  }

  function compactRouteInfo(routeInfo = null) {
    if (!routeInfo || typeof routeInfo !== 'object' || Array.isArray(routeInfo)) return null;
    const contractSlots = routeInfo.taskContract?.clarification?.unresolved_resources;
    return {
      mode: String(routeInfo.mode || ''),
      api: String(routeInfo.api || ''),
      operationType: String(routeInfo.operationType || routeInfo.operation_type || ''),
      relation: String(routeInfo.relation || ''),
      readiness: String(routeInfo.readiness || ''),
      needClarification: routeInfo.needClarification === true,
      clarificationQuestion: String(routeInfo.clarificationQuestion || ''),
      clarificationSlots: Array.isArray(routeInfo.clarificationSlots)
        ? routeInfo.clarificationSlots
        : Array.isArray(contractSlots) ? contractSlots : [],
      taskContract: routeInfo.taskContract && typeof routeInfo.taskContract === 'object'
        ? routeInfo.taskContract
        : null,
      clarificationDegraded: routeInfo.clarificationDegraded === true,
      requiresRerouteAfterClarification: routeInfo.requiresRerouteAfterClarification === true,
    };
  }

  function pendingClarificationRouteInfo(value = null) {
    const pending = normalizePendingClarification(value);
    if (!pending) return null;
    const routeInfo = pending.routeInfo || {};
    const contractSlots = routeInfo.taskContract?.clarification?.unresolved_resources;
    return {
      ...routeInfo,
      needClarification: true,
      clarificationQuestion: pending.clarificationText
        || routeInfo.clarificationQuestion
        || routeInfo.taskContract?.clarification?.question
        || '',
      clarificationSlots: Array.isArray(routeInfo.clarificationSlots) && routeInfo.clarificationSlots.length
        ? routeInfo.clarificationSlots
        : Array.isArray(contractSlots) ? contractSlots : [],
    };
  }

  function matchesPendingClarificationMessage(value = null, { message = null, userText = '' } = {}) {
    const pending = normalizePendingClarification(value);
    if (!pending || !message || message.role !== 'assistant') return false;
    const messageClarificationId = String(message.clarificationId || message.clarification_id || '').trim();
    if (messageClarificationId) return messageClarificationId === pending.id;
    const messageText = textOfMessage(message);
    return !!messageText
      && messageText === pending.clarificationText
      && String(userText || '').trim() === pending.originalText;
  }

  function normalizePendingClarification(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const originalText = String(value.originalText ?? value.original_text ?? value.baseTask ?? value.base_task ?? '').trim();
    const routeInfo = compactRouteInfo(value.routeInfo || value.route_info || null);
    if (!originalText && !routeInfo?.taskContract) return null;
    return {
      id: String(value.id || `clarify-${Date.now().toString(36)}`),
      originalText,
      baseTaskText: String(value.baseTaskText || value.base_task_text || originalText).trim(),
      clarificationText: String(value.clarificationText || value.clarification_text || '').trim(),
      routeInfo,
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext: value.sourceAttachmentContext || value.source_attachment_context || null,
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      assistanceHistory: Array.isArray(value.assistanceHistory || value.assistance_history)
        ? (value.assistanceHistory || value.assistance_history).slice(-4)
        : [],
      supplements: Array.isArray(value.supplements)
        ? value.supplements.map(item => String(item || '').trim()).filter(Boolean).slice(-8)
        : [],
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
      updatedAt: Number(value.updatedAt || value.updated_at) || Date.now(),
      rounds: Math.max(1, Number(value.rounds || 1) || 1),
    };
  }

  function createPendingClarification({
    messages = [],
    clarificationText = '',
    routeInfo = null,
    sourceImageContext = null,
    sourceAttachmentContext = null,
    sourceQuoteContext = null,
  } = {}) {
    const latestUser = latestUserMessage(messages);
    return normalizePendingClarification({
      originalText: latestUser?.text || '',
      baseTaskText: latestUser?.text || '',
      clarificationText,
      routeInfo,
      sourceImageContext: sourceImageContext || latestUser?.message?.imageContext || latestUser?.message?.image_context || null,
      sourceAttachmentContext: sourceAttachmentContext || latestUser?.message?.attachmentContext || latestUser?.message?.attachment_context || null,
      sourceQuoteContext: sourceQuoteContext || latestUser?.message?.quoteContext || latestUser?.message?.quote_context || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function attachmentSummary(item = {}, index = 0, source = 'current') {
    const type = String(item?.type || item?.mime || item?.file?.type || '').trim();
    const isImage = item?.is_image === true || item?.isImage === true || type.startsWith('image/');
    return {
      index: index + 1,
      source,
      id: String(isImage
        ? item?.image_id || item?.imageId || item?.attachmentId || item?.attachment_id || item?.id || ''
        : item?.file_id || item?.fileId || item?.attachmentId || item?.attachment_id || item?.id || ''),
      name: String(item?.name || item?.filename || item?.file?.name || ''),
      type,
      is_image: isImage,
    };
  }

  function buildContinuationClassifierPayload({
    model,
    pending,
    currentInput = '',
    attachments = [],
    quoteText = '',
    recentMessages = [],
  } = {}) {
    const normalized = normalizePendingClarification(pending);
    return {
      model,
      temperature: 0,
      response_format: CONTINUATION_RESPONSE_FORMAT,
      messages: [
        { role: 'system', content: `${CONTINUATION_SYSTEM_PROMPT}\n\n${CONTINUATION_SINGLE_IMAGE_GUIDANCE}` },
        { role: 'user', content: JSON.stringify({
          contract_schema: CONTINUATION_SCHEMA_VERSION,
          pending: normalized ? {
            base_task: normalized.originalText,
            question: normalized.clarificationText,
            prior_task_contract: normalized.routeInfo?.taskContract || null,
            has_source_image: !!normalized.sourceImageContext,
            has_source_attachment: !!normalized.sourceAttachmentContext,
            has_source_quote: !!normalized.sourceQuoteContext,
            assistance_history: normalized.assistanceHistory,
          } : null,
          current_input: String(currentInput || '').trim(),
          attachments: (Array.isArray(attachments) ? attachments : []).map((item, index) => attachmentSummary(item, index, 'current')),
          quote_text: String(quoteText || '').trim(),
          recent_messages: (Array.isArray(recentMessages) ? recentMessages : []).slice(-6).map((item, index) => ({
            index: index + 1,
            role: String(item?.role || ''),
            content: textOfMessage(item).slice(0, 800),
          })),
        }) },
      ],
    };
  }

  function hasExactFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function validSelectionList(selections = []) {
    if (!Array.isArray(selections)) return false;
    const resourceKeys = new Set();
    for (const selection of selections) {
      if (!hasExactFields(selection, ['resource_key', 'choice_key'])) return false;
      if (!/^r[1-9][0-9]*$/.test(String(selection.resource_key || ''))
          || !/^c[1-9][0-9]*$/.test(String(selection.choice_key || ''))
          || resourceKeys.has(selection.resource_key)) return false;
      resourceKeys.add(selection.resource_key);
    }
    return true;
  }

  function selectionsMatchPending(pending, selections = [], { allowPartial = false } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return selections.length === 0;
    const unresolved = normalized.routeInfo?.taskContract?.clarification?.unresolved_resources;
    if (!Array.isArray(unresolved) || !unresolved.length) return selections.length === 0;
    const ambiguous = unresolved.filter(slot => slot?.reason === 'ambiguous');
    if (allowPartial) {
      if (selections.length > ambiguous.length) return false;
    } else if (selections.length !== ambiguous.length) return false;
    const selected = new Map(selections.map(item => [item.resource_key, item.choice_key]));
    const slotsToValidate = allowPartial
      ? ambiguous.filter(slot => selected.has(slot.key))
      : ambiguous;
    return slotsToValidate.length === selections.length && slotsToValidate.every(slot => {
      const choiceKey = selected.get(slot.key);
      return !!choiceKey && Array.isArray(slot.choices) && slot.choices.some(choice => choice?.key === choiceKey);
    });
  }

  function isPureResourceSelectionAnswer(pending, relation = '', selections = []) {
    if (relation !== 'pending_answer') return false;
    const normalized = normalizePendingClarification(pending);
    const unresolved = normalized?.routeInfo?.taskContract?.clarification?.unresolved_resources;
    return !!normalized?.originalText
      && Array.isArray(unresolved)
      && unresolved.length > 0
      && unresolved.every(slot => slot?.reason === 'ambiguous' && slot?.type !== 'text')
      && selectionsMatchPending(normalized, selections);
  }

  function parseContinuationClassifierResult(text = '', options = {}) {
    const value = String(text || '').trim();
    if (!value) return null;
    try {
      const raw = JSON.parse(value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
      const fields = [
        'schema_version', 'relation', 'confidence', 'resolved_input', 'selections',
        'should_merge', 'should_clear_pending', 'assistant_reply', 'reason',
      ];
      if (!hasExactFields(raw, fields) || raw.schema_version !== CONTINUATION_SCHEMA_VERSION) return null;
      const relation = String(raw.relation || '');
      if (!CONTINUATION_RELATIONS.includes(relation)
          || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1
          || typeof raw.resolved_input !== 'string'
          || typeof raw.should_merge !== 'boolean'
          || typeof raw.should_clear_pending !== 'boolean'
          || typeof raw.assistant_reply !== 'string'
          || typeof raw.reason !== 'string'
          || !validSelectionList(raw.selections)) return null;

      const resolvedInput = raw.resolved_input.trim();
      const assistantReply = raw.assistant_reply.trim();
      const merging = MERGE_RELATIONS.has(relation);
      const partialAnswer = relation === 'partial_answer';
      const assistance = relation === 'pending_assistance';
      if (merging && (raw.confidence < 0.85 || raw.should_merge !== true || raw.should_clear_pending !== true || !resolvedInput || assistantReply)) return null;
      if (assistance && (raw.should_merge || raw.should_clear_pending || resolvedInput || raw.selections.length || !assistantReply)) return null;
      if (!merging && !assistance && (raw.should_merge || raw.should_clear_pending !== true || resolvedInput || raw.selections.length || assistantReply)) return null;
      if (merging && options.pending && !selectionsMatchPending(options.pending, raw.selections, { allowPartial: partialAnswer })) return null;

      const canonicalResolvedInput = isPureResourceSelectionAnswer(options.pending, relation, raw.selections)
        ? normalizePendingClarification(options.pending)?.originalText || resolvedInput
        : resolvedInput;
      return Object.freeze({
        relation,
        confidence: raw.confidence,
        resolvedInput: canonicalResolvedInput,
        selections: raw.selections.map(item => Object.freeze({ resource_key: item.resource_key, choice_key: item.choice_key })),
        shouldMerge: raw.should_merge,
        shouldClearPending: raw.should_clear_pending,
        assistantReply,
        reason: raw.reason.trim(),
      });
    } catch {
      return null;
    }
  }

  function buildContinuationRepairPayload(payload = null, rejectedText = '') {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) return null;
    return {
      ...payload,
      messages: [
        ...payload.messages,
        { role: 'assistant', content: String(rejectedText || '').slice(0, 4000) },
        { role: 'user', content: CONTINUATION_REPAIR_PROMPT },
      ],
    };
  }

  function mergePendingInput(pending, { promptText = '', resolvedInput = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    const resolved = String(resolvedInput || '').trim();
    if (!normalized || !resolved) return { promptText: String(promptText || '').trim(), merged: false, pending: normalized };
    return {
      promptText: resolved,
      originalPromptText: normalized.originalText,
      supplementText: String(promptText || '').trim(),
      resolvedInput: resolved,
      merged: true,
      pending: normalizePendingClarification({
        ...normalized,
        originalText: resolved,
        baseTaskText: normalized.baseTaskText || normalized.originalText,
        supplements: [...normalized.supplements, String(promptText || '').trim()].filter(Boolean).slice(-8),
        updatedAt: Date.now(),
        rounds: normalized.rounds + 1,
      }),
    };
  }

  function normalizeClarificationReplay(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resolvedInput = String(value.resolvedInput || value.resolved_input || '').trim();
    if (!resolvedInput) return null;
    return {
      schemaVersion: CLARIFICATION_REPLAY_VERSION,
      originalInput: String(value.originalInput || value.original_input || value.baseTaskText || value.base_task_text || resolvedInput).trim(),
      resolvedInput,
      supplements: Array.isArray(value.supplements)
        ? value.supplements.map(item => String(item || '').trim()).filter(Boolean).slice(-8)
        : [],
      clarificationRouteContext: value.clarificationRouteContext || value.clarification_route_context || null,
      taskContract: value.taskContract && typeof value.taskContract === 'object' ? value.taskContract : null,
      routeMode: String(value.routeMode || value.route_mode || ''),
      api: String(value.api || ''),
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext: value.sourceAttachmentContext || value.source_attachment_context || null,
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
    };
  }

  function createClarificationReplay({ pending = null, merge = null, routeInfo = null, clarificationRouteContext = null } = {}) {
    const normalized = normalizePendingClarification(pending);
    const resolvedInput = String(merge?.resolvedInput || merge?.promptText || '').trim();
    if (!normalized || !resolvedInput) return null;
    return normalizeClarificationReplay({
      originalInput: normalized.baseTaskText || normalized.originalText,
      resolvedInput,
      supplements: merge?.pending?.supplements || normalized.supplements,
      clarificationRouteContext,
      taskContract: routeInfo?.taskContract || null,
      routeMode: routeInfo?.mode || '',
      api: routeInfo?.api || '',
      sourceImageContext: normalized.sourceImageContext,
      sourceAttachmentContext: normalized.sourceAttachmentContext,
      sourceQuoteContext: normalized.sourceQuoteContext,
      createdAt: Date.now(),
    });
  }

  function reviseClarificationReplay(replay, replacement = '') {
    const normalized = normalizeClarificationReplay(replay);
    const next = String(replacement || '').trim();
    if (!normalized || !next) return normalized;
    const supplements = normalized.supplements.length
      ? [...normalized.supplements.slice(0, -1), next]
      : [next];
    return normalizeClarificationReplay({
      ...normalized,
      supplements,
      // This is deliberately plain user text. The complete router still decides execution.
      resolvedInput: [normalized.originalInput, ...supplements].filter(Boolean).join('\n\n'),
      createdAt: Date.now(),
    });
  }

  function retainPendingAfterAssistance(pending, { promptText = '', assistantReply = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    const reply = String(assistantReply || '').trim();
    if (!normalized || !reply) return null;
    return normalizePendingClarification({
      ...normalized,
      assistanceHistory: [
        ...normalized.assistanceHistory,
        { prompt: String(promptText || '').trim(), reply, at: Date.now() },
      ].slice(-4),
      updatedAt: Date.now(),
      rounds: normalized.rounds + 1,
    });
  }

  function selectedChoiceDetails(pending, selections = []) {
    const unresolved = pending?.routeInfo?.taskContract?.clarification?.unresolved_resources;
    if (!Array.isArray(unresolved)) return [];
    return selections.map(selection => {
      const slot = unresolved.find(item => item?.key === selection.resource_key);
      const choice = slot?.choices?.find(item => item?.key === selection.choice_key);
      return {
        resource_key: selection.resource_key,
        choice_key: selection.choice_key,
        type: String(slot?.type || ''),
        role: String(slot?.role || ''),
        source: String(choice?.source || ''),
        index: Number(choice?.index) || 0,
        id: String(choice?.id || ''),
        reference_id: String(choice?.reference_id || ''),
        label: String(choice?.label || ''),
      };
    });
  }

  function candidateIdentity(candidate = {}, type = '') {
    const id = type === 'image'
      ? candidate.image_id || candidate.imageId || ''
      : candidate.file_id || candidate.fileId || candidate.id || '';
    return [candidate.source || '', id, candidate.reference_id || candidate.referenceId || '', candidate.source_index || candidate.sourceIndex || ''].join('|');
  }

  function mergeCandidates(base = [], quoted = [], type = '') {
    const result = [];
    const seen = new Set();
    for (const candidate of [...(Array.isArray(base) ? base : []), ...(Array.isArray(quoted) ? quoted : [])]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const identity = candidateIdentity(candidate, type);
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      result.push({ ...candidate, index: result.length + 1 });
    }
    return result;
  }

  function mergeQuotedMessageContext(baseContext = {}, quotedContext = null) {
    const context = { ...baseContext };
    if (!quotedContext || typeof quotedContext !== 'object') return context;
    const recent = Array.isArray(context.recent_messages) ? [...context.recent_messages] : [];
    const quote = quotedContext.quoted_message && typeof quotedContext.quoted_message === 'object'
      ? quotedContext.quoted_message
      : null;
    if (quote) {
      const quoteId = String(quote.id || quote.display_item_id || quote.displayItemId || '');
      let match = quoteId ? recent.find(message => String(message?.id || message?.display_item_id || message?.displayItemId || '') === quoteId) : null;
      if (!match) {
        const quotedMessage = Array.isArray(quotedContext.recent_messages) ? quotedContext.recent_messages[0] : null;
        if (quotedMessage) {
          const nextIndex = recent.reduce((max, message) => Math.max(max, Number(message?.index) || 0), 0) + 1;
          match = { ...quotedMessage, index: nextIndex, ...(quoteId ? { id: quoteId } : {}) };
          recent.push(match);
        }
      }
      if (match) context.quoted_message = { ...quote, index: Number(match.index), ...(quoteId ? { id: quoteId } : {}) };
    }
    context.recent_messages = recent;
    context.image_candidates = mergeCandidates(context.image_candidates, quotedContext.image_candidates, 'image');
    context.file_candidates = mergeCandidates(context.file_candidates, quotedContext.file_candidates, 'file');
    return context;
  }

  function priorResourceSources(taskContract = null) {
    if (!taskContract || typeof taskContract !== 'object') return [];
    const bound = Array.isArray(taskContract.resources) ? taskContract.resources : [];
    const unresolved = Array.isArray(taskContract.clarification?.unresolved_resources)
      ? taskContract.clarification.unresolved_resources
      : [];
    return [
      ...bound.map(resource => ({
        resource_key: String(resource?.key || ''), type: String(resource?.type || ''), role: String(resource?.role || ''),
        source: String(resource?.source || ''), id: String(resource?.id || ''), reference_id: String(resource?.reference_id || ''),
      })),
      ...unresolved.flatMap(slot => (Array.isArray(slot?.choices) ? slot.choices : []).map(choice => ({
        resource_key: String(slot?.key || ''), type: String(slot?.type || ''), role: String(slot?.role || ''),
        source: String(choice?.source || ''), id: String(choice?.id || ''), reference_id: String(choice?.reference_id || ''),
      }))),
    ];
  }

  function buildClarificationRouteContext({
    baseContext = {},
    quotedContext = null,
    pending,
    currentInput = '',
    resolvedInput = '',
    continuationRelation = '',
    selections = [],
    attachments = [],
    quoteText = '',
  } = {}) {
    const normalized = normalizePendingClarification(pending);
    const resolved = String(resolvedInput || '').trim();
    if (!normalized || !resolved || !selectionsMatchPending(normalized, selections)) return null;
    const context = mergeQuotedMessageContext(baseContext && typeof baseContext === 'object' ? baseContext : {}, quotedContext);
    const quotedMedia = [
      ...(Array.isArray(context.image_candidates) ? context.image_candidates.filter(item => item?.source === 'quoted') : []),
      ...(Array.isArray(context.file_candidates) ? context.file_candidates.filter(item => item?.source === 'quoted') : []),
    ];
    context.clarification_context = {
      schema_version: CLARIFICATION_CONTEXT_VERSION,
      base_task: normalized.originalText,
      clarification_question: normalized.clarificationText,
      prior_task_contract: normalized.routeInfo?.taskContract || null,
      current_answer: String(currentInput || '').trim(),
      resolved_input: resolved,
      continuation_relation: String(continuationRelation || ''),
      selected_choices: selectedChoiceDetails(normalized, selections),
      explicit_quote_text: String(quoteText || '').trim(),
      attachments: {
        current: (Array.isArray(attachments) ? attachments : []).map((item, index) => attachmentSummary(item, index, 'current')),
        quoted: quotedMedia.map((item, index) => ({
          index: Number(item?.index) || index + 1,
          source: 'quoted',
          id: String(item?.image_id || item?.file_id || item?.id || ''),
          reference_id: String(item?.reference_id || ''),
          name: String(item?.filename || item?.name || ''),
        })),
        prior_sources: priorResourceSources(normalized.routeInfo?.taskContract),
      },
      source_policy: 'Only this turn attachments are current. Earlier pending resources remain history/context; explicit UI quote resources are quoted. Re-run the complete router before execution.',
    };
    return context;
  }

  const api = Object.freeze({
    CONTINUATION_SCHEMA_VERSION,
    CLARIFICATION_CONTEXT_VERSION,
    CLARIFICATION_REPLAY_VERSION,
    CONTINUATION_SYSTEM_PROMPT,
    CONTINUATION_RESPONSE_FORMAT,
    buildContinuationClassifierPayload,
    buildContinuationRepairPayload,
    parseContinuationClassifierResult,
    normalizePendingClarification,
    createPendingClarification,
    pendingClarificationRouteInfo,
    matchesPendingClarificationMessage,
    mergePendingInput,
    retainPendingAfterAssistance,
    normalizeClarificationReplay,
    createClarificationReplay,
    reviseClarificationReplay,
    buildClarificationRouteContext,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIClarificationService = api;
  if (root?.window) root.window.ChatUIClarificationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
