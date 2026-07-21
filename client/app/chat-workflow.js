(function initChatUIAppChatWorkflow(root) {
  // Intentionally not strict: sendChat body is migrated from app.js and resolved through a deps scope.

  function shouldRetryStreamFailure({ requestAccepted = false, answerStarted = false } = {}) {
    return !requestAccepted && !answerStarted;
  }


  const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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

    function attachmentTextFromContext(value, { label = '附件', limit = 12000 } = {}) {
      if (!value) return '';
      let context = value;
      if (typeof context === 'string') {
        try { context = JSON.parse(context); } catch { return ''; }
      }
      const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
      const parts = attachments
        .filter(item => item && !/^image\//i.test(String(item.type || '')) && String(item.text || '').trim())
        .map(item => `[${label}：${item.name || 'attachment'}]\n${String(item.text || '').trim()}`);
      return parts.join('\n\n').slice(0, limit);
    }

    function quotedAttachmentTextFromContext(value, limit = 12000) {
      return attachmentTextFromContext(value, { label: '引用附件', limit });
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
          file_id: item.id || item.attachmentId || item.attachment_id || '',
          name: item.name || 'attachment',
          type: item.type || 'application/octet-stream',
          size: Number(item.size) || 0,
          has_extracted_text: !!String(item.text || '').trim(),
          unsupported_reason: item.unsupportedReason || '',
        }));
    }

    function normalizeQuotedBaseMessages(messages = []) {
      const quoted = (Array.isArray(messages) ? messages : [])
        .find(item => item && (item.role === 'user' || item.role === 'assistant') && String(item.content ?? item.rawText ?? '').trim());
      if (!quoted) return [];
      const roleLabel = quoted.role === 'assistant' ? 'assistant' : 'user';
      const clean = root?.ChatUIServices?.route?.cleanQuotedContent || root?.ChatUIRouteService?.cleanQuotedContent || (value => String(value || '').replace(/\[base64 image\]/gi, '').replace(/耗时：[^\n]+/g, '').trim());
      const content = clean(String(quoted.content ?? quoted.rawText ?? '').trim());
      const attachmentText = quotedAttachmentTextFromContext(quoted.attachmentContext || quoted.attachment_context || '');
      const quotedBody = [content || '[quoted_message]', attachmentText].filter(Boolean).join('\n\n');
      return [{
        role: 'user',
        content: `以下是用户引用的一条 ${roleLabel} 消息。后续问题只针对这段引用内容；不要使用其它会话上下文，也不要把用户当前问题当作引用内容。若本轮同时提供图片附件，这些图片附件属于这条引用消息，是引用内容的一部分。若引用消息带有非图片文件附件，下面的“引用附件”文本是该附件解析后的正文内容，也属于引用内容。\n\n<quoted_message>\n${quotedBody}\n</quoted_message>`,
      }];
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
      if (options.quotedMessage) return normalizeQuotedBaseMessages(options.requestBaseMessages);
      if (Array.isArray(options.requestBaseMessages)) return messagesWithAttachmentText(options.requestBaseMessages);
      const base = options.userAlreadyAdded && messages.at?.(-1)?.role === 'user' ? messages.slice(0, -1) : messages;
      return messagesWithAttachmentText(base);
    }

    function systemPromptForSend(options = {}, session = {}, config = {}) {
      if (options.quotedMessage) return '当前请求包含引用消息。引用消息是本轮唯一上下文；回答时只依据 quoted_message、引用消息附带的图片附件和用户当前问题，不要使用其它历史会话内容。';
      return session.hasSystemPromptOverride ? session.systemPrompt || '' : config.systemPrompt || '';
    }

    function applyOutboundContextBudget(messages, config = {}) {
      const helper = deps.applyContextBudget || root?.ChatUICore?.contextBudget?.applyContextBudget || root?.ChatUICoreContextBudget?.applyContextBudget;
      if (typeof helper !== 'function') return messages;
      const contextWindowTokens = config?.context?.windowTokens ?? config?.contextWindowTokens;
      return helper(messages, { contextWindowTokens }).messages;
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
        const a=getConfig();const sessionChatModel=getSessionChatModel(n.sessionId||state.activeSessionId,a);if(!a.baseUrl||!sessionChatModel)throw new Error("Please configure Endpoint Base URL and chat model first");const i=n.sessionId||state.activeSessionId,o=ensureActiveRun(i);if(o.stopped||o.abortController?.signal?.aborted)throw new DOMException("Stopped","AbortError");const r=state.sessions.find(e=>e.id===i)||getActiveSession(),{enabled:reasoningEnabled,effort:reasoningEffort}=captureReasoningRequestSettings(r,state),l=i===state.activeSessionId?state.messages:[...r.messages||[]],T=await ensureChatAttachmentImageDataUrls(t),rawMessages=buildChatMessagesWithAttachments(e,T,requestBaseMessagesForSend(n,l),systemPromptForSend(n,r,a));if(hasImageAttachment(t)&&!messageListHasImagePart(rawMessages))throw new Error("图片未成功读取，无法发送给聊天模型，请重新上传图片后再试");const d=applyOutboundContextBudget(rawMessages,a);i===state.activeSessionId?(n.userAlreadyAdded||state.messages.push({role:"user",content:e,rawText:e,messageIndex:state.messages.length}),await saveChatHistory()):(n.userAlreadyAdded||l.push({role:"user",content:e,rawText:e,messageIndex:l.length}),await saveSessionMessages(i,l));const c=Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex-1:Math.max(0,(i===state.activeSessionId?state.messages:l).length-1),m=c+1,g=i===state.activeSessionId?s||addMessage("assistant",pendingFeedbackHtml("正在处理中 请稍后"),{html:!0,rawText:"正在处理中 请稍后",skipSave:!0}):null,u=n.liveItem||appendSessionDisplayMessage(i,"assistant",pendingFeedbackHtml("正在处理中 请稍后"),{html:!0,rawText:"正在处理中 请稍后",pending:!0,responseIndex:m});if(u){u.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m);const e=[...r.display||[]].reverse().find(e=>"user"===e?.role&&""!==e.messageIndex&&Number(e.messageIndex)===c);e&&(e.responseIndex=""),persistSessionDisplay(i)}g&&u&&(g.__displayItem||(g.__displayItem=u),u.id&&(g.dataset.displayItemId=u.id)),g&&armStreamingOutputFocus(i,g,{margin:72,clearStaleFocus:!0});const useResponses=shouldUseResponsesReasoning(sessionChatModel,reasoningEnabled),chatApi=useResponses?"responses":"chat",p=useResponses?buildResponsesPayload(sessionChatModel,d,{stream:!0,reasoningEffort}):buildChatPayload(sessionChatModel,d,{stream:!0,reasoning:reasoningEnabled,reasoningEffort}),b=buildRequestHeaders("message",i);let f=n.clientJobId||u?.jobId||makeClientChatJobId();f&&addActiveRunJob(i,"chat",f),f&&u&&(u.jobId=f,u.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m),u.id||(u.id=makeDisplayItemId()),persistSessionDisplay(i),g&&(g.dataset.jobId=f,g.dataset.responseIndex=String(Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m)));const durableJob={id:f,prompt:e,startedAt:Date.now(),displayItemId:u?.id||"",responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,mode:"chat",api:chatApi,submissionId:n.submissionId||""},savedJob=f?await persistChatJobSnapshot(i,durableJob,p):null;if(f&&!isRecoverableJobSnapshot(savedJob,{...durableJob,payload:p})){clearChatJob(i);throw new Error("\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5")};u&&persistSessionDisplay(i);try{n.onDurableHandoff?.()}catch(e){console.warn("durable chat handoff callback failed",e)};let interfaceCompleted=!1;const notifyInterfaceCompleted=()=>{if(interfaceCompleted)return;interfaceCompleted=!0;try{n.onInterfaceCompleted?.({sessionId:i,submissionId:n.submissionId||"",jobId:f,jobKind:"chat"})}catch(e){console.warn("durable chat completion callback failed",e)}};const responseStartedAt=metricNow();let answerStarted=!1,streamRequestAccepted=!1;try{let t="",s=!1,c=null,answerText="",reasoningText="",firstTokenMs=null;const markFirstToken=e=>{if(!Number.isFinite(firstTokenMs))firstTokenMs=Number.isFinite(e)?e:elapsedSince(responseStartedAt);return firstTokenMs};const h=()=>{},y=()=>{},mergeAnswer=e=>(answerText=appendWithOverlap(answerText,e||"")),mergeReasoning=e=>(reasoningText=appendWithOverlap(reasoningText,e||"")),I=createRealtimeRenderer(e=>{if(shouldSuppressRunUi(i,o.token))return;const t=e||"";if(!t)return;answerStarted=!0;if(reasoningEnabled&&!s){s=!0;reasoningText?(g?.isConnected&&updateReasoning(g,reasoningText,{done:!0,forceScroll:!1,followActive:!1,keepEmpty:!0,renderMarkdown:!0}),u&&(u.reasoningText=reasoningText,u.keepReasoning=!0)):(g?.isConnected&&showReasoningUnavailable(g),u&&(delete u.reasoningText,u.keepReasoning=!1))}const q=g?.__markdownStreamingRenderer?.getRaw?.()||"";const z=t.startsWith(q)?t.slice(q.length):t;g?.isConnected&&(clearPendingFeedback(g),updateMessageContentLight(g,z,{sessionId:i,runToken:o.token,rawText:t,delta:!0,skipSave:!0,forceScroll:!1,followActive:!1,noScroll:!shouldFollowScroll(),streamKind:"chat"})),updateLiveDisplay(i,u,"assistant",t,{rawText:t,pending:!0,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,forceScroll:!1,noScroll:!shouldFollowScroll(),runToken:o.token,deferDomUpdate:!!g?.isConnected,skipDisplayUpdate:!!g?.isConnected})},{minIntervalMs:40}),S=createRealtimeRenderer(e=>{if(shouldSuppressRunUi(i,o.token))return;if(!reasoningEnabled)return g?.isConnected&&clearReasoning(g),void(u&&(delete u.reasoningText,u.keepReasoning=!1));const a=e||"";a&&a!==t&&(t=a,s=!!answerStarted,y()),g?.isConnected&&"1"===g.dataset.pendingFeedback&&clearPendingFeedback(g),g?.isConnected&&a!==g.dataset.reasoningText&&updateReasoning(g,a,{done:s,forceScroll:!1,followActive:!1,keepEmpty:!!a,renderMarkdown:s}),u&&(u.reasoningText=a,u.keepReasoning=!!a)});let x;const clearReplacementOnAccepted=()=>{streamRequestAccepted=!0;if(!n.deferReplacementClear)return;if(n.__replacementAccepted)return;n.__replacementAccepted=!0;if(!canShowChatWaiting(answerStarted))return;try{n.onAccepted?.()}catch(e){console.warn("replacement accepted callback failed",e)}const e=pendingFeedbackHtml("正在处理中 请稍后"),t=Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m;g?.isConnected&&(clearReasoning(g),clearPendingFeedback(g),reasoningEnabled?(updateMessageContentLight(g,"",{sessionId:i,runToken:o.token,rawText:"",skipSave:!0,forceScroll:!1,followActive:!1,noScroll:!shouldFollowScroll(),streamKind:"status"}),updateReasoning(g,"",{keepEmpty:!0})) : updateMessage(g,e,{html:!0,rawText:"正在处理中 请稍后",skipSave:!0,noScroll:!shouldFollowScroll(),followActive:!1,forceScroll:!1,responseIndex:t}));u&&updateSessionDisplayItem(i,u,"assistant",e,{html:!0,rawText:"正在处理中 请稍后",pending:!0,responseIndex:t,jobId:f||u.jobId||""})};g?.isConnected&&!n.deferReplacementClear&&(reasoningEnabled?(clearPendingFeedback(g),updateMessageContentLight(g,"",{sessionId:i,runToken:o.token,rawText:"",skipSave:!0,forceScroll:!1,followActive:!1,noScroll:!shouldFollowScroll(),streamKind:"status"}),updateReasoning(g,"",{keepEmpty:!0})):(clearReasoning(g),setPendingFeedback(g,"正在处理中 请稍后",{sessionId:i,runToken:o.token,followActive:!1,forceScroll:!1})));let N=!1;x=await streamManagedChatCompletions(p,a,f,e=>{const t=e.content||"";if(!N&&(t||e.reasoning)&&g?.isConnected){const s=firstTokenTimeText(markFirstToken(e.firstTokenMs));s&&(setMessageMetaText(g,s),u&&(u.metaText=s),N=!0)}S.set(mergeReasoning(e.reasoning||"")),I.set(mergeAnswer(t))},{signal:o.abortController.signal,headers:b,sessionId:i,api:chatApi,onAccepted:clearReplacementOnAccepted});clearTimeout(c),h(),g?.isConnected&&clearPendingFeedback(g);const v=x.content||"没有返回内容",C=v,M=buildResponseMetaText({firstTokenMs:x.firstTokenMs??firstTokenMs,durationMs:x.durationMs},responseStartedAt),R=reasoningEnabled?normalizeReasoningText(x.reasoning||t||""):"";I.final(C),S.final(R),clearTimeout(c),i===state.activeSessionId?(Number.isFinite(n.replaceAssistantIndex)&&"assistant"===state.messages[n.replaceAssistantIndex]?.role?state.messages[n.replaceAssistantIndex]={...state.messages[n.replaceAssistantIndex],role:"assistant",content:C,rawText:C,responseIndex:n.replaceAssistantIndex,...(R?{reasoning_content:R}:{}),metaText:M}:Number.isFinite(n.replaceAssistantIndex)?state.messages[n.replaceAssistantIndex]={role:"assistant",content:C,rawText:C,responseIndex:n.replaceAssistantIndex,...(R?{reasoning_content:R}:{}),metaText:M}:state.messages.push({role:"assistant",content:C,rawText:C,responseIndex:m,...(R?{reasoning_content:R}:{}),metaText:M}),state.messages=compactAdjacentDuplicateMessages(state.messages),r.messages=cloneMessageList(state.messages),await saveChatHistory(),g?.isConnected&&(updateMessage(g,C,{rawText:C,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,noScroll:!shouldFollowScroll(),followActive:shouldFollowScroll(),settleScroll:!0,metaText:M}),settleActiveOutput(g,{margin:72}),finishReasoning(g,R,{preserve:!!R})),Number.isFinite(n.replaceAssistantIndex)?updateSessionDisplayItem(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:n.replaceAssistantIndex,metaText:M,reasoning:R,keepReasoning:!!R}):updateLiveDisplay(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:m,metaText:M,reasoning:R,keepReasoning:!!R}),f&&clearChatJob(i)):(l.push({role:"assistant",content:C,rawText:C,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,...(R?{reasoning_content:R}:{}),metaText:M}),await saveSessionMessages(i,l),updateLiveDisplay(i,u,"assistant",C,{rawText:C,pending:!1,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,metaText:M,reasoning:R,keepReasoning:!!R}),f&&clearChatJob(i)),notifyInterfaceCompleted(),playDoneSound()}catch(e){if(e?.terminalJob){f&&clearChatJob(i);throw e}if(isRunStopped(i)||"AbortError"===e?.name)return;if(state.pageUnloading&&isAbortLikeError(e))return;if(!shouldRetryStreamFailure({requestAccepted:streamRequestAccepted,answerStarted}))throw e;let t;g?.isConnected&&canShowChatWaiting(answerStarted)&&setPendingFeedback(g,"\u6b63\u5728\u5904\u7406\u4e2d \u8bf7\u7a0d\u540e",{sessionId:i,runToken:o.token,followActive:!1,forceScroll:!1});t=await streamManagedChatCompletions(p,a,f,()=>{},{signal:o.abortController.signal,headers:b,sessionId:i,api:chatApi,onAccepted:clearReplacementOnAccepted});g?.isConnected&&clearPendingFeedback(g);const c=normalizeContentText(t?.content||"")||`\u6d41\u5f0f\u91cd\u8bd5\u6ca1\u6709\u8fd4\u56de\u5185\u5bb9\uff1a${e.message||e}`,R=reasoningEnabled?normalizeReasoningText(t?.reasoning||""):"",M=buildResponseMetaText({firstTokenMs:t?.firstTokenMs,durationMs:t?.durationMs},responseStartedAt);i===state.activeSessionId?(Number.isFinite(n.replaceAssistantIndex)&&"assistant"===state.messages[n.replaceAssistantIndex]?.role?state.messages[n.replaceAssistantIndex]={...state.messages[n.replaceAssistantIndex],role:"assistant",content:c,rawText:c,responseIndex:n.replaceAssistantIndex,...(R?{reasoning_content:R}:{}),metaText:M}:Number.isFinite(n.replaceAssistantIndex)?state.messages[n.replaceAssistantIndex]={role:"assistant",content:c,rawText:c,responseIndex:n.replaceAssistantIndex,...(R?{reasoning_content:R}:{}),metaText:M}:state.messages.push({role:"assistant",content:c,rawText:c,responseIndex:m,...(R?{reasoning_content:R}:{}),metaText:M}),state.messages=compactAdjacentDuplicateMessages(state.messages),r.messages=cloneMessageList(state.messages),await saveChatHistory(),g?.isConnected&&(updateMessage(g,c,{rawText:c,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,noScroll:!shouldFollowScroll(),followActive:shouldFollowScroll(),settleScroll:!0,metaText:M}),settleActiveOutput(g,{margin:72}),finishReasoning(g,R,{preserve:!!R})),Number.isFinite(n.replaceAssistantIndex)?updateSessionDisplayItem(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:n.replaceAssistantIndex,metaText:M,reasoning:R,keepReasoning:!!R}):updateLiveDisplay(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:m,metaText:M,reasoning:R,keepReasoning:!!R}),f&&clearChatJob(i)):(l.push({role:"assistant",content:c,rawText:c,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,...(R?{reasoning_content:R}:{}),metaText:M}),await saveSessionMessages(i,l),updateLiveDisplay(i,u,"assistant",c,{rawText:c,pending:!1,responseIndex:Number.isFinite(n.replaceAssistantIndex)?n.replaceAssistantIndex:m,metaText:M,reasoning:R,keepReasoning:!!R}),f&&clearChatJob(i)),notifyInterfaceCompleted(),playDoneSound()}
      }
    }

    return Object.freeze({ sendChat, normalizeQuotedBaseMessages, quotedAttachmentTextFromContext, quotedFileCandidatesFromContext, messagesWithAttachmentText, requestBaseMessagesForSend, systemPromptForSend, appendWithOverlap, canShowChatWaiting });
  }

  const api = Object.freeze({ createChatWorkflow, shouldRetryStreamFailure, captureReasoningRequestSettings });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppChatWorkflow = api;
  if (root?.window) root.window.ChatUIAppChatWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
