(function initChatUIAppSubmitWorkflow(root) {
  // Intentionally not strict: submit body is migrated from app.js and resolved through a deps scope.
  const requestCompatibility = root?.[Symbol.for('chatui.module-registry.v1')]?.get('requestCompatibility')
    || (typeof require === 'function' ? require('../services/request-compatibility') : {});
  const requestJsonWithStructuredOutputFallback = requestCompatibility.requestJsonWithStructuredOutputFallback;
  if (typeof requestJsonWithStructuredOutputFallback !== 'function') {
    throw new Error('ChatUI request compatibility service is not loaded');
  }


  const submitWorkflowPolicy = root?.[Symbol.for('chatui.module-registry.v1')]?.get('submitWorkflowPolicy')
    || (typeof require === 'function' ? require('./submit-workflow-policy') : {});
  const {
    parseOptionalMessageIndex,
    createBoundedIntentRequest,
    createPendingTransition,
    buildPendingAssistancePresentation,
    ROUTE_OUTCOMES,
    normalizeRouteOutcome,
    isRouteFailureOutcome,
    INTENT_PIPELINE_DEADLINE_MS,
  } = submitWorkflowPolicy;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});
  function createSubmitWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const submitHelpers = root?.ChatUISubmitWorkflowHelpers
      || (typeof require === 'function' ? require('./submit-workflow.helpers') : {});
    const jobLifecycle = root?.ChatUIAppJobWorkflow || {};
    const getPreviousImageAttachments = deps.getPreviousImageAttachments || root?.getPreviousImageAttachments;
    const restoreUserAttachmentsFromContext = deps.restoreUserAttachmentsFromContext || root?.restoreUserAttachmentsFromContext;
    const taskEvents = deps.taskEvents || root?.ChatUICore?.taskState?.TASK_EVENTS || {};
    const emitTaskEvent = (sessionId, type, details = {}) => type
      ? deps.dispatchTaskEvent?.(sessionId, { type, ...details })
      : null;
    const finishSessionTask = deps.finishSessionTask || ((sessionId, options = {}) => {
      options.stopSlowNotice?.();
      deps.setSessionBusy?.(sessionId, false);
      if (options.run) deps.clearActiveRun?.(sessionId, options.run);
      deps.updateSendAvailability?.();
      if (options.focusPrompt) deps.$?.('prompt')?.focus?.();
    });

    function loadPendingSubmit(sessionId = deps.state?.activeSessionId || '') {
      return jobLifecycle.loadPendingSubmit?.(sessionId, { storage: root.localStorage }) || null;
    }

    function savePendingSubmit(sessionId = '', value = {}) {
      if (deps.state.disposedSessionIds?.has?.(sessionId)) return false;
      try {
        if (typeof jobLifecycle.savePendingSubmit !== 'function') return false;
        return jobLifecycle.savePendingSubmit(sessionId, value, {
          storage: root.localStorage,
          isSessionDisposed: id => deps.state.disposedSessionIds?.has?.(id),
        }) !== false;
      } catch (err) {
        console.warn('save pending submit failed', err);
        return false;
      }
    }

    function clearPendingSubmit(sessionId = deps.state?.activeSessionId || '') {
      try { root?.ChatUIAppJobWorkflow?.clearPendingSubmit?.(sessionId, { storage: root.localStorage }); } catch {}
    }

    async function resumePendingSubmit(sessionId = deps.state?.activeSessionId || '') {
      const runs = root?.ChatUIApp?.runs || root?.ChatUIAppRuns || {};
      const resumeKey = runs.beginPendingSubmitResume?.(deps.state, sessionId);
      if (!resumeKey) return false;
      try {
        const pending = loadPendingSubmit(sessionId);
        if (!pending) return false;
        if (!(jobLifecycle.pendingSubmitHasRecoverableInput?.(pending) ?? !!(pending.promptText || pending.rawPromptText))) {
          clearPendingSubmit(sessionId);
          return false;
        }
        await onSubmit({ preventDefault() {}, __chatuiResumePendingSubmit: { ...pending, sessionId } });
        return true;
      } finally {
        runs.finishPendingSubmitResume?.(deps.state, sessionId);
        finishSessionTask(sessionId, { resumeKey });
      }
    }

    async function onSubmit(e) {
      const clarificationAnswerEvent = e?.__chatuiClarificationAnswer;
      const clarificationRelationEvent = e?.__chatuiClarificationRelationAnswer;
      if (clarificationAnswerEvent || clarificationRelationEvent) {
        return handleClarificationMarkerEvent(e, clarificationAnswerEvent, clarificationRelationEvent);
      }
      return runSubmit(e);
    }

    async function handleClarificationMarkerEvent(e, answer, relationAnswer) {
      const clarification = root?.ChatUIServices?.clarification || root?.ChatUIClarificationService || {};
      const sessionId = String(deps.state?.activeSessionId || '');
      const session = (Array.isArray(deps.state?.sessions) ? deps.state.sessions : [])
        .find(item => item?.id === sessionId) || null;
      const pending = clarification.normalizePendingClarification?.(session?.pendingClarification) || null;
      if (!pending) {
        deps.toast?.('当前没有进行中的澄清任务。');
        return;
      }
      if (relationAnswer) {
        const resolved = clarification.applyPendingRelationAnswer?.(pending, relationAnswer) || null;
        if (!resolved) {
          deps.toast?.('任务关系选项无效，请重新选择。');
          return;
        }
        if (resolved.decision === 'new_task') {
          if (session) session.pendingClarification = undefined;
          deps.saveSessionsMeta?.();
          const currentText = String(deps.$?.('prompt')?.value || '').trim();
          return runSubmit(e, { promptOverride: currentText });
        }
        const baseText = pending.baseTaskText || pending.originalText || '';
        const routeContext = clarification.buildClarificationRouteContext?.({ baseContext: {}, pending }) || {};
        return runSubmit(e, {
          promptOverride: baseText,
          resolvedClarificationContext: routeContext,
          modelAttemptLedger: pending.routeInfo?.modelAttemptLedger || null,
          modelCalls: Number(pending.routeInfo?.modelCalls) || 0,
        });
      }
      const applied = clarification.applyPendingClarificationAnswer?.(pending, answer) || null;
      if (!applied) {
        deps.toast?.('澄清选项无效，请重新选择。');
        return;
      }
      if (!applied.complete) {
        deps.toast?.('还有未完成的选项，请继续选择。');
        return;
      }
      if (session) session.pendingClarification = undefined;
      deps.saveSessionsMeta?.();
      const baseText = applied.pending?.baseTaskText || applied.pending?.originalText || '';
      const routeContext = clarification.buildClarificationRouteContext?.({ baseContext: {}, pending: applied.pending }) || {};
      return runSubmit(e, {
        promptOverride: baseText,
        resolvedClarificationContext: routeContext,
        modelAttemptLedger: applied.pending?.routeInfo?.modelAttemptLedger || null,
        modelCalls: Number(applied.pending?.routeInfo?.modelCalls) || 0,
      });
    }

    async function runSubmit(e, options = {}) {
      with (deps) {

          e.preventDefault();
          const resumePendingSubmit=e?.__chatuiResumePendingSubmit||null,pendingActiveSubmit=resumePendingSubmit?null:loadPendingSubmit(state.activeSessionId);
          if(!resumePendingSubmit&&(isSessionBusy(state.activeSessionId)||pendingActiveSubmit)){
            pendingActiveSubmit&&setSessionBusy(state.activeSessionId,!0);
            const t=e?.submitter,s=t?.id==="sendBtn"||t?.closest?.("#sendBtn");
            if(state.suppressNextSubmitStop)return void(state.suppressNextSubmitStop=!1);
            return void(s?await stopActiveRun(state.activeSessionId):toast("当前正在处理，点击停止按钮可中断"))
          }
          if(hasPendingUploads())return updateSendAvailability(),void toast("文件还在处理中，请等待完成后再发送");
          state.suppressNextSubmitStop=!1;
          const rawPromptValue=String((options?.promptOverride!==undefined&&options?.promptOverride!==null&&options?.promptOverride!==""?options.promptOverride:(resumePendingSubmit?.rawPromptText??resumePendingSubmit?.promptText??$("prompt").value))),messageSizeGuard=(root?.ChatUICorePreflightGuards||(typeof window!=='undefined'?window.ChatUICorePreflightGuards:null)||{}).validateMessageSize?.(rawPromptValue);if(messageSizeGuard&&!messageSizeGuard.ok){resumePendingSubmit&&clearPendingSubmit(resumePendingSubmit.sessionId||state.activeSessionId);toast(messageSizeGuard.message||"消息过长，请改为上传文本文件或分段发送");return}const rawPromptText=rawPromptValue.trim();
          try { root?.ChatUIApp?.appContext?.getWorkflowModule?.('historyAnchorNav')?.cancelPendingJump?.({ clearSpacer: true }); } catch {}
          let promptText=rawPromptText;
          const resumeHasInput=jobLifecycle.pendingSubmitHasRecoverableInput?.(resumePendingSubmit)||!!(resumePendingSubmit&&(resumePendingSubmit.promptText||resumePendingSubmit.rawPromptText||resumePendingSubmit.imageContext||resumePendingSubmit.attachmentContext||Number(resumePendingSubmit.attachmentCount)>0));
          if(!promptText&&!state.attachments.length&&!resumeHasInput)return;
          unlockDoneSound({userGesture:!resumePendingSubmit&&(e?.isTrusted===!0||root.navigator?.userActivation?.isActive===!0)}),saveConfig(!0);
          const sessionId=resumePendingSubmit?.sessionId||state.activeSessionId,run=ensureActiveRun(sessionId),submissionId=resumePendingSubmit?.submissionId||jobLifecycle.makeSubmissionId?.()||`submit-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2,6)}`,startedAt=resumePendingSubmit?.startedAt||Date.now(),initialAttachmentCount=resumePendingSubmit?Math.max(0,Number(resumePendingSubmit.attachmentCount||0)||0):state.attachments.length,initialEditMessageIndex=resumePendingSubmit?parseOptionalMessageIndex(resumePendingSubmit.editMessageIndex):parseOptionalMessageIndex(state.editingIndex);let activeJobId="",activeJobKind="",handoffCommitted=!1,terminalCommitted=!1,attachments=resumePendingSubmit?[]:[...state.attachments],attachmentRestoreFailure=null,routeUi=null,assistantNode=null,liveItem=null;
          const submissionCancelled=()=>!!run.stopped||!!run.abortController?.signal?.aborted||!!state.disposedSessionIds?.has?.(sessionId)||!state.sessions?.some?.(item=>item.id===sessionId);
          const commitTerminalEvent=(type,details={})=>{if(!type||terminalCommitted)return!1;terminalCommitted=!0;emitTaskEvent(sessionId,type,details);return!0};
          try{
            if(!resumePendingSubmit&&!savePendingSubmit(sessionId,{submissionId,stage:"accepted",promptText,rawPromptText,submitMode:state.mode,userCommitted:!1,editExisting:initialEditMessageIndex!==null,editMessageIndex:initialEditMessageIndex,attachmentCount:initialAttachmentCount,startedAt})){clearActiveRun(sessionId,run);toast("无法保存任务恢复状态，请清理浏览器存储空间后重试");return}
            emitTaskEvent(sessionId,taskEvents.TASK_ACCEPTED,{submissionId});
            emitTaskEvent(sessionId,taskEvents.ATTACHMENT_CAPTURE_STARTED,{submissionId});
            setSessionBusy(sessionId,!0);
            if(resumePendingSubmit?.attachmentContext){if(typeof restoreUserAttachmentsFromContext!=="function")attachmentRestoreFailure=new Error("附件恢复服务不可用");else try{attachments=await restoreUserAttachmentsFromContext(resumePendingSubmit.attachmentContext);if(initialAttachmentCount>0&&(!Array.isArray(attachments)||attachments.length<initialAttachmentCount))attachmentRestoreFailure=new Error("附件恢复结果不完整")}catch(err){console.warn("restore pending submit attachments failed",err);attachments=[];attachmentRestoreFailure=err}}
            else if(resumePendingSubmit?.imageContext){if(typeof restoreImageAttachmentsFromContext!=="function")attachmentRestoreFailure=new Error("图片恢复服务不可用");else try{attachments=await restoreImageAttachmentsFromContext(resumePendingSubmit.imageContext);if(initialAttachmentCount>0&&(!Array.isArray(attachments)||attachments.length<initialAttachmentCount))attachmentRestoreFailure=new Error("图片恢复结果不完整")}catch(err){console.warn("restore pending submit images failed",err);attachments=[];attachmentRestoreFailure=err}}
            await prepareUserAttachmentPreviews(attachments);
            const initialUploadedContext=await buildUploadedImageContext(rawPromptText,attachments),initialAttachmentContextValue=await buildUserAttachmentContext(rawPromptText,attachments),initialImageContext=resumePendingSubmit?.imageContext||(initialUploadedContext?JSON.stringify(initialUploadedContext):""),initialAttachmentContext=resumePendingSubmit?.attachmentContext||(initialAttachmentContextValue?JSON.stringify(initialAttachmentContextValue):"");
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            const targetSession=state.sessions?.find?.(item=>item.id===sessionId),submitMode=resumePendingSubmit?.submitMode||state.mode;
            if(!targetSession){clearPendingSubmit(sessionId);return}
            const isTargetActive=()=>sessionId===state.activeSessionId;
            const persistTargetMessages=async()=>isTargetActive()?await saveChatHistory():"function"==typeof saveSessionMessages?await saveSessionMessages(sessionId,targetSession.messages||[]):void 0;
            const persistPendingTerminalMessages=async()=>{try{return await persistTargetMessages()}catch(err){const failure=err instanceof Error?err:new Error(String(err));failure.preservePendingSubmit=!0;throw failure}};
            const resumedMessageIndex=parseOptionalMessageIndex(resumePendingSubmit?.messageIndex);
            let messageIndex=initialEditMessageIndex!==null?initialEditMessageIndex:resumedMessageIndex!==null?resumedMessageIndex:(Array.isArray(targetSession?.messages)&&targetSession.messages.length?targetSession.messages.length:state.messages.length),resumeUserCommitted=resumePendingSubmit?jobLifecycle.isPendingSubmissionCommitted?.(targetSession.messages||[],resumePendingSubmit)!==!1:!1;
            const committedPendingMessage=resumePendingSubmit?jobLifecycle.findPendingSubmissionMessage?.(targetSession.messages||[],resumePendingSubmit):null;
            if(committedPendingMessage){const committedIndex=(targetSession.messages||[]).indexOf(committedPendingMessage);Number.isFinite(committedIndex)&&committedIndex>=0&&(messageIndex=committedIndex,resumeUserCommitted=!0)}
            const attachmentCaptureIncomplete=!!resumePendingSubmit&&initialAttachmentCount>0&&(!attachments.length||!!attachmentRestoreFailure);
            if(!savePendingSubmit(sessionId,{...resumePendingSubmit,submissionId,stage:"captured",promptText,rawPromptText,submitMode,messageIndex,userCommitted:resumeUserCommitted,editExisting:initialEditMessageIndex!==null,editMessageIndex:initialEditMessageIndex,attachmentCount:initialAttachmentCount,quoteContext:resumePendingSubmit?.quoteContext||"",imageContext:initialImageContext,attachmentContext:initialAttachmentContext,startedAt})){clearPendingSubmit(sessionId);toast("无法保存任务恢复状态，请清理浏览器存储空间后重试");return}
            emitTaskEvent(sessionId,taskEvents.ATTACHMENT_CAPTURED,{submissionId});
            const parseContextValue=submitHelpers.parseContextValue;
            const quotedMessage=resumePendingSubmit?.quoteContext?parseContextValue(resumePendingSubmit.quoteContext):(state.editingIndex===null?getQuotedMessage?.():(state.editingQuoteContext?parseContextValue(state.editingQuoteContext):null)),quoteContext=resumePendingSubmit?.quoteContext||(quotedMessage?JSON.stringify(quotedMessage):"");
            const withPendingQuotePreview=submitHelpers.withPendingQuotePreview;
            const getEffectiveRouteWithSlowNotice=(input,routeAttachments,headers,context,intentOptions={})=>{routeUi.startSlowNotice();return getEffectiveRoute(input,routeAttachments,sessionId,headers,context,{...intentOptions,onSlow:routeUi.showSlowNotice,onStage:routeUi.showSlowNotice,signal:run.abortController?.signal}).finally(()=>routeUi.stopSlowNotice())};
            let quotedImageContext=parseContextValue(quotedMessage?.imageContext),quotedImageAttachments=[],quotedImageRestoreFailure=null;
            let replacement=null,preparedChatJobId=resumePendingSubmit?.jobId||"",routeMode=submitMode,routeInfo=null,userNode=null,userDisplayItem=null,requestBaseMessages=null,imageContext="",attachmentContext="";
            routeUi=createRouteRecognitionUi({sessionId,assistantNode:()=>assistantNode,liveItem:()=>liveItem,responseIndex:()=>responseIndex,getPromptText:()=>promptText,getPreparedChatJobId:()=>preparedChatJobId,signal:run.abortController?.signal});

            if(initialEditMessageIndex!==null&&isTargetActive())replacement=applyPendingEdit(promptText,{submissionId,messageIndex:initialEditMessageIndex,node:state.editingNode}),replacement&&(messageIndex=replacement.index,resumeUserCommitted=!0);
            if(!replacement&&(!resumePendingSubmit||!resumeUserCommitted)){
              const userHtml=renderUserMessageWithAttachments(promptText,attachments),rawText=buildUserMessageContent(promptText,attachments),apiContent=buildUserApiContent(promptText,attachments),message={role:"user",content:apiContent,html:userHtml,rawText,messageIndex,submissionId};
              quoteContext&&(message.quoteContext=quoteContext);initialImageContext&&(message.imageContext=initialImageContext);if(initialAttachmentContext){message.attachmentContext=initialAttachmentContext;try{const parsed=JSON.parse(initialAttachmentContext);message.content=parsed.content||apiContent}catch{}}
              if(isTargetActive()){state.messages.push(message);getActiveSession().messages=cloneMessageList(state.messages)}
              else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),message]);
              userNode=isTargetActive()?addMessage("user",userHtml,{html:!0,rawText,messageIndex,quoteContext,imageContext:initialImageContext,attachmentContext:initialAttachmentContext}):null;
              userDisplayItem=appendSessionDisplayMessage(sessionId,"user",userHtml,{html:!0,rawText,messageIndex,quoteContext,imageContext:initialImageContext,attachmentContext:initialAttachmentContext});
              persistSessionDisplay(sessionId);
              if(userNode){userNode.__displayItem=userDisplayItem;userDisplayItem?.id&&(userNode.dataset.displayItemId=userDisplayItem.id);initialImageContext&&(userNode.dataset.imageContext=initialImageContext);initialAttachmentContext&&(userNode.dataset.attachmentContext=initialAttachmentContext)}
              await persistTargetMessages();resumeUserCommitted=!0
            }
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            if(!resumePendingSubmit)$("prompt").value="",state.promptDrafts.set(sessionId,""),clearAttachments(),clearQuotedMessage?.(),scheduleAutoResize();
            setSessionBusy(sessionId,!0);
            const sessionForReply=isTargetActive()?getActiveSession():targetSession;
            const resumedResponseIndex=parseOptionalMessageIndex(resumePendingSubmit?.responseIndex);
            responseIndex=resumedResponseIndex!==null?resumedResponseIndex:(Array.isArray(sessionForReply?.messages)&&sessionForReply.messages.length?sessionForReply.messages.length:state.messages.length);
            const prepareManagedChatJobForLiveItem=(jobMode=submitMode)=>{if("chat"!==jobMode)return"";if(!preparedChatJobId){const generatedJobId=typeof makeClientChatJobId==="function"?makeClientChatJobId():"";preparedChatJobId=String(generatedJobId||`chatjob-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2,6)}`)}if(!liveItem)return preparedChatJobId;liveItem.jobId=preparedChatJobId;liveItem.responseIndex=String(responseIndex);assistantNode&&(assistantNode.dataset.jobId=preparedChatJobId,assistantNode.dataset.responseIndex=String(responseIndex));persistSessionDisplay(sessionId);return preparedChatJobId};
            const routingStatus=executionStatus.routeStageText?.("reading_context")||"正在读取当前对话上下文";
            if(resumePendingSubmit){
              const displayItems=sessionForReply?.display||[],pendingDisplayId=jobLifecycle.pendingSubmitDisplayId?.(resumePendingSubmit)||resumePendingSubmit.liveItemId||"";
              liveItem=(pendingDisplayId&&displayItems.find(item=>item.id===pendingDisplayId))||displayItems.find(item=>String(item.responseIndex||"")===String(responseIndex)&&item.pending)||null;
              if(!liveItem&&sessionForReply)liveItem=appendSessionDisplayMessage(sessionId,"assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,pending:!0,responseIndex,id:pendingDisplayId});
              else if(liveItem)updateSessionDisplayItem(sessionId,liveItem,"assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,pending:!0,responseIndex});
              assistantNode=isTargetActive()&&liveItem&&typeof findMessageNodeByDisplayItem==="function"?findMessageNodeByDisplayItem(liveItem):null;
              if(!assistantNode&&isTargetActive()){
                assistantNode=addMessage("assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,skipSave:!0,responseIndex});
                const anchor=[...$("messages").querySelectorAll(".message")].find(node=>node!==assistantNode&&Number(node.classList.contains("user")?node.dataset.messageIndex:node.dataset.responseIndex)>Number(responseIndex));
                anchor?.parentNode?.insertBefore(assistantNode,anchor);
              }
              assistantNode&&(assistantNode.__displayItem=liveItem,liveItem?.id&&(assistantNode.dataset.displayItemId=liveItem.id),assistantNode.dataset.responseIndex=String(responseIndex),updateMessage(assistantNode,pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,responseIndex,skipSave:!0,noScroll:!0}));
            }
            else if(replacement){const prepared=prepareReplacementResponse(replacement,sessionId,routingStatus);assistantNode=prepared.node;liveItem=prepared.liveItem;prepareManagedChatJobForLiveItem();if(typeof replaceSessionMessages==="function")await replaceSessionMessages(sessionId,state.messages,{lastGeneratedImage:null});else await persistTargetMessages()}
            else {
              const displayItems=sessionForReply?.display||[],pendingDisplayId=jobLifecycle.pendingSubmitDisplayId?.({submissionId})||"";
              liveItem=(pendingDisplayId&&displayItems.find(item=>item.id===pendingDisplayId&&item.pending))||null;
              assistantNode=isTargetActive()&&liveItem&&typeof findMessageNodeByDisplayItem==="function"?findMessageNodeByDisplayItem(liveItem):null;
              if(!assistantNode&&isTargetActive())assistantNode=addMessage("assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,skipSave:!0,responseIndex});
              if(sessionForReply){
                if(liveItem)updateSessionDisplayItem(sessionId,liveItem,"assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,pending:!0,responseIndex});
                else liveItem=appendSessionDisplayMessage(sessionId,"assistant",pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,pending:!0,responseIndex,id:pendingDisplayId});
                assistantNode&&(assistantNode.__displayItem=liveItem,liveItem?.id&&(assistantNode.dataset.displayItemId=liveItem.id),assistantNode.dataset.responseIndex=String(responseIndex),updateMessage(assistantNode,pendingFeedbackHtml(routingStatus),{html:!0,rawText:routingStatus,responseIndex,skipSave:!0,noScroll:!0}));
                prepareManagedChatJobForLiveItem()
              }
            }
            if(userNode&&userDisplayItem&&typeof insertMessageNodeAtDisplayPosition==="function")insertMessageNodeAtDisplayPosition(userNode,userDisplayItem);
            if(!savePendingSubmit(sessionId,{submissionId,stage:"routing",promptText,rawPromptText,submitMode,messageIndex,responseIndex,userCommitted:resumeUserCommitted,editExisting:initialEditMessageIndex!==null,editMessageIndex:initialEditMessageIndex,attachmentCount:initialAttachmentCount,jobId:preparedChatJobId,liveItemId:liveItem?.id||"",userDisplayItemId:userDisplayItem?.id||resumePendingSubmit?.userDisplayItemId||"",quoteContext,imageContext:initialImageContext,attachmentContext:initialAttachmentContext,startedAt}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");
            emitTaskEvent(sessionId,taskEvents.ROUTING_STARTED,{submissionId});
            const finishPreflightReply=async(text,meta={})=>{
              const displayContent=String(text??"");
              const rawText=String(meta.rawText??displayContent);
              const isHtml=meta.html===!0;
              const clarificationId=String(meta.clarificationId||"");
              const msg={role:"assistant",content:rawText,rawText,responseIndex,submissionId,...isHtml?{html:displayContent}:{},...clarificationId?{clarificationId}:{}};
              if(assistantNode?.isConnected){
                delete assistantNode.dataset.jobId;
                typeof updateMessage==="function"&&updateMessage(assistantNode,displayContent,{html:isHtml,rawText,responseIndex,metaText:meta.metaText||""});
                clarificationId&&(assistantNode.dataset.clarificationId=clarificationId);
              }
              if(liveItem){
                delete liveItem.jobId;
                clarificationId&&(liveItem.clarificationId=clarificationId);
                if(typeof updateSessionDisplayItem==="function")updateSessionDisplayItem(sessionId,liveItem,"assistant",displayContent,{html:isHtml,rawText,pending:!1,responseIndex,metaText:meta.metaText||"",clarificationId});
                else{liveItem.content=rawText;liveItem.rawText=rawText;liveItem.html=isHtml?displayContent:"";liveItem.pending=!1;persistSessionDisplay(sessionId)}
              }
              if(isTargetActive()){state.messages.push(msg);sessionForReply&&(sessionForReply.messages=cloneMessageList(state.messages))}
              else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),msg]);
              await persistPendingTerminalMessages();
              commitTerminalEvent(meta.terminalEvent||taskEvents.TASK_COMPLETED_COMMITTED,{submissionId,...meta.error?{error:meta.error}:{}});
              clearPendingSubmit(sessionId);
              preparedChatJobId&&typeof clearChatJob==="function"&&clearChatJob(sessionId);
              preparedChatJobId="";
              saveSessionsMeta?.();
              return true
            };
            if(attachmentCaptureIncomplete)return finishPreflightReply("页面刷新后未能完整恢复原始附件。为避免模型在缺少资源时继续执行，请重新上传附件后再试。",{metaText:"未发送到模型"});
            const preflightText=String(promptText||"").trim(),preflightGuard=root?.ChatUICorePreflightGuards||window.ChatUICorePreflightGuards||{};
            const hasPreviousFileContext=()=>{const messages=targetSession.messages||state.messages||[];return messages.some(message=>{const context=parseContextValue(message?.attachmentContext);return Array.isArray(context?.attachments)&&context.attachments.some(item=>item&&!String(item.type||item.mime||'').startsWith('image/'))})};
            const hasQuotedImageContext=!!(quotedImageContext?.attachments?.length);
            const preflightConfig=typeof getConfig==="function"?getConfig():{};if(typeof getSessionRouteModel==="function"&&!String(preflightConfig.routeModel||"").trim())preflightConfig.routeModel=getSessionRouteModel(sessionId,preflightConfig);const preflightDecision=preflightGuard.buildPreflightDecision?.({input:preflightText,attachments,previousAssistantCount:(targetSession.messages||[]).filter(m=>m&&m.role==="assistant").length,config:preflightConfig,isImageFile:typeof isImageFile==="function"?isImageFile:void 0,hasPreviousEditableImage:!!(typeof getLatestUploadedImageContext==="function"&&getLatestUploadedImageContext(sessionId)),hasPreviousFileContext:hasPreviousFileContext(),hasQuotedImageContext,recentMessages:targetSession.messages||state.messages||[]});
            if(preflightDecision?.action==="reply")return finishPreflightReply(preflightDecision.message,{metaText:preflightDecision.metaText});
            if(quotedImageContext?.attachments?.length){
              if(typeof restoreImageAttachmentsFromContext!=="function")quotedImageRestoreFailure=new Error("引用图片恢复服务不可用");
              else try{quotedImageAttachments=await restoreImageAttachmentsFromContext(quotedImageContext);if(!Array.isArray(quotedImageAttachments)||quotedImageAttachments.length<quotedImageContext.attachments.length)quotedImageRestoreFailure=new Error("引用图片恢复结果不完整")}catch(e){console.warn("restore quoted image attachments failed",e);quotedImageAttachments=[];quotedImageRestoreFailure=e}
              if(quotedImageRestoreFailure)return finishPreflightReply("引用消息中的图片当前无法完整恢复。为避免脱离引用内容继续执行，请重新发送或重新上传图片后再试。",{metaText:"未发送到模型"})
            }
            let requestAttachments=quotedImageAttachments.length?[...quotedImageAttachments,...attachments]:attachments;
            const routeUtils=root?.ChatUIRouteService||root?.ChatUIServices?.route||(typeof require==="function"?require("../services/route-service"):{});
            const quotedFileCandidates=typeof deps?.quotedFileCandidatesFromContext==="function"?deps.quotedFileCandidatesFromContext(quotedMessage?.attachmentContext||quotedMessage?.attachment_context||""):[];
            const quotedRoute=submitHelpers.buildQuotedRouteContext({quotedMessage,quotedImageContext,restoredImageAttachments:quotedImageAttachments,quotedFileCandidates,currentInput:promptText,cleanQuotedContent:routeUtils.cleanQuotedContent,buildQuotedRouteContent:routeUtils.buildQuotedRouteContent});
            const hasQuotedMessage=quotedRoute.hasQuotedMessage,buildQuotedRouteContext=()=>quotedRoute.context;
            const originalImageIndex=submitHelpers.originalImageIndex;
            const isImageAttachment=item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/");
            const clarification=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{},intentDeadlineAt=Date.now()+INTENT_PIPELINE_DEADLINE_MS;
            const rawStoredPending=targetSession.pendingClarification;
            let storedPending=clarification.normalizePendingClarification?.(rawStoredPending)||null;
            if(storedPending&&String(rawStoredPending?.id||"")!==String(storedPending.id||"")){targetSession.pendingClarification=storedPending;sessionForReply&&(sessionForReply.pendingClarification=storedPending);saveSessionsMeta?.()}
            const inheritedModelAttemptLedger=options?.modelAttemptLedger||storedPending?.routeInfo?.modelAttemptLedger||null;
            const inheritedModelCalls=Number(options?.modelCalls)||Number(storedPending?.routeInfo?.modelCalls)||0;
            const editedMessage=initialEditMessageIndex!==null
              ? (targetSession.messages||[])[initialEditMessageIndex]||null
              : null;
            const editedClarificationReplay=clarification.normalizeClarificationReplay?.(editedMessage?.clarificationReplay)||null;
            const currentTurnAttachments=[...attachments];
            const clearStoredPendingClarification=()=>{if(!storedPending)return;const pendingId=String(storedPending.id||"");if(!pendingId||String(targetSession.pendingClarification?.id||"")===pendingId)delete targetSession.pendingClarification;if(sessionForReply&&(!pendingId||String(sessionForReply.pendingClarification?.id||"")===pendingId))delete sessionForReply.pendingClarification;saveSessionsMeta?.()};
            const pendingMerge=storedPending?clarification.mergePendingInput?.(storedPending,{promptText:rawPromptText||promptText})||null:null;
            const pendingAttachmentContexts=storedPending?[...new Map([
              ...(clarification.pendingAttachmentContexts?.(storedPending)||[]),
              ...(clarification.collectPendingAttachmentContexts?.({messages:targetSession.messages||state.messages||[],routeInfo:storedPending.routeInfo,sourceAttachmentContext:storedPending.sourceAttachmentContext})||[]),
            ].map(context=>[JSON.stringify(context),context])).values()]:[];
            let continuationRequestAttachments=currentTurnAttachments;
            if(storedPending&&pendingAttachmentContexts.length){
              if(typeof restoreUserAttachmentsFromContext!=="function")throw new Error("无法恢复澄清任务引用的原始附件，请重新上传后再试");
              const restoredPendingAttachments=[],pendingOrigins=clarification.pendingResourceOrigins?.(storedPending)||[];
              const withPendingOrigin=item=>{const type=isImageAttachment(item)?"image":"file",id=submitHelpers.mediaIdentity?.(item,type)||"",referenceId=String(item?.referenceId||item?.reference_id||"");const origin=pendingOrigins.find(resource=>resource.type===type&&(id&&resource.id===id||referenceId&&resource.reference_id===referenceId));return {...item,routeSource:origin?.source||"history",sourceIndex:Number(origin?.index)||Number(item?.sourceIndex||item?.source_index)||void 0}};
              for(const context of pendingAttachmentContexts){
                const restored=await restoreUserAttachmentsFromContext(context);
                if(!Array.isArray(restored)||!restored.length)throw new Error("澄清任务引用的原始附件当前不可用，请重新上传后再试");
                restoredPendingAttachments.push(...restored.map(withPendingOrigin))
              }
              continuationRequestAttachments=submitHelpers.mergeContinuationAttachments?.({pending:restoredPendingAttachments,current:currentTurnAttachments,isImageFile:isImageAttachment})||[...restoredPendingAttachments,...currentTurnAttachments];
            }
            const pendingQuoteContext=storedPending?JSON.stringify({role:"user",content:storedPending.baseTaskText||storedPending.originalText||"追问来源",sessionId,...storedPending.sourceImageContext?{imageContext:storedPending.sourceImageContext}:{},...storedPending.sourceAttachmentContext?{attachmentContext:storedPending.sourceAttachmentContext}:{},...storedPending.sourceQuoteContext?{quoteContext:storedPending.sourceQuoteContext}:{}}):"";
            const revisedClarificationReplay=!storedPending&&editedClarificationReplay
              ? clarification.reviseClarificationReplay?.(editedClarificationReplay,rawPromptText)||editedClarificationReplay
              : null;
            if(revisedClarificationReplay)promptText=revisedClarificationReplay.resolvedInput;
            let effectivePromptText=promptText;
            let resolvedClarificationContext = options?.resolvedClarificationContext || null;
            if (!resolvedClarificationContext && storedPending) {
              const pendingSlots = Array.isArray(storedPending.routeInfo?.clarificationSlots)
                ? storedPending.routeInfo.clarificationSlots
                : [];
              const textAnswer = clarification.parseClarificationAnswer?.(rawPromptText, {
                clarificationId: storedPending.id,
                slots: pendingSlots,
                existingAnswer: storedPending.clarificationAnswer || null,
              }) || null;
              if (textAnswer) {
                const applied = clarification.applyPendingClarificationAnswer?.(storedPending, textAnswer) || null;
                if (applied?.complete) {
                  resolvedClarificationContext = clarification.buildClarificationRouteContext?.({ baseContext: {}, pending: applied.pending }) || {};
                  clearStoredPendingClarification();
                  storedPending = null;
                  promptText = applied.pending?.baseTaskText || applied.pending?.originalText || promptText;
                }
              }
            }
            effectivePromptText = promptText;
            const routeContextBuilder=typeof deps?.buildRouteContext==="function"?deps.buildRouteContext:typeof root?.buildRouteContext==="function"?root.buildRouteContext:null;
            const clarificationRouteContext=resolvedClarificationContext||(storedPending?clarification.buildClarificationRouteContext?.({baseContext:routeContextBuilder?routeContextBuilder(sessionId):{},quotedContext:hasQuotedMessage?buildQuotedRouteContext():null,pending:storedPending}):null);
            const currentRouteTurn={messageIndex:Number(messageIndex)+1};
            if(storedPending&&!clarificationRouteContext)throw new Error("澄清上下文未能通过结构化校验，已停止发送");
            let pendingTransition=createPendingTransition(storedPending,{shouldClearPending:false});
            if(!replacement&&(pendingMerge?.merged||(typeof hasImageAttachments==="function"&&hasImageAttachments(attachments))||attachments.some(e=>String(e?.type||e?.file?.type||"").startsWith("image/")))){
              const visualPromptText=pendingMerge?.merged?(pendingMerge.supplementText||rawPromptText||""):promptText,visualAttachments=pendingMerge?.merged?currentTurnAttachments:attachments,visualQuoteContext=pendingQuoteContext||quoteContext;
              const refreshedUserHtml=withPendingQuotePreview(renderUserMessageWithAttachments(visualPromptText||"已发送附件",visualAttachments),visualQuoteContext),refreshedRawText=buildUserMessageContent(visualPromptText,visualAttachments),messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message){message.html=refreshedUserHtml;message.rawText=refreshedRawText;visualQuoteContext&&(message.quoteContext=visualQuoteContext)}
              if(userDisplayItem){userDisplayItem.html=refreshedUserHtml;userDisplayItem.rawText=refreshedRawText;visualQuoteContext&&(userDisplayItem.quoteContext=visualQuoteContext);persistSessionDisplay(sessionId)}
              if(userNode?.isConnected){
                if(updateMessage)updateMessage(userNode,refreshedUserHtml,{html:!0,rawText:refreshedRawText,messageIndex,quoteContext:visualQuoteContext,skipSave:!0,noScroll:!0});
                else{const e=userNode.querySelector?.(".content");e&&(e.innerHTML=refreshedUserHtml);visualQuoteContext&&(userNode.dataset.quoteContext=visualQuoteContext)}
                visualQuoteContext&&(userNode.dataset.quoteContext=visualQuoteContext,userNode.classList?.add?.("has-quote"))
              }
              await persistTargetMessages()
            }
            if(!replacement){
              imageContext=initialImageContext;attachmentContext=initialAttachmentContext;
              if(userDisplayItem){userDisplayItem.imageContext=imageContext;userDisplayItem.attachmentContext=attachmentContext;persistSessionDisplay(sessionId)}
              const messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message){imageContext&&(message.imageContext=imageContext);if(attachmentContext){message.attachmentContext=attachmentContext;try{const parsed=JSON.parse(attachmentContext);message.content=parsed.content||buildUserApiContent(promptText,attachments)}catch{message.content=buildUserApiContent(promptText,attachments)}}quoteContext&&(message.quoteContext=quoteContext)}
              if(userNode){imageContext&&(userNode.dataset.imageContext=imageContext);attachmentContext&&(userNode.dataset.attachmentContext=attachmentContext);quoteContext&&(userNode.dataset.quoteContext=quoteContext)}
              if(replacement?.node){imageContext&&(replacement.node.dataset.imageContext=imageContext);attachmentContext&&(replacement.node.dataset.attachmentContext=attachmentContext);quoteContext&&(replacement.node.dataset.quoteContext=quoteContext);if(replacement.node.__displayItem){imageContext&&(replacement.node.__displayItem.imageContext=imageContext);attachmentContext&&(replacement.node.__displayItem.attachmentContext=attachmentContext);quoteContext&&(replacement.node.__displayItem.quoteContext=quoteContext)}}
              await persistTargetMessages()
            }
            if(pendingMerge?.merged){
               try{routeInfo=await getEffectiveRouteWithSlowNotice(effectivePromptText,continuationRequestAttachments,{},clarificationRouteContext,{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn,submissionId,modelAttemptLedger:inheritedModelAttemptLedger,modelCalls:inheritedModelCalls}),routeMode=routeInfo.mode}catch(e){throw e}
            }else if(hasQuotedMessage){
               try{
                 // A user-selected quote is an explicit task boundary: route intent
                 // against that message only. The current turn's attachments still
                 // travel separately, but unrelated session history must not change
                 // what the quoted follow-up means.
                 const quoteScopedRouteContext=buildQuotedRouteContext();
                 routeInfo=await getEffectiveRouteWithSlowNotice(promptText,currentTurnAttachments,{},quoteScopedRouteContext,{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn,submissionId,modelAttemptLedger:inheritedModelAttemptLedger,modelCalls:inheritedModelCalls}),routeMode=routeInfo.mode
               }catch(e){throw e}
             }else try{routeInfo=await getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,{},clarificationRouteContext,{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn,submissionId,modelAttemptLedger:inheritedModelAttemptLedger,modelCalls:inheritedModelCalls}),routeMode=routeInfo.mode}catch(e){throw e}
            const routeOutcome=typeof normalizeRouteOutcome==="function"?normalizeRouteOutcome(routeInfo):(routeInfo?.needClarification?"business_clarification":"ready");
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            if(routeOutcome===ROUTE_OUTCOMES?.CANCELLED){clearPendingSubmit(sessionId);commitTerminalEvent(taskEvents.TASK_STOPPED,{submissionId});return}
            if(typeof isRouteFailureOutcome==="function"&&isRouteFailureOutcome(routeOutcome)){
              const message=String(routeInfo?.outcomeMessage||routeInfo?.clarificationQuestion||"本次路由未完成，请重试。");
              const routeFailure=new Error(message);routeFailure.code=String(routeInfo?.evidence||"ROUTE_OUTCOME_FAILURE");routeFailure.routeOutcome=routeOutcome;
              return finishPreflightReply(message,{metaText:routeInfo?.retryable===!0?"可重试":"未发送到执行模型",terminalEvent:taskEvents.TASK_FAILED,error:routeFailure})
            }
            const routeRelation=String(routeInfo?.relation||"new");
            const continuesPending=!!storedPending&&["followup","continuation"].includes(routeRelation);
            if(continuesPending){
              effectivePromptText=pendingMerge?.promptText||promptText;
              pendingTransition=createPendingTransition(storedPending,{shouldClearPending:true})
            }else if(storedPending){
              effectivePromptText=promptText;
              pendingTransition=createPendingTransition(storedPending,{shouldClearPending:true})
            }
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            if(routeOutcome===ROUTE_OUTCOMES?.BUSINESS_CLARIFICATION){
              const e=routeInfo.clarificationQuestion||"请补充完成当前任务所需的信息后继续。";
              const presentationApi=root?.ChatUIApp?.appContext?.getWorkflowModule?.("clarificationPresentation");
              const clarificationSession=targetSession||sessionForReply;
              const presentation=presentationApi?.buildClarificationPresentation?.(routeInfo,{
                messages:clarificationSession?.messages||state.messages||[],
                lastGeneratedImage:sessionId===state.activeSessionId?state.lastGeneratedImage:clarificationSession?.lastGeneratedImage,
                currentImageContext:imageContext||null,
                quotedImageContext:quotedImageContext||null,
              })||{rawText:e,html:"",hasImageChoices:!1};
              const clarificationHtml=String(presentation.html||""),displayContent=clarificationHtml||e;
              const createdPending=continuesPending?clarification.normalizePendingClarification?.({...pendingMerge.pending,clarificationText:e,routeInfo,updatedAt:Date.now()}):clarification.createPendingClarification?.({messages:sessionForReply.messages||targetSession.messages||state.messages||[],clarificationText:e,routeInfo,sourceImageContext:imageContext||null,sourceAttachmentContext:attachmentContext||null,sourceQuoteContext:quoteContext||null});
              const clarificationId=createdPending?String(createdPending?.id||""):"";
              const clarificationRecord=clarificationId?{schema_version:"clarification_presentation.v1",id:clarificationId,question:e,routeInfo,sourceImageContext:imageContext||null,sourceQuoteContext:quoteContext||null}:null;
              const t={role:"assistant",content:e,rawText:e,responseIndex,...clarificationHtml?{html:clarificationHtml}:{},...clarificationId?{clarificationId}:{},...clarificationRecord?{clarification:clarificationRecord}:{}};
              typeof updateMessage==="function"&&assistantNode?.isConnected&&(delete assistantNode.dataset.jobId,updateMessage(assistantNode,displayContent,{html:!!clarificationHtml,rawText:e,responseIndex}));
              assistantNode?.isConnected&&clarificationId&&(assistantNode.dataset.clarificationId=clarificationId);
              liveItem&&(delete liveItem.jobId,clarificationId&&(liveItem.clarificationId=clarificationId),typeof updateSessionDisplayItem==="function"?updateSessionDisplayItem(sessionId,liveItem,"assistant",displayContent,{html:!!clarificationHtml,rawText:e,pending:!1,responseIndex,clarificationId}):(liveItem.content=e,liveItem.rawText=e,liveItem.html=clarificationHtml,liveItem.pending=!1,persistSessionDisplay(sessionId)));
              if(isTargetActive()){state.messages.push(t);sessionForReply.messages=cloneMessageList(state.messages)}else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),t]);
              if(createdPending){targetSession.pendingClarification=createdPending;sessionForReply&&(sessionForReply.pendingClarification=createdPending)}
              await persistPendingTerminalMessages();commitTerminalEvent(taskEvents.TASK_COMPLETED_COMMITTED,{submissionId});clearPendingSubmit(sessionId);preparedChatJobId&&typeof clearChatJob==="function"&&clearChatJob(sessionId);preparedChatJobId="";saveSessionsMeta?.();return
            }
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0){const e=new Error("路由任务尚未完成资源确认，已停止发送");e.code="ROUTE_NOT_READY";throw e}
            const clarificationReplay=continuesPending
              ? clarification.createClarificationReplay?.({pending:storedPending,merge:{...pendingMerge,promptText:effectivePromptText,resolvedInput:effectivePromptText},routeInfo,clarificationRouteContext})
              : revisedClarificationReplay;
            if(clarificationReplay){
              const messages=isTargetActive()?state.messages:targetSession.messages||[];
              const userMessage=messages.find(item=>item?.role==="user"&&String(item.messageIndex)===String(messageIndex))||[...messages].reverse().find(item=>item?.role==="user");
              if(userMessage)userMessage.clarificationReplay=clarificationReplay;
              if(userDisplayItem)userDisplayItem.clarificationReplay=clarificationReplay;
              if(replacement?.node?.__displayItem)replacement.node.__displayItem.clarificationReplay=clarificationReplay;
              await persistTargetMessages();
            }
            if(isTargetActive()&&updateModeUi(routeMode,state.autoMode),isTargetActive()&&warnMissingModel(routeMode,!0)){const message="chat"===routeMode?"请先在设置里选择聊天模型":"请先在设置里选择生图模型";return finishPreflightReply(message,{metaText:"未发送到模型"})}
            const imageAttachmentIndexGuide=(list=[])=>submitHelpers.imageAttachmentIndexGuide(list,{isImageFile:isImageAttachment,originalIndex:originalImageIndex});
            const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(routeInfo,targetSession.messages||state.messages||[],quotedMessage)||null,hasRouteMessageRefs=Array.isArray(routeInfo?.messageRefs)&&routeInfo.messageRefs.length>0;
            if(hasRouteMessageRefs&&!routeMessageProjection)throw new Error("路由选择的历史消息已不存在或不再匹配，已停止发送以避免脱离指定上下文回答");
            const quoteScopedChat=!!quotedMessage&&!continuesPending&&(!hasRouteMessageRefs||routeMessageProjection?.usesExplicitQuote);
            requestBaseMessages=Array.isArray(resumePendingSubmit?.requestBaseMessages)?resumePendingSubmit.requestBaseMessages:(routeMessageProjection?.messages||(quoteScopedChat?[quotedMessage]:replacement&&isTargetActive()?state.messages.slice(0,replacement.index):null));
            const restoreBoundImagePool=source=>submitHelpers.restoreBoundImagePool(routeInfo,{source,sessionId,getPreviousImageAttachments});
            const quotedResourceAttachments=[...quotedImageAttachments];
            if(quotedMessage?.attachmentContext&&typeof restoreUserAttachmentsFromContext==="function"){
              const restoredQuote=await restoreUserAttachmentsFromContext(quotedMessage.attachmentContext);
              for(const item of restoredQuote){
                const type=isImageAttachment(item)?"image":"file",id=submitHelpers.mediaIdentity?.(item,type)||"";
                if(!quotedResourceAttachments.some(existing=>isImageAttachment(existing)===isImageAttachment(item)&&id&&submitHelpers.mediaIdentity?.(existing,type)===id))quotedResourceAttachments.push(item)
              }
            }
            const historyFiles=await submitHelpers.restoreHistoricalFilePool(routeInfo,{messages:targetSession.messages||state.messages||[],restoreUserAttachmentsFromContext,isImageFile:isImageAttachment,source:"history"});
            const contextFiles=await submitHelpers.restoreHistoricalFilePool(routeInfo,{messages:targetSession.messages||state.messages||[],restoreUserAttachmentsFromContext,isImageFile:isImageAttachment,source:"context"});
            // A clarification answer can arrive without any new text. In that
            // case pendingMerge.merged is false, but the original image
            // attachments were restored into continuationRequestAttachments and
            // are still required to resolve the selected r1/r2 resource.
            const pendingSourcePools=storedPending && continuationRequestAttachments.length
              ? submitHelpers.partitionExecutionAttachmentsBySource?.(continuationRequestAttachments,{isImageFile:isImageAttachment})
              : null;
            const mergeSourcePool=(left,right)=>submitHelpers.mergeContinuationAttachments?.({pending:left,current:right,isImageFile:isImageAttachment})||[...(left||[]),...(right||[])];
            const sourcePools={
              current:pendingSourcePools?.current||currentTurnAttachments,
              quoted:mergeSourcePool(pendingSourcePools?.quoted||[],quotedResourceAttachments),
              history:mergeSourcePool(pendingSourcePools?.history||[],[...await restoreBoundImagePool("history"),...historyFiles]),
              context:mergeSourcePool(pendingSourcePools?.context||[],[...await restoreBoundImagePool("context"),...contextFiles]),
            };
            // A compiled image batch contains independent child contracts. The
            // outer route may not list every child's target/reference, so using
            // its restricted pools projects only the first child (or an empty
            // set) and silently reuses the wrong image. Build the full runtime
            // pools for a batch, then project each child against its own route.
            const imageBatchPlan=submitHelpers.executableImageBatch?.(routeInfo);
            const restrictedSourcePools=imageBatchPlan
              ? sourcePools
              : submitHelpers.restrictExecutionResourcePools?.(routeInfo,sourcePools)||sourcePools;
            const executionPools=submitHelpers.buildExecutionResourcePools(restrictedSourcePools,{isImageFile:isImageAttachment,messages:routeMessageProjection?.messages||targetSession.messages||state.messages||[]});
            const executionMedia=imageBatchPlan
              ? null
              : submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools);
            const routeExecutionAnchor=submitHelpers.routeExecutionAnchor?.(routeInfo)||null;
            if(routeExecutionAnchor){
              const messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message)message.routeExecutionAnchor=routeExecutionAnchor;
              if(userDisplayItem)userDisplayItem.routeExecutionAnchor=routeExecutionAnchor;
              await persistTargetMessages();
              userDisplayItem&&persistSessionDisplay(sessionId)
            }
            const chatAttachments=executionMedia
              ? await prepareChatImageAttachments([...executionMedia.chatFiles,...executionMedia.chatImages])
              : [];
            const mediaMapContext=executionMedia
              ? submitHelpers.buildMediaMapContext?.(executionMedia.chatImages,{isImageFile:isImageAttachment,originalIndex:originalImageIndex})||""
              : "";
            // dispatch_contract.v1 is the final execution authority. Quoted
            // assistant text and raw composer input are routing evidence or
            // presentation data; they must not be appended after the contract
            // has resolved a canonical provider prompt.
            const imagePrompt=String(routeInfo?.dispatchContract?.arguments?.prompt||"").trim();
            if("chat"!==routeMode&&!imagePrompt){const error=new Error("图片任务缺少已校验的执行指令，已停止发送");error.code="IMAGE_EXECUTION_PROMPT_MISSING";throw error}
            const chatPrompt=String(routeInfo.dispatchContract?.arguments?.prompt||routeInfo.executionPrompt||effectivePromptText).trim()||effectivePromptText;
            const editAttachments=executionMedia?.imageInputs || [];
            const executionApi=routeInfo.api||("image"===routeMode?"image_generation":"edit_image"===routeMode?"image_edit":"chat");const dispatchMode=executionApi==="image_generation"?"image":executionApi==="image_edit"?"edit_image":"chat";if(isTargetActive()&&liveItem&&(!assistantNode||!assistantNode.isConnected)&&typeof findMessageNodeByDisplayItem==="function")assistantNode=findMessageNodeByDisplayItem(liveItem)||assistantNode;const replacementResponseIndex=replacement?.responseIndex??(resumePendingSubmit?responseIndex:void 0),completeDurableHandoff=(jobId,jobKind)=>{if(handoffCommitted)return!1;handoffCommitted=!0;pendingTransition.consumeOnHandoff&&clearStoredPendingClarification();emitTaskEvent(sessionId,taskEvents.HANDOFF_COMMITTED,{submissionId,jobId,jobKind});clearPendingSubmit(sessionId);return!0},completeInterfaceTask=(completion={})=>{const completionSessionId=String(completion.sessionId||""),completionSubmissionId=String(completion.submissionId||""),completionJobId=String(completion.jobId||""),completionJobKind=String(completion.jobKind||"");if(!completionSessionId||!completionSubmissionId||!completionJobId||!completionJobKind)return!1;if(completionSessionId!==String(sessionId)||completionSubmissionId!==String(submissionId)||completionJobId!==String(activeJobId)||completionJobKind!==String(activeJobKind))return!1;if(!commitTerminalEvent(taskEvents.JOB_COMPLETED_COMMITTED,{submissionId,jobId:activeJobId,jobKind:activeJobKind}))return!1;finishSessionTask(sessionId,{run});return!0};if("chat"===dispatchMode){prepareManagedChatJobForLiveItem("chat");if(!preparedChatJobId)throw new Error("无法创建聊天任务恢复标识，请重试");if(!savePendingSubmit(sessionId,{...loadPendingSubmit(sessionId),jobId:preparedChatJobId,jobKind:"chat",stage:"handoff"}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");activeJobId=preparedChatJobId;activeJobKind="chat";emitTaskEvent(sessionId,taskEvents.HANDOFF_PREPARED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});await sendChat(chatPrompt,chatAttachments,assistantNode,{sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacementResponseIndex,requestBaseMessages,quotedMessage:quoteScopedChat?quotedMessage:null,systemContext:mediaMapContext?[mediaMapContext]:[],routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0,dispatchContract:routeInfo.dispatchContract,executionMedia,clarificationReplay,clientJobId:preparedChatJobId,submissionId,onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind),onInterfaceCompleted:completeInterfaceTask});completeDurableHandoff(activeJobId,activeJobKind);completeInterfaceTask({sessionId,submissionId,jobId:activeJobId,jobKind:activeJobKind})}else{if(imageBatchPlan){const compiledBatch=imageBatchPlan,batchJobId=typeof makeClientBatchJobId==="function"?makeClientBatchJobId():`imgbatch-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2,6)}`;if(!savePendingSubmit(sessionId,{...loadPendingSubmit(sessionId),jobId:batchJobId,jobKind:"image_batch",stage:"handoff"}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");activeJobId=batchJobId;activeJobKind="image_batch";emitTaskEvent(sessionId,taskEvents.HANDOFF_PREPARED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});preparedChatJobId="";const batchParent=liveItem||appendSessionDisplayMessage(sessionId,"assistant",pendingFeedbackHtml(`正在生成 0/${compiledBatch.items.length} 张图片`),{html:!0,rawText:`正在生成 0/${compiledBatch.items.length} 张图片`,pending:!0,responseIndex});if(!batchParent?.id){const error=new Error("多图任务缺少可恢复的显示记录，已停止发送");error.code="IMAGE_BATCH_DISPLAY_ITEM_MISSING";throw error}batchParent.jobId=batchJobId;batchParent.pending="1";persistSessionDisplay(sessionId);assistantNode&&(assistantNode.dataset.jobId=batchJobId,clearPendingFeedback?.(assistantNode),clearReasoning?.(assistantNode));const batchAggregate={total:compiledBatch.items.length,completed:0,failed:0,statuses:compiledBatch.items.map(()=>"正在准备图片任务"),slotSizes:compiledBatch.items.map(item=>String(item?.dispatchContract?.arguments?.size||"auto").trim()||"auto"),slotSize:"auto",imageContext:null,childImageContexts:Array(compiledBatch.items.length).fill(null)};const initialBatchRawText=batchAggregate.statuses.map((status,index)=>`任务 ${index+1}/${batchAggregate.total}：${status}`).join("\n"),initialBatchHtml=typeof renderImageBatchResult==="function"?renderImageBatchResult({}, {total:batchAggregate.total, childContexts:batchAggregate.childImageContexts, slotStatuses:batchAggregate.statuses, slotSizes:batchAggregate.slotSizes, slotSize:batchAggregate.slotSize, statusHtml:pendingFeedbackHtml(initialBatchRawText), complete:false}):pendingFeedbackHtml(initialBatchRawText);updateSessionDisplayItem(sessionId,batchParent,"assistant",initialBatchHtml,{html:!0,rawText:initialBatchRawText,pending:!0,responseIndex:batchParent.responseIndex});assistantNode?.isConnected&&updateMessage(assistantNode,initialBatchHtml,{html:!0,rawText:initialBatchRawText,skipSave:!0,preserveLiveMedia:!0});persistSessionDisplay(sessionId);await sendImageBatch(sessionId,{items:compiledBatch.items.map(item=>({dispatchContract:item.dispatchContract,executionMedia:submitHelpers.projectRouteExecutionMedia?.(item.route,executionPools)||item.executionResources,prompt:String(item.dispatchContract?.arguments?.prompt||"").trim(),label:String(item.task?.label||"").trim()})),batchJobId,submissionId,batchParent,responseIndex,clarificationReplay,onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind),onInterfaceCompleted:()=>completeInterfaceTask({sessionId,submissionId,jobId:activeJobId,jobKind:activeJobKind})});}else{const preparedImageJobId=typeof makeClientImageJobId==="function"?makeClientImageJobId():`imgjob-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2,6)}`;if(!savePendingSubmit(sessionId,{...loadPendingSubmit(sessionId),jobId:preparedImageJobId,jobKind:"image",stage:"handoff"}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");activeJobId=preparedImageJobId;activeJobKind="image";emitTaskEvent(sessionId,taskEvents.HANDOFF_PREPARED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});preparedChatJobId="";liveItem&&(liveItem.jobId=preparedImageJobId,liveItem.pending="1",persistSessionDisplay(sessionId));assistantNode&&(assistantNode.dataset.jobId=preparedImageJobId,clearPendingFeedback?.(assistantNode),clearReasoning?.(assistantNode));await sendImage(imagePrompt,{loadingNode:assistantNode,routePrompt:imagePrompt,originalPrompt:effectivePromptText,resolvedGoal:routeInfo.resolvedImageGoal||imagePrompt,attachments:editAttachments,maskAttachments:executionMedia?.masks || [],executionMedia,dispatchContract:routeInfo.dispatchContract,clarificationReplay,sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacementResponseIndex,submissionId,clientJobId:preparedImageJobId,onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind),onInterfaceCompleted:completeInterfaceTask});completeDurableHandoff(activeJobId,activeJobKind);completeInterfaceTask({sessionId,submissionId,jobId:activeJobId,jobKind:activeJobKind})}}state.editingIndex=null,state.editingNode=null,state.editingQuoteContext=""
          }catch(err){
            const preservePendingSubmit=root?.ChatUIAppJobWorkflow?.shouldPreservePendingSubmitOnError?.(err,state,run)||false,cancelled=submissionCancelled(),terminalBeforeError=terminalCommitted;
            if(!preservePendingSubmit){clearPendingSubmit(sessionId);if(!cancelled&&!terminalBeforeError){const failureEvent=handoffCommitted&&activeJobId?(err?.terminalJob?taskEvents.JOB_FAILED:taskEvents.JOB_RECOVERY_STARTED):taskEvents.TASK_FAILED;if(failureEvent===taskEvents.JOB_RECOVERY_STARTED){emitTaskEvent(sessionId,failureEvent,{submissionId,jobId:activeJobId,jobKind:activeJobKind,error:err});root.setTimeout?.(()=>deps.resumeSessionJobs?.(sessionId),0)}else commitTerminalEvent(failureEvent,{submissionId,jobId:activeJobId,jobKind:activeJobKind,error:err})}}
            !cancelled&&!preservePendingSubmit&&!terminalBeforeError&&showRunError(sessionId,err,liveItem,assistantNode)
          }finally{
            submissionCancelled()&&commitTerminalEvent(taskEvents.TASK_STOPPED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});
            finishSessionTask(sessionId,{run,stopSlowNotice:()=>routeUi?.stopSlowNotice?.(),focusPrompt:!0})
          }

      }
    }

    return Object.freeze({ onSubmit, loadPendingSubmit, savePendingSubmit, clearPendingSubmit, resumePendingSubmit });
  }

    const api = Object.freeze({
      createSubmitWorkflow,
      parseOptionalMessageIndex,
      createBoundedIntentRequest,
      requestJsonWithStructuredOutputFallback,
      createPendingTransition,
      buildPendingAssistancePresentation,
      INTENT_PIPELINE_DEADLINE_MS,
    });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSubmitWorkflow = api;
  if (root?.window) root.window.ChatUIAppSubmitWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
