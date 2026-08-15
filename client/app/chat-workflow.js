(function initChatUIAppChatWorkflow(root) {
  // Intentionally not strict: sendChat body is migrated from app.js and resolved through a deps scope.

  const dispatchContractContract = root?.[Symbol.for('chatui.module-registry.v1')]?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});
  const resourceIdentityContract = root?.[Symbol.for('chatui.module-registry.v1')]?.get('resourceIdentity')
    || root?.ChatUICore?.resourceIdentity
    || (typeof require === 'function' ? require('../core/resource-identity') : {});
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});

  function shouldRetryStreamFailure({ requestAccepted = false, answerStarted = false } = {}) {
    return !requestAccepted && !answerStarted;
  }


  const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const OCR_EXECUTION_CONTEXT = '本轮执行逐字 OCR：只报告图片中实际可见的文字，不按颜色、图标主题或语义猜词；图片前的资源标记用于保持原始序号，不要按筛选后的图片顺序重新编号；无法确认时明确说明。';

  function captureReasoningRequestSettings(session = {}, state = {}) {
    const hasSessionMode = session?.reasoningMode !== undefined && session?.reasoningMode !== null;
    const enabled = hasSessionMode ? !!session.reasoningMode : !!state.reasoningMode;
    const sessionEffort = String(session?.reasoningType || '').trim().toLowerCase();
    const stateEffort = String(state?.reasoningType || '').trim().toLowerCase();
    const effort = REASONING_EFFORTS.has(sessionEffort)
      ? sessionEffort
      : REASONING_EFFORTS.has(stateEffort) ? stateEffort : 'medium';
    return Object.freeze({ enabled, effort: enabled ? effort : 'none' });
  }

  function createChatWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const ensureChatAttachmentImageDataUrls = deps.ensureChatAttachmentImageDataUrls || (async list => list || []);
    const chatService = root?.ChatUIServices?.chat || root?.ChatUIChatService || {};
    const messagesHaveInputFiles = deps.messagesHaveInputFiles || chatService.messagesHaveInputFiles || (() => false);
    const reportExecutionRejection = deps.reportExecutionRejection || chatService.reportExecutionRejection;

    function requireChatExecutionContract(options = {}) {
      const plan = options.dispatchContract;
      if (typeof dispatchContractContract?.hasExactDispatchContract !== 'function'
          || !dispatchContractContract.hasExactDispatchContract(plan)
          || plan.api !== 'chat') {
        const error = new TypeError('A validated chat dispatch_contract.v1 is required before dispatch');
        error.code = 'CHAT_DISPATCH_CONTRACT_REQUIRED';
        error.statusCode = 400;
        throw error;
      }
      const evidence = Array.isArray(options.bindingEvidence)
        ? options.bindingEvidence
        : typeof dispatchContractContract.bindingEvidenceFromMedia === 'function'
          ? dispatchContractContract.bindingEvidenceFromMedia(options.executionMedia || {})
          : [];
      dispatchContractContract.assertBindingEvidence?.(plan, evidence);
      return Object.freeze({ plan, evidence });
    }

    async function prepareChatAttachments(list = [], options = {}) {
      if (typeof deps.prepareChatAttachments === 'function') return deps.prepareChatAttachments(list, options);
      const workflow = root?.getAttachmentWorkflow?.();
      if (typeof workflow?.prepareChatAttachments === 'function') return workflow.prepareChatAttachments(list, options);
      return ensureChatAttachmentImageDataUrls(list);
    }

    function normalizeSystemContext(value) {
      return (Array.isArray(value) ? value : [value])
        .map(item => String(item || '').trim())
        .filter(Boolean);
    }

    function contextStringValue(value = '') {
      return String(value ?? '').trim();
    }

    function messageIdentityProjection(message = {}) {
      const messageId = typeof resourceIdentityContract?.nativeIdentity === 'function'
        ? contextStringValue(resourceIdentityContract.nativeIdentity(message, 'message'))
        : contextStringValue(
          message.message_id || message.messageId || message.display_item_id || message.displayItemId || message.id,
        );
      const declaredResourceId = contextStringValue(
        message.resource_id || message.resourceId || message.route_resource_id || message.routeResourceId,
      );
      const canonicalResourceId = typeof resourceIdentityContract?.canonicalResourceId === 'function'
        ? contextStringValue(resourceIdentityContract.canonicalResourceId('message', message))
        : '';
      const resourceId = canonicalResourceId
        || declaredResourceId
        || (messageId ? `res:message:${encodeURIComponent(messageId)}` : '');
      const aliases = typeof resourceIdentityContract?.identityTokens === 'function'
        ? resourceIdentityContract.identityTokens(message, 'message').map(contextStringValue).filter(Boolean)
        : [];
      return Object.freeze({ messageId, resourceId, aliases });
    }

    function applyExecutionContextPolicy(messages = [], {
      dispatchContract: plan = null,
      bindingEvidence = [],
      submissionId = '',
      jobId = '',
      requestPurpose = 'final_execution',
    } = {}) {
      const list = Array.isArray(messages) ? messages : [];
      if (!plan || typeof plan !== 'object' || plan.api !== 'chat') return list;
      if (typeof dispatchContractContract?.hasExactDispatchContract !== 'function'
          || !dispatchContractContract.hasExactDispatchContract(plan)) return list;
      const policy = plan.context_policy || {};
      const messageBindings = (Array.isArray(plan.bindings) ? plan.bindings : [])
        .filter(binding => String(binding?.type) === 'message');
      if (!messageBindings.length && policy.history === 'conversation') return list;
      const expectedIds = [...new Set(messageBindings
        .map(binding => contextStringValue(binding.resource_id))
        .filter(Boolean))];
      const normalizedId = value => contextStringValue(value).replace(/^res:message:/i, '');
      const matches = (message = {}, resourceId = '') => {
        const identity = messageIdentityProjection(message);
        const candidates = [...new Set([
          identity.resourceId,
          identity.messageId,
          ...identity.aliases,
        ].filter(Boolean))];
        return candidates.some(candidate => (
          candidate === resourceId
          || normalizedId(candidate) === normalizedId(resourceId)
        ));
      };
      const bound = list.filter(message => expectedIds.some(id => matches(message, id)));
      if (policy.quoted === true) {
        const quoted = list.find(message => /<quoted_message(?:\s|>)/i.test(contextStringValue(message.content || message.rawText)));
        if (quoted && !bound.includes(quoted)) bound.push(quoted);
      }
      for (const id of expectedIds) {
        if (!bound.some(message => matches(message, id))) {
          const available = list.map(messageIdentityProjection);
          const selected = bound.map(messageIdentityProjection);
          const contextProjection = Object.freeze({
            input_message_count: list.length,
            normalized_message_count: list.length,
            selected_message_count: bound.length,
            quoted_message_count: list.filter(message => /<quoted_message(?:\s|>)/i.test(contextStringValue(message.content || message.rawText))).length,
            expected_message_resource_ids: expectedIds,
            available_message_resource_ids: [...new Set(available.map(identity => identity.resourceId).filter(Boolean))],
            available_message_ids: [...new Set(available.map(identity => identity.messageId).filter(Boolean))],
            selected_message_resource_ids: [...new Set(selected.map(identity => identity.resourceId).filter(Boolean))],
            missing_message_resource_ids: expectedIds.filter(expected => !bound.some(message => matches(message, expected))),
          });
          const error = new TypeError(`Execution context is missing a bound message: ${id}`);
          error.code = 'EXECUTION_CONTEXT_BINDING_MISSING';
          error.statusCode = 400;
          error.executionContextProjection = contextProjection;
          if ((submissionId || jobId) && typeof reportExecutionRejection === 'function') {
            void Promise.resolve(reportExecutionRejection({
              submissionId,
              jobId,
              stage: 'client_context_projection',
              requestPurpose,
              dispatchContract: plan,
              bindingEvidence,
              contextProjection,
              error,
            })).catch(() => {});
          }
          throw error;
        }
      }
      return bound;
    }

    function composeSystemPrompt(options = {}, session = {}, config = {}) {
      const custom = session.hasSystemPromptOverride ? session.systemPrompt || '' : config.systemPrompt || '';
      const systemContext = normalizeSystemContext(options.systemContext);
      const parts = [custom, ...systemContext];
      if (options.quotedMessage) {
        parts.push('本轮包含一条被引用的消息（<quoted_message> 块），用户的问题是针对这条被引用消息提出的，以被引用消息为背景；问题中的指代对象就是被引用消息，直接作答，不要给出基于其它解释的替代答案。');
      }
      if (contextStringValue(options.dispatchContract?.operation) === 'ocr') parts.push(OCR_EXECUTION_CONTEXT);
      return [...new Set(parts.map(item => contextStringValue(item)).filter(Boolean))].join('\n\n');
    }

    function buildMessagesWithFileInputs(prompt, attachments, baseMessages, systemPrompt = '') {
      if (typeof chatService.buildUserContentWithAttachments !== 'function') {
        return deps.buildChatMessagesWithAttachments(prompt, attachments, baseMessages, systemPrompt);
      }
      const history = (Array.isArray(baseMessages) ? baseMessages : [])
        .filter(message => message && ['system', 'user', 'assistant'].includes(message.role))
        .map(message => ({
          role: message.role,
          content: typeof message.content === 'string' || Array.isArray(message.content)
            ? message.content
            : String(message.content || ''),
        }));
      const content = chatService.buildUserContentWithAttachments(prompt, attachments);
      const messages = [...history, { role: 'user', content }];
      const system = String(systemPrompt || '').trim();
      if (!system) return messages;
      return [{ role: 'system', content: system }, ...messages.filter((message, index) => !(index === 0 && message.role === 'system' && String(message.content || '').trim() === system))];
    }

    function buildResponsesRequestPayload(model, messages, options = {}) {
      if (typeof deps.buildResponsesPayload === 'function') return deps.buildResponsesPayload(model, messages, options);
      return chatService.buildResponsesPayload(model, messages, options);
    }

    function attachmentTextFromContext(value, { label = '附件', limit = 12000 } = {}) {
      if (!value) return '';
      let context = value;
      if (typeof context === 'string') {
        try { context = JSON.parse(context); } catch { return ''; }
      }
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      const parts = attachments
        .filter(item => item && item.inputFile !== true && item.input_file !== true && !/^image\//i.test(String(item.type || '')) && String(item.text || '').trim())
        .map(item => `[${label}：${item.name || 'attachment'}]\n${String(item.text || '').trim()}`);
      return parts.join('\n\n').slice(0, limit);
    }

    function quotedAttachmentTextFromContext(value, limit = 12000) {
      return attachmentTextFromContext(value, { label: '引用附件', limit });
    }

    function isInputFileAvailable(item = {}) {
      const helper = root?.ChatUICoreAttachments?.isInputFileAvailable
        || root?.ChatUICore?.attachments?.isInputFileAvailable;
      if (typeof helper === 'function') return !!helper(item);
      const marked = item.inputFile === true || item.input_file === true;
      if (!marked) return false;
      return !!(
        item.file
        || item.persistedSrc
        || item.persisted_src
        || item.src
        || item.dataUrl
        || item.data_url
        || item.fileData
        || item.file_data
      );
    }

    function quotedFileCandidatesFromContext(value) {
      if (!value) return [];
      let context = value;
      if (typeof context === 'string') {
        try { context = JSON.parse(context); } catch { return []; }
      }
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      return attachments
        .filter(item => item && !/^image\//i.test(String(item.type || '')))
        .map((item, index) => ({
          index: index + 1,
          source_index: index + 1,
          source: 'quoted',
          file_id: item.id || item.attachmentId || item.attachment_id || '',
          name: item.name || 'attachment',
          type: item.type || 'application/octet-stream',
          size: Number(item.size) || 0,
          has_extracted_text: !!String(item.text || '').trim(),
          input_file_available: isInputFileAvailable(item),
          unsupported_reason: item.unsupportedReason || '',
        }));
    }

    function normalizeQuotedBaseMessages(messages = [], quotedMessage = null) {
      const base = (Array.isArray(messages) ? messages : [])
        .filter(item => item && (item.role === 'user' || item.role === 'assistant'));
      const quoted = quotedMessage && String(quotedMessage.content ?? quotedMessage.rawText ?? '').trim()
        ? quotedMessage
        : base.find(item => String(item.content ?? item.rawText ?? '').trim());
      if (!quoted) return [];
      const roleLabel = quoted.role === 'assistant' ? 'assistant' : 'user';
      const clean = root?.ChatUIServices?.route?.cleanQuotedContent || root?.ChatUIRouteService?.cleanQuotedContent || (value => String(value || '').replace(/\[base64 image\]/gi, '').replace(/耗时：[^\n]+/g, '').trim());
      const content = clean(String(quoted.content ?? quoted.rawText ?? '').trim());
      const attachmentText = quotedAttachmentTextFromContext(quoted.attachmentContext || quoted.attachment_context || '');
      const quotedBody = [content || '[quoted_message]', attachmentText].filter(Boolean).join('\n\n');
      const quotedIdentity = messageIdentityProjection(quoted);
      const quotedProjection = {
        ...(quotedIdentity.messageId ? { id: quotedIdentity.messageId, message_id: quotedIdentity.messageId } : {}),
        ...(quotedIdentity.resourceId ? { resource_id: quotedIdentity.resourceId } : {}),
        role: 'user',
        content: `<quoted_message role=\"${roleLabel}\">\n${quotedBody}\n</quoted_message>`,
      };
      if (!base.length) return [quotedProjection];

      const quotedKeys = new Set([
        quotedIdentity.messageId,
        quotedIdentity.resourceId,
        ...quotedIdentity.aliases,
      ].filter(Boolean));
      const quotedText = String(quoted.content ?? quoted.rawText ?? '').trim();
      let replaced = false;
      const normalized = base.map(message => {
        if (replaced) return message;
        const identity = messageIdentityProjection(message);
        const keys = [identity.messageId, identity.resourceId, ...identity.aliases].filter(Boolean);
        const identityMatch = quotedKeys.size > 0 && keys.some(key => quotedKeys.has(key));
        const valueMatch = quotedKeys.size === 0
          && message.role === quoted.role
          && String(message.content ?? message.rawText ?? '').trim() === quotedText;
        if (message === quoted || identityMatch || valueMatch) {
          replaced = true;
          return quotedProjection;
        }
        return message;
      });
      if (!replaced) {
        if (base.length === 1) return [quotedProjection];
        normalized.unshift(quotedProjection);
      }
      return normalized;
    }

    function messagesWithAttachmentText(messages = [], totalLimit = 24000) {
      let remaining = Math.max(0, Number(totalLimit) || 0);
      return (Array.isArray(messages) ? messages : []).map(message => {
        const text = remaining > 0 ? attachmentTextFromContext(message?.attachmentContext || message?.attachment_context || '', { label: '历史附件', limit: remaining }) : '';
        if (!text) return message;
        remaining -= text.length;
        const content = Array.isArray(message.content) ? message.content : String(message.content ?? message.rawText ?? '');
        const nextContent = Array.isArray(content) ? content : [String(content || '').trim(), text].filter(Boolean).join('\n\n');
        return { ...message, content: nextContent };
      });
    }

    function requestBaseMessagesForSend(options = {}, messages = []) {
      if (options.quotedMessage) return normalizeQuotedBaseMessages(options.requestBaseMessages, options.quotedMessage);
      if (Array.isArray(options.requestBaseMessages)) return messagesWithAttachmentText(options.requestBaseMessages);
      const base = options.userAlreadyAdded && messages.at?.(-1)?.role === 'user' ? messages.slice(0, -1) : messages;
      return messagesWithAttachmentText(base);
    }

    function systemPromptForSend(options = {}, session = {}, config = {}) {
      return composeSystemPrompt(options, session, config);
    }

    function protectedHistoryIndexes(messages = [], count = 0) {
      const limit = Math.max(0, Math.floor(Number(count) || 0));
      if (!limit) return [];
      let currentUserIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') { currentUserIndex = index; break; }
      }
      const protectedIndexes = [];
      for (let index = currentUserIndex - 1; index >= 0 && protectedIndexes.length < limit; index -= 1) {
        if (messages[index]?.role === 'user' || messages[index]?.role === 'assistant') protectedIndexes.unshift(index);
      }
      return protectedIndexes;
    }

    function protectedContextMessageCount(options = {}) {
      const selectedCount = Math.max(0, Math.floor(Number(options.routeContextMessageCount) || 0));
      return Math.max(selectedCount, options.quotedMessage ? 1 : 0);
    }

    function applyOutboundContextBudget(messages, config = {}, options = {}) {
      const helper = deps.applyContextBudget || root?.ChatUICore?.contextBudget?.applyContextBudget || root?.ChatUICoreContextBudget?.applyContextBudget;
      if (typeof helper !== 'function') return messages;
      const contextWindowTokens = config?.context?.windowTokens ?? config?.contextWindowTokens;
      const protectedMessageIndexes = Array.isArray(options.protectedMessageIndexes)
        ? options.protectedMessageIndexes
        : protectedHistoryIndexes(messages, protectedContextMessageCount(options));
      const result = helper(messages, {
        contextWindowTokens,
        protectedMessageIndexes,
        // Conversation execution follows strict oldest-first eviction. The
        // intent layer decides whether history is none, exact, or conversational;
        // the budget layer must not synthesize a replacement summary.
        summarizeOmitted: false,
      });
      if (result?.requiredOverflow) {
        const error = new RangeError('当前请求及已绑定上下文超出模型上下文窗口，未发送请求。请缩短当前内容或减少所选上下文后重试');
        error.code = 'CONTEXT_REQUIRED_CONTENT_TOO_LARGE';
        error.statusCode = 400;
        error.overflowTokens = result.overflowTokens;
        throw error;
      }
      return result?.messages || messages;
    }

    function appendWithOverlap(base = '', chunk = '') {
      const left = String(base || '');
      const right = String(chunk || '');
      if (!right) return left;
      if (!left || right.startsWith(left)) return right;
      if (left.endsWith(right)) return left;
      if (left.startsWith(right)) return left;
      const maxOverlapScan = Math.min(left.length, right.length, 4096);
      for (let size = maxOverlapScan; size > 0; size -= 1) {
        if (left.slice(-size) === right.slice(0, size)) return left + right.slice(size);
      }
      return left + right;
    }

    function hasImageAttachment(list = []) {
      return (list || []).some(item => /^image\//i.test(String(item?.type || item?.file?.type || '')) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(item?.name || item?.file?.name || '')));
    }

    function canShowChatWaiting(answerStarted = false) {
      return !answerStarted;
    }

    function messageListHasImagePart(messages = []) {
      return (messages || []).some(message => Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url' && (part.image_url?.url || part.image_url)));
    }

    function metricNow() {
      return root?.performance?.now ? root.performance.now() : Date.now();
    }

    function elapsedSince(startedAt) {
      return Number.isFinite(startedAt) ? Math.max(0, metricNow() - startedAt) : null;
    }

    function buildResponseMetaText(metrics = {}, startedAt = null) {
      const durationMs = Number.isFinite(metrics.durationMs) ? metrics.durationMs : elapsedSince(startedAt);
      const firstTokenMs = Number.isFinite(metrics.firstTokenMs) ? metrics.firstTokenMs : durationMs;
      const formatter = root?.ChatUIApp?.formatting?.responseMetricsText;
      if (typeof formatter === 'function') return formatter({ firstTokenMs, durationMs });
      return [Number.isFinite(firstTokenMs) ? `TTFT ${deps.formatElapsed?.(firstTokenMs) || `${(firstTokenMs / 1000).toFixed(1)}s`}` : '', Number.isFinite(durationMs) ? `RT ${deps.formatElapsed?.(durationMs) || `${(durationMs / 1000).toFixed(1)}s`}` : ''].filter(Boolean).join(' · ');
    }
    async function persistChatJobSnapshot(sessionId, job, payload) {
      if (!job?.id || typeof deps.saveChatJobWithMedia !== 'function') return null;
      return deps.saveChatJobWithMedia(sessionId, { ...job, payload });
    }

    function isRecoverableJobSnapshot(savedJob, expectedJob) {
      const validator = root?.ChatUIAppJobWorkflow?.isRecoverableJobSnapshot;
      return validator ? validator(savedJob, expectedJob) : !!savedJob?.payload && savedJob.id === expectedJob?.id;
    }
    async function sendChat(e, t = deps.state.attachments, s = null, n = {}) {
      with (deps) {
        await loadPublicContext?.();
        const executionAuthorization = requireChatExecutionContract(n);
        const executionPrompt = String(executionAuthorization.plan?.arguments?.prompt || e || '').trim();
        const pendingStatus = executionStatus.operationStatusText?.(executionAuthorization.plan, 'execute') || '正在等待模型生成回答';
        const a=getConfig();const sessionChatModel=getSessionChatModel(n.sessionId||state.activeSessionId,a);if(!a.baseUrl||!sessionChatModel)throw new Error("Please configure Endpoint Base URL and chat model first");const i=n.sessionId||state.activeSessionId,o=ensureActiveRun(i);if(o.stopped||o.abortController?.signal?.aborted)throw new DOMException("Stopped","AbortError");const requestHeaders={},r=state.sessions.find(e=>e.id===i)||getActiveSession(),{enabled:reasoningEnabled,effort:reasoningEffort}=captureReasoningRequestSettings(r,state),l=i===state.activeSessionId?state.messages:[...r.messages||[]],T=await prepareChatAttachments(t,{config:a,signal:o.abortController.signal,sessionId:i,headers:requestHeaders,operation:executionAuthorization.plan.operation}),baseMessages=applyExecutionContextPolicy(requestBaseMessagesForSend(n,l),{dispatchContract:executionAuthorization.plan,bindingEvidence:executionAuthorization.evidence,submissionId:n.submissionId||"",jobId:n.clientJobId||"",requestPurpose:"final_execution"}),rawMessages=buildMessagesWithFileInputs(executionPrompt,T,baseMessages,systemPromptForSend({...n,dispatchContract:executionAuthorization.plan},r,a));if(hasImageAttachment(t)&&!messageListHasImagePart(rawMessages))throw new Error("图片未成功读取，无法发送给聊天模型，请重新上传图片后再试");const protectedMessageIndexes=protectedHistoryIndexes(rawMessages,protectedContextMessageCount(n)),d=applyOutboundContextBudget(rawMessages,a,{protectedMessageIndexes});i===state.activeSessionId?(n.userAlreadyAdded||state.messages.push({role:"user",content:e,rawText:e,messageIndex:state.messages.length}),await saveChatHistory()):(n.userAlreadyAdded||l.push({role:"user",content:e,rawText:e,messageIndex:l.length}),await saveSessionMessages(i,l));const c=Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex-1:Math.max(0,(i===state.activeSessionId?state.messages:l).length-1),m=c+1,g=i===state.activeSessionId?s||addMessage("assistant",pendingFeedbackHtml(pendingStatus),{html:!0,rawText:pendingStatus,skipSave:!0}):null,u=n.liveItem||appendSessionDisplayMessage(i,"assistant",pendingFeedbackHtml(pendingStatus),{html:!0,rawText:pendingStatus,pending:!0,responseIndex:m});if(u){u.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m);const e=[...r.display||[]].reverse().find(e=>"user"===e?.role&&""!==e.messageIndex&&Number(e.messageIndex)===c);e&&(e.responseIndex=""),persistSessionDisplay(i)}g&&u&&(g.__displayItem=u,u.id&&(g.dataset.displayItemId=u.id)),g&&armStreamingOutputFocus(i,g,{margin:72,clearStaleFocus:!0});const webSearch=executionAuthorization.plan.operation==="web_search",useResponses=webSearch||shouldUseResponsesReasoning(sessionChatModel,reasoningEnabled)||messagesHaveInputFiles(rawMessages),chatApi=useResponses?"responses":"chat",p=useResponses?buildResponsesRequestPayload(sessionChatModel,d,{stream:!0,reasoningEnabled,reasoningEffort,...webSearch?{webSearch:!0}:{}}):buildChatPayload(sessionChatModel,d,{stream:!0,reasoning:reasoningEnabled,reasoningEffort});dispatchContractContract.assertPayloadMatchesDispatchContract?.(executionAuthorization.plan,{payload:p,transportApi:chatApi,bindingEvidence:executionAuthorization.evidence,enforceContextPolicy:!0});const b=requestHeaders;let f=n.clientJobId||u?.jobId||makeClientChatJobId();f&&addActiveRunJob(i,"chat",f),f&&u&&(u.jobId=f,u.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m),u.id||(u.id=makeDisplayItemId()),persistSessionDisplay(i),g&&(g.dataset.jobId=f,g.dataset.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m)));const durableJob={id:f,prompt:e,startedAt:Date.now(),displayItemId:u?.id||"",responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,mode:"chat",api:chatApi,requestPurpose:"final_execution",dispatchContract:executionAuthorization.plan,bindingEvidence:executionAuthorization.evidence,submissionId:n.submissionId||""},savedJob=f?await persistChatJobSnapshot(i,durableJob,p):null;if(f&&!isRecoverableJobSnapshot(savedJob,{...durableJob,payload:p})){clearChatJob(i);throw new Error("\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5")};u&&persistSessionDisplay(i);try{n.onDurableHandoff?.()}catch(e){console.warn("durable chat handoff callback failed",e)};let interfaceCompleted=!1;const notifyInterfaceCompleted=()=>{if(interfaceCompleted)return;interfaceCompleted=!0;try{n.onInterfaceCompleted?.({sessionId:i,submissionId:n.submissionId||"",jobId:f,jobKind:"chat"})}catch(e){console.warn("durable chat completion callback failed",e)}};const responseStartedAt=metricNow();let answerStarted=!1,reasoningCompleted=!1,streamRequestAccepted=!1,streamRetries=0;try{let t="",s=!1,c=null,answerText="",reasoningText="",firstTokenMs=null;const markFirstToken=e=>{if(!Number.isFinite(firstTokenMs))firstTokenMs=Number.isFinite(e)?e:elapsedSince(responseStartedAt);return firstTokenMs};const h=()=>{},y=()=>{},mergeAnswer=e=>(answerText=appendWithOverlap(answerText,e||"")),mergeReasoning=e=>(reasoningText=appendWithOverlap(reasoningText,e||"")),I=createRealtimeRenderer(e=>{if(shouldSuppressRunUi(i,o.token))return;const t=e||"";if(!t)return;if(!reasoningCompleted){reasoningCompleted=!0;if(reasoningEnabled&&reasoningText&&g?.isConnected)updateReasoning(g,reasoningText,{done:!0,restoreHistory:!0,followActive:!1,forceScroll:!1});}answerStarted=!0;const q=g?.__markdownStreamingRenderer?.getRaw?.()||"";const z=t.startsWith(q)?t.slice(q.length):t;g?.isConnected&&(clearPendingFeedback(g),updateMessageContentLight(g,z,{sessionId:i,runToken:o.token,rawText:t,delta:!0,skipSave:!0,forceScroll:!1,followActive:!1,noScroll:!shouldFollowScroll(),streamKind:"chat"})),updateLiveDisplay(i,u,"assistant",t,{rawText:t,pending:!0,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,forceScroll:!1,noScroll:!shouldFollowScroll(),runToken:o.token,deferDomUpdate:!!g?.isConnected,skipDisplayUpdate:!!g?.isConnected})},{minIntervalMs:40}),S=createRealtimeRenderer(e=>{if(shouldSuppressRunUi(i,o.token))return;if(!reasoningEnabled)return;if(answerStarted)return;const a=e||"";a&&a!==t&&(t=a,y()),g?.isConnected&&"1"===g.dataset.pendingFeedback&&clearPendingFeedback(g),g?.isConnected&&a!==g.dataset.reasoningText&&updateReasoning(g,a,{done:!1,forceScroll:!1,followActive:!1,keepEmpty:!!a}),u&&updateLiveDisplay(i,u,"assistant",answerText||pendingStatus,{rawText:answerText||pendingStatus,pending:!0,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,reasoning:a,keepReasoning:!!a,runToken:o.token,deferDomUpdate:!!g?.isConnected,forceScroll:!1,noScroll:!shouldFollowScroll()})});let x;const clearReplacementOnAccepted=()=>{streamRequestAccepted=!0;if(!n.deferReplacementClear)return;if(n.__replacementAccepted)return;n.__replacementAccepted=!0;if(!canShowChatWaiting(answerStarted))return;try{n.onAccepted?.()}catch(e){console.warn("replacement accepted callback failed",e)}const e=pendingFeedbackHtml(pendingStatus),t=Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m;g?.isConnected&&(clearReasoning(g),clearPendingFeedback(g),updateMessage(g,e,{html:!0,rawText:pendingStatus,skipSave:!0,noScroll:!shouldFollowScroll(),followActive:!1,forceScroll:!1,responseIndex:t}));u&&updateSessionDisplayItem(i,u,"assistant",e,{html:!0,rawText:pendingStatus,pending:!0,responseIndex:t,jobId:f||u.jobId||""})};g?.isConnected&&!n.deferReplacementClear&&setPendingFeedback(g,pendingStatus,{sessionId:i,runToken:o.token,followActive:!1,forceScroll:!1});let N=!1;x=await streamManagedChatCompletions(p,a,f,e=>{const t=e.content||"";if(!N&&(t||e.reasoning)&&g?.isConnected){const s=firstTokenTimeText(markFirstToken(e.firstTokenMs));s&&(setMessageMetaText(g,s),u&&(u.metaText=s),N=!0)}S.set(mergeReasoning(e.reasoning||"")),I.set(mergeAnswer(t))},{signal:o.abortController.signal,headers:b,sessionId:i,api:chatApi,requestPurpose:"final_execution",dispatchContract:executionAuthorization.plan,bindingEvidence:executionAuthorization.evidence,submissionId:n.submissionId||"",onAccepted:clearReplacementOnAccepted});clearTimeout(c),h(),g?.isConnected&&clearPendingFeedback(g);const v=x.content||"没有返回内容",C=v,M=buildResponseMetaText({firstTokenMs:x.firstTokenMs??firstTokenMs,durationMs:x.durationMs},responseStartedAt),R=reasoningEnabled?normalizeReasoningText(x.reasoning||t||""):"";I.final(C),S.final(R),clearTimeout(c),i===state.activeSessionId?(Number.isFinite(n.replaceAssistantIndex)&&"assistant"===state.messages[n.replaceAssistantIndex]?.role?state.messages[n.replaceAssistantIndex]={...state.messages[n.replaceAssistantIndex],role:"assistant",content:C,rawText:C,reasoning_content:R,responseIndex:n.replaceAssistantIndex,metaText:M}:Number.isFinite(n.replaceAssistantIndex)?state.messages[n.replaceAssistantIndex]={role:"assistant",content:C,rawText:C,reasoning_content:R,responseIndex:n.replaceAssistantIndex,metaText:M}:state.messages.push({role:"assistant",content:C,rawText:C,reasoning_content:R,responseIndex:m,metaText:M}),state.messages=compactAdjacentDuplicateMessages(state.messages),r.messages=cloneMessageList(state.messages),await saveChatHistory(),g?.isConnected&&(updateMessage(g,C,{rawText:C,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,noScroll:!shouldFollowScroll(),followActive:shouldFollowScroll(),settleScroll:!0,metaText:M}),R&&updateReasoning(g,R,{done:!0,restoreHistory:!0,followActive:shouldFollowScroll()}),settleActiveOutput(g,{margin:72})),Number.isFinite(n.replaceAssistantIndex)?updateSessionDisplayItem(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:n.replaceAssistantIndex,reasoning:R,keepReasoning:!!R,metaText:M}):updateLiveDisplay(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:m,reasoning:R,keepReasoning:!!R,metaText:M}),f&&clearChatJob(i)):(l.push({role:"assistant",content:C,rawText:C,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,metaText:M}),await saveSessionMessages(i,l),updateLiveDisplay(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,reasoning:R,keepReasoning:!!R,metaText:M}),f&&clearChatJob(i)),notifyInterfaceCompleted(),playDoneSound()}catch(e){if(e?.terminalJob){f&&clearChatJob(i);throw e}if(isRunStopped(i)||"AbortError"===e?.name)return;if(state.pageUnloading&&isAbortLikeError(e))return;if(streamRetries>=2||!shouldRetryStreamFailure({requestAccepted:streamRequestAccepted,answerStarted}))throw e;streamRetries+=1;let t;g?.isConnected&&canShowChatWaiting(answerStarted)&&setPendingFeedback(g,pendingStatus,{sessionId:i,runToken:o.token,followActive:!1,forceScroll:!1});t=await streamManagedChatCompletions(p,a,f,()=>{},{signal:o.abortController.signal,headers:b,sessionId:i,api:chatApi,requestPurpose:"final_execution",dispatchContract:executionAuthorization.plan,bindingEvidence:executionAuthorization.evidence,submissionId:n.submissionId||"",onAccepted:clearReplacementOnAccepted});g?.isConnected&&clearPendingFeedback(g);const c=normalizeContentText(t?.content||"")||`\u6d41\u5f0f\u91cd\u8bd5\u6ca1\u6709\u8fd4\u56de\u5185\u5bb9\uff1a${e.message||e}`,R=reasoningEnabled?normalizeReasoningText(t?.reasoning||""):"",M=buildResponseMetaText({firstTokenMs:t?.firstTokenMs,durationMs:t?.durationMs},responseStartedAt);i===state.activeSessionId?(Number.isFinite(n.replaceAssistantIndex)&&"assistant"===state.messages[n.replaceAssistantIndex]?.role?state.messages[n.replaceAssistantIndex]={...state.messages[n.replaceAssistantIndex],role:"assistant",content:c,rawText:c,reasoning_content:R,responseIndex:n.replaceAssistantIndex,metaText:M}:Number.isFinite(n.replaceAssistantIndex)?state.messages[n.replaceAssistantIndex]={role:"assistant",content:c,rawText:c,reasoning_content:R,responseIndex:n.replaceAssistantIndex,metaText:M}:state.messages.push({role:"assistant",content:c,rawText:c,reasoning_content:R,responseIndex:m,metaText:M}),state.messages=compactAdjacentDuplicateMessages(state.messages),r.messages=cloneMessageList(state.messages),await saveChatHistory(),g?.isConnected&&(updateMessage(g,c,{rawText:c,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,noScroll:!shouldFollowScroll(),followActive:shouldFollowScroll(),settleScroll:!0,metaText:M}),R&&updateReasoning(g,R,{done:!0,restoreHistory:!0,followActive:shouldFollowScroll()}),settleActiveOutput(g,{margin:72})),Number.isFinite(n.replaceAssistantIndex)?updateSessionDisplayItem(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:n.replaceAssistantIndex,reasoning:R,keepReasoning:!!R,metaText:M}):updateLiveDisplay(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,reasoning:R,keepReasoning:!!R,metaText:M}),f&&clearChatJob(i)):(l.push({role:"assistant",content:c,rawText:c,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,metaText:M}),await saveSessionMessages(i,l),updateLiveDisplay(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,reasoning:R,keepReasoning:!!R,metaText:M}),f&&clearChatJob(i)),notifyInterfaceCompleted(),playDoneSound()}
      }
    }

    return Object.freeze({ sendChat, normalizeQuotedBaseMessages, quotedAttachmentTextFromContext, quotedFileCandidatesFromContext, messagesWithAttachmentText, requestBaseMessagesForSend, protectedHistoryIndexes, protectedContextMessageCount, applyOutboundContextBudget, systemPromptForSend, composeSystemPrompt, applyExecutionContextPolicy, appendWithOverlap, canShowChatWaiting });
  }

  const api = Object.freeze({ createChatWorkflow, shouldRetryStreamFailure, captureReasoningRequestSettings });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppChatWorkflow = api;
  if (root?.window) root.window.ChatUIAppChatWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
