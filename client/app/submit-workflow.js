(function initChatUIAppSubmitWorkflow(root) {
  // Intentionally not strict: submit body is migrated from app.js and resolved through a deps scope.

  function parseOptionalMessageIndex(value) {
    if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
    const index = Number(value);
    return Number.isFinite(index) && index >= 0 ? index : null;
  }

  const INTENT_PIPELINE_DEADLINE_MS = 60000;

  function createIntentPipelineTimeout() {
    const error = new Error('ROUTE_INTENT_TIMEOUT');
    error.code = 'ROUTE_INTENT_TIMEOUT';
    error.routeTimedOut = true;
    error.timeoutMs = INTENT_PIPELINE_DEADLINE_MS;
    return error;
  }

  function createBoundedIntentRequest(parentSignal = null, deadlineAt = 0) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let disposed = false;
    let rejectTerminal = null;
    const abortFromParent = () => controller?.abort?.();
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
    const terminal = new Promise((resolve, reject) => { rejectTerminal = reject; });
    terminal.catch(() => {});
    const remaining = Math.max(0, Number(deadlineAt) - Date.now());
    const timer = setTimeout(() => {
      if (disposed) return;
      controller?.abort?.();
      rejectTerminal?.(createIntentPipelineTimeout());
    }, remaining);
    return {
      signal: controller?.signal || parentSignal || null,
      race: promise => Promise.race([Promise.resolve(promise), terminal]),
      dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener?.('abort', abortFromParent);
      },
    };
  }

  function structuredOutputUnsupported(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return /response_format|json_schema|structured.?output/.test(text)
      && /unsupported|not support|unknown|invalid parameter|unrecognized/.test(text);
  }

  function createSubmitWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const submitHelpers = root?.ChatUISubmitWorkflowHelpers
      || (typeof require === 'function' ? require('./submit-workflow.helpers') : {});
    const jobLifecycle = root?.ChatUIAppJobWorkflow || {};
    const getPreviousImageAttachments = deps.getPreviousImageAttachments || root?.getPreviousImageAttachments;
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
          const rawPromptValue=String(resumePendingSubmit?.rawPromptText??resumePendingSubmit?.promptText??$("prompt").value),messageSizeGuard=(root?.ChatUICorePreflightGuards||window?.ChatUICorePreflightGuards||{}).validateMessageSize?.(rawPromptValue);if(messageSizeGuard&&!messageSizeGuard.ok){resumePendingSubmit&&clearPendingSubmit(resumePendingSubmit.sessionId||state.activeSessionId);toast(messageSizeGuard.message||"消息过长，请改为上传文本文件或分段发送");return}const rawPromptText=rawPromptValue.trim();
          try { root?.ChatUIApp?.appContext?.getWorkflowModule?.('historyAnchorNav')?.cancelPendingJump?.({ clearSpacer: true }); } catch {}
          let promptText=rawPromptText;
          const resumeHasInput=jobLifecycle.pendingSubmitHasRecoverableInput?.(resumePendingSubmit)||!!(resumePendingSubmit&&(resumePendingSubmit.promptText||resumePendingSubmit.rawPromptText||resumePendingSubmit.imageContext||resumePendingSubmit.attachmentContext||Number(resumePendingSubmit.attachmentCount)>0));
          if(!promptText&&!state.attachments.length&&!resumeHasInput)return;
          unlockDoneSound({userGesture:!resumePendingSubmit&&(e?.isTrusted===!0||root.navigator?.userActivation?.isActive===!0)}),saveConfig(!0);
          const sessionId=resumePendingSubmit?.sessionId||state.activeSessionId,run=ensureActiveRun(sessionId),submissionId=resumePendingSubmit?.submissionId||jobLifecycle.makeSubmissionId?.()||`submit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,startedAt=resumePendingSubmit?.startedAt||Date.now(),initialAttachmentCount=resumePendingSubmit?Math.max(0,Number(resumePendingSubmit.attachmentCount||0)||0):state.attachments.length,initialEditMessageIndex=resumePendingSubmit?parseOptionalMessageIndex(resumePendingSubmit.editMessageIndex):parseOptionalMessageIndex(state.editingIndex);let activeJobId="",activeJobKind="",handoffCommitted=!1,attachments=resumePendingSubmit?[]:[...state.attachments],routeUi=null,assistantNode=null,liveItem=null;
          const submissionCancelled=()=>!!run.stopped||!!run.abortController?.signal?.aborted||!!state.disposedSessionIds?.has?.(sessionId)||!state.sessions?.some?.(item=>item.id===sessionId);
          try{
            if(!resumePendingSubmit&&!savePendingSubmit(sessionId,{submissionId,stage:"accepted",promptText,rawPromptText,submitMode:state.mode,userCommitted:!1,editExisting:initialEditMessageIndex!==null,editMessageIndex:initialEditMessageIndex,attachmentCount:initialAttachmentCount,startedAt})){clearActiveRun(sessionId,run);toast("无法保存任务恢复状态，请清理浏览器存储空间后重试");return}
            emitTaskEvent(sessionId,taskEvents.TASK_ACCEPTED,{submissionId});
            emitTaskEvent(sessionId,taskEvents.ATTACHMENT_CAPTURE_STARTED,{submissionId});
            setSessionBusy(sessionId,!0);
            if(resumePendingSubmit?.attachmentContext&&typeof restoreUserAttachmentsFromContext==="function")try{attachments=await restoreUserAttachmentsFromContext(resumePendingSubmit.attachmentContext)}catch(err){console.warn("restore pending submit attachments failed",err),attachments=[]}
            else if(resumePendingSubmit?.imageContext&&typeof restoreImageAttachmentsFromContext==="function")try{attachments=await restoreImageAttachmentsFromContext(resumePendingSubmit.imageContext)}catch(err){console.warn("restore pending submit images failed",err),attachments=[]}
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
            const attachmentCaptureIncomplete=!!resumePendingSubmit&&initialAttachmentCount>0&&!initialImageContext&&!initialAttachmentContext&&!attachments.length;
            if(!savePendingSubmit(sessionId,{...resumePendingSubmit,submissionId,stage:"captured",promptText,rawPromptText,submitMode,messageIndex,userCommitted:resumeUserCommitted,editExisting:initialEditMessageIndex!==null,editMessageIndex:initialEditMessageIndex,attachmentCount:initialAttachmentCount,quoteContext:resumePendingSubmit?.quoteContext||"",imageContext:initialImageContext,attachmentContext:initialAttachmentContext,startedAt})){clearPendingSubmit(sessionId);toast("无法保存任务恢复状态，请清理浏览器存储空间后重试");return}
            emitTaskEvent(sessionId,taskEvents.ATTACHMENT_CAPTURED,{submissionId});
            const parseContextValue=submitHelpers.parseContextValue;
            const quotedMessage=resumePendingSubmit?.quoteContext?parseContextValue(resumePendingSubmit.quoteContext):(state.editingIndex===null?getQuotedMessage?.():null),quoteContext=resumePendingSubmit?.quoteContext||(quotedMessage?JSON.stringify(quotedMessage):"");
            const withPendingQuotePreview=submitHelpers.withPendingQuotePreview;
            const getEffectiveRouteWithSlowNotice=(input,routeAttachments,headers,context,intentOptions={})=>{routeUi.startSlowNotice();return getEffectiveRoute(input,routeAttachments,sessionId,headers,context,{...intentOptions,onSlow:routeUi.showSlowNotice,onStage:routeUi.showSlowNotice,signal:run.abortController?.signal}).finally(()=>routeUi.stopSlowNotice())};
            let quotedImageContext=parseContextValue(quotedMessage?.imageContext),quotedImageAttachments=[];
            let replacement=null,preparedChatJobId=resumePendingSubmit?.jobId||"",routeMode=submitMode,routeInfo=null,userNode=null,userDisplayItem=null,requestBaseMessages=null,imageContext="",attachmentContext="";
            routeUi=createRouteRecognitionUi({sessionId,assistantNode:()=>assistantNode,liveItem:()=>liveItem,responseIndex:()=>responseIndex,getPromptText:()=>promptText,getPreparedChatJobId:()=>preparedChatJobId,signal:run.abortController?.signal});

            if(initialEditMessageIndex!==null&&isTargetActive())replacement=applyPendingEdit(promptText,{submissionId,messageIndex:initialEditMessageIndex,node:state.editingNode}),replacement&&(messageIndex=replacement.index,resumeUserCommitted=!0);
            if(!replacement&&(!resumePendingSubmit||!resumeUserCommitted)){
              const userHtml=renderUserMessageWithAttachments(promptText||"已发送附件",attachments),rawText=buildUserMessageContent(promptText,attachments),apiContent=buildUserApiContent(promptText,attachments),message={role:"user",content:apiContent,html:userHtml,rawText,messageIndex,submissionId};
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
            const prepareManagedChatJobForLiveItem=(jobMode=submitMode)=>{if("chat"!==jobMode)return"";if(!preparedChatJobId){const generatedJobId=typeof makeClientChatJobId==="function"?makeClientChatJobId():"";preparedChatJobId=String(generatedJobId||`chatjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`)}if(!liveItem)return preparedChatJobId;liveItem.jobId=preparedChatJobId;liveItem.responseIndex=String(responseIndex);assistantNode&&(assistantNode.dataset.jobId=preparedChatJobId,assistantNode.dataset.responseIndex=String(responseIndex));persistSessionDisplay(sessionId);return preparedChatJobId};
            const routingStatus="正在执行：路由预检";
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
            else if(replacement){const prepared=prepareReplacementResponse(replacement,sessionId,routingStatus);assistantNode=prepared.node;liveItem=prepared.liveItem;prepareManagedChatJobForLiveItem();await persistTargetMessages()}
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
            const finishPreflightReply=async(text,meta={})=>{const msg={role:"assistant",content:text,rawText:text,responseIndex,submissionId};assistantNode?.isConnected&&(delete assistantNode.dataset.jobId,updateMessage(assistantNode,text,{rawText:text,responseIndex,metaText:meta.metaText||""}));liveItem&&(delete liveItem.jobId,typeof updateSessionDisplayItem==="function"?updateSessionDisplayItem(sessionId,liveItem,"assistant",text,{rawText:text,pending:!1,responseIndex,metaText:meta.metaText||""}):(liveItem.content=text,liveItem.rawText=text,liveItem.pending=!1,persistSessionDisplay(sessionId)));if(isTargetActive()){state.messages.push(msg);sessionForReply&&(sessionForReply.messages=cloneMessageList(state.messages))}else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),msg]);await persistPendingTerminalMessages();emitTaskEvent(sessionId,taskEvents.TASK_COMPLETED_COMMITTED,{submissionId});clearPendingSubmit(sessionId);preparedChatJobId&&typeof clearChatJob==="function"&&clearChatJob(sessionId);preparedChatJobId="";saveSessionsMeta?.();return true};
            if(attachmentCaptureIncomplete)return finishPreflightReply("页面刷新发生在附件保存完成之前，附件内容无法安全恢复。请重新上传附件后再试。",{metaText:"未发送到模型"});
            const preflightText=String(promptText||"").trim(),preflightGuard=root?.ChatUICorePreflightGuards||window.ChatUICorePreflightGuards||{};
            const preflightCounts=preflightGuard.attachmentCounts?.(attachments,typeof isImageFile==="function"?isImageFile:void 0)||{imageCount:attachments.filter(item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/")).length,fileCount:attachments.length};
            const hasCurrentImage=preflightCounts.imageCount>0,wantsImagePreflight=!!preflightGuard.wantsImageGeneration?.(preflightText);
            const hasPreviousFileContext=()=>{const messages=targetSession.messages||state.messages||[];return messages.some(message=>{const context=parseContextValue(message?.attachmentContext);return Array.isArray(context?.attachments)&&context.attachments.some(item=>item&&!String(item.type||item.mime||'').startsWith('image/'))})};
            const hasQuotedImageContext=!!(quotedImageContext?.attachments?.length);
            const preflightConfig=typeof getConfig==="function"?getConfig():{};if(typeof getSessionRouteModel==="function"&&!String(preflightConfig.routeModel||"").trim())preflightConfig.routeModel=getSessionRouteModel(sessionId,preflightConfig);const preflightDecision=preflightGuard.buildPreflightDecision?.({input:preflightText,attachments,previousAssistantCount:(targetSession.messages||[]).filter(m=>m&&m.role==="assistant").length,config:preflightConfig,isImageFile:typeof isImageFile==="function"?isImageFile:void 0,hasPreviousEditableImage:!!(typeof getLatestUploadedImageContext==="function"&&getLatestUploadedImageContext(sessionId)),hasPreviousFileContext:hasPreviousFileContext(),hasQuotedImageContext,recentMessages:targetSession.messages||state.messages||[]});
            if(preflightDecision?.action==="reply")return finishPreflightReply(preflightDecision.message,{metaText:preflightDecision.metaText});
            if(quotedImageContext?.attachments?.length&&typeof restoreImageAttachmentsFromContext==="function"){
              try{quotedImageAttachments=await restoreImageAttachmentsFromContext(quotedImageContext)}catch(e){console.warn("restore quoted image attachments failed",e),quotedImageAttachments=[]}
            }
            let requestAttachments=quotedImageAttachments.length?[...quotedImageAttachments,...attachments]:attachments;
            const routeUtils=root?.ChatUIRouteService||root?.ChatUIServices?.route||(typeof require==="function"?require("../services/route-service"):{});
            const buildQuotedRouteContent=routeUtils.buildQuotedRouteContent,cleanQuotedContent=routeUtils.cleanQuotedContent;
            const quotedContextAttachments=Array.isArray(quotedImageContext?.attachments)?quotedImageContext.attachments:[],quotedCandidateAttachments=quotedImageAttachments.length?quotedImageAttachments:quotedContextAttachments;
            const hasQuotedMessage=!!quotedMessage,hasQuotedImage=quotedCandidateAttachments.length>0,quotedReferenceId=quotedImageContext?.referenceId||quotedImageContext?.reference_id||quotedImageContext?.selectedReferenceId||"",quotedImageSource=(quotedImageContext?.target==="uploaded"||quotedImageContext?.mode==="edit_image")?"uploaded":"previous",quotedFileCandidates=typeof deps?.quotedFileCandidatesFromContext==="function"?deps.quotedFileCandidatesFromContext(quotedMessage?.attachmentContext||quotedMessage?.attachment_context||""):[],quotedTextFromMessage=cleanQuotedContent(quotedMessage?.content||""),quotedPromptFromContext=cleanQuotedContent(quotedImageContext?.prompt||quotedImageContext?.userPrompt||quotedImageContext?.originalPrompt||""),quotedCleanText=quotedTextFromMessage||quotedPromptFromContext,quotedRouteContent=buildQuotedRouteContent({text:quotedCleanText||quotedMessage?.content||"",images:quotedCandidateAttachments});
            const quotedReferenceFromImageId=id=>String(id||"").match(/^img_(imgref_.+)_\d+$/)?.[1]||"";
            const quotedReferenceSummary=()=>({reference_id:quotedReferenceId||quotedReferenceFromImageId(quotedCandidateAttachments[0]?.imageId||quotedCandidateAttachments[0]?.image_id)||"imgref_quote",source:"quoted",target:quotedImageSource,count:quotedCandidateAttachments.length});
            const quotedImageCandidates=()=>quotedCandidateAttachments.map((e,i)=>{const imageId=e.imageId||e.image_id||e.id||"";return{index:i+1,image_id:imageId,reference_id:quotedReferenceId||e.referenceId||e.reference_id||quotedReferenceFromImageId(imageId)||"imgref_quote",target:quotedImageSource,source:"quoted",filename:e.name||e.filename||"",prompt:quotedCleanText||""}});
            const buildQuotedRouteContext=()=>({quoted_message:{index:1,role:quotedMessage?.role||"user",id:quotedMessage?.displayItemId||""},recent_messages:[{index:1,role:quotedMessage?.role||"user",content:quotedRouteContent||"[quoted_message]"}],suggested_contextual_image_prompt:[quotedCleanText,promptText].filter(Boolean).join("\n\n"),latest_user_image_request:null,latest_assistant_image_result:hasQuotedImage&&quotedImageSource==="previous"?quotedReferenceSummary():null,image_candidates:hasQuotedImage?quotedImageCandidates():[],file_candidates:quotedFileCandidates,last_generated_image:null,latest_uploaded_image:hasQuotedImage&&quotedImageSource==="uploaded"?quotedReferenceSummary():null,latest_image_reference:hasQuotedImage?quotedReferenceSummary():null,recent_image_references:[],recent_uploaded_image_references:[]});
            const originalImageIndex=submitHelpers.originalImageIndex;
            const isImageAttachment=item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/");
            const clarification=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{},intentDeadlineAt=Date.now()+INTENT_PIPELINE_DEADLINE_MS;
            const storedPending=clarification.normalizePendingClarification?.(targetSession.pendingClarification)||null;
            const editedMessage=initialEditMessageIndex!==null
              ? (targetSession.messages||[])[initialEditMessageIndex]||null
              : null;
            const editedClarificationReplay=clarification.normalizeClarificationReplay?.(editedMessage?.clarificationReplay)||null;
            const currentTurnAttachments=[...attachments];
            let pendingDecision=null;
            if(storedPending&&clarification.buildContinuationClassifierPayload&&clarification.parseContinuationClassifierResult&&typeof getConfig==="function"&&typeof requestJson==="function"){
              const cfg=getConfig(),model=typeof getSessionRouteModel==="function"?getSessionRouteModel(sessionId,cfg):cfg.routeModel||cfg.chatModel;
               if(cfg.baseUrl&&model){const classifierDeadline=createBoundedIntentRequest(run.abortController?.signal,intentDeadlineAt);try{
                 const payload=clarification.buildContinuationClassifierPayload({model,pending:storedPending,currentInput:promptText,attachments:currentTurnAttachments,quoteText:quotedCleanText,recentMessages:targetSession.messages||state.messages||[]});
                 const requestClassifier=body=>classifierDeadline.race(requestJson(`${cfg.baseUrl}/chat/completions`,body,cfg.apiKey,{headers:buildRequestHeaders("message",sessionId),signal:classifierDeadline.signal}));
                 const requestCompatibleClassifier=async body=>{try{return await requestClassifier(body)}catch(err){if(!body.response_format||!structuredOutputUnsupported(err))throw err;const compatibilityPayload={...body};delete compatibilityPayload.response_format;return requestClassifier(compatibilityPayload)}};
                 let result=await requestCompatibleClassifier(payload),classifierText=result?.choices?.[0]?.message?.content||result?.output_text||"";
                 pendingDecision=clarification.parseContinuationClassifierResult(classifierText,{pending:storedPending});
                 if(!pendingDecision&&clarification.buildContinuationRepairPayload){const repairPayload=clarification.buildContinuationRepairPayload(payload,classifierText);if(repairPayload){result=await requestCompatibleClassifier(repairPayload);classifierText=result?.choices?.[0]?.message?.content||result?.output_text||"";pendingDecision=clarification.parseContinuationClassifierResult(classifierText,{pending:storedPending})}}
               }catch(err){if(err?.code==="ROUTE_INTENT_TIMEOUT")throw err;console.warn("continuation classifier failed; preserving pending clarification:",err)}finally{classifierDeadline.dispose()}}
             }
            if(storedPending&&!pendingDecision){targetSession.pendingClarification=storedPending;sessionForReply&&(sessionForReply.pendingClarification=storedPending);saveSessionsMeta?.();return finishPreflightReply("暂时无法确认这条回复是否在回答上一个澄清问题，原任务已保留，请重试。",{metaText:"等待补充"})}
            const clearStoredPendingClarification=()=>{if(!storedPending)return;const pendingId=String(storedPending.id||"");if(!pendingId||String(targetSession.pendingClarification?.id||"")===pendingId)delete targetSession.pendingClarification;if(sessionForReply&&(!pendingId||String(sessionForReply.pendingClarification?.id||"")===pendingId))delete sessionForReply.pendingClarification;saveSessionsMeta?.()};
            const pendingAssistance=pendingDecision?.relation==="pending_assistance"&&pendingDecision?.shouldMerge===!1&&pendingDecision?.shouldClearPending===!1&&!!pendingDecision?.assistantReply;
            if(pendingAssistance){const retainedPending=clarification.retainPendingAfterAssistance?.(storedPending,{promptText,assistantReply:pendingDecision.assistantReply})||storedPending;if(retainedPending){targetSession.pendingClarification=retainedPending;sessionForReply&&(sessionForReply.pendingClarification=retainedPending);saveSessionsMeta?.()}return finishPreflightReply(pendingDecision.assistantReply,{metaText:"等待补充"})}
            const shouldMergePending=["pending_answer","partial_answer","revision","continuation"].includes(pendingDecision?.relation)&&pendingDecision?.shouldMerge===!0;
            const pendingMerge=shouldMergePending?clarification.mergePendingInput(storedPending,{promptText,resolvedInput:pendingDecision?.resolvedInput||""}):null;
            const pendingQuoteContext=pendingMerge?.merged?JSON.stringify({role:"user",content:storedPending.originalText||"追问来源",sessionId,...storedPending.sourceImageContext?{imageContext:storedPending.sourceImageContext}:{},...storedPending.sourceAttachmentContext?{attachmentContext:storedPending.sourceAttachmentContext}:{},...storedPending.sourceQuoteContext?{quoteContext:storedPending.sourceQuoteContext}:{}}):"";
            if(pendingMerge?.merged){
              promptText=pendingMerge.promptText;
            }
            // Editing the final clarification answer replaces only that answer; all earlier
            // confirmed answers remain in the replay input passed through the full router.
            const revisedClarificationReplay=!pendingMerge?.merged&&editedClarificationReplay
              ? clarification.reviseClarificationReplay?.(editedClarificationReplay,rawPromptText)||editedClarificationReplay
              : null;
            if(revisedClarificationReplay)promptText=revisedClarificationReplay.resolvedInput;
            if(storedPending&&!pendingMerge?.merged&&pendingDecision?.shouldClearPending===!0)clearStoredPendingClarification();
            const effectivePromptText=promptText;
            const routeContextBuilder=typeof deps?.buildRouteContext==="function"?deps.buildRouteContext:typeof root?.buildRouteContext==="function"?root.buildRouteContext:null;
            const clarificationRouteContext=pendingMerge?.merged?clarification.buildClarificationRouteContext?.({baseContext:routeContextBuilder?routeContextBuilder(sessionId):{},quotedContext:hasQuotedMessage?buildQuotedRouteContext():null,pending:storedPending,currentInput:rawPromptText,resolvedInput:effectivePromptText,continuationRelation:pendingDecision?.relation||"",selections:pendingDecision?.selections||[],attachments:currentTurnAttachments,quoteText:quotedCleanText}):null;
            if(pendingMerge?.merged&&!clarificationRouteContext)throw new Error("澄清上下文未能通过结构化校验，已停止发送");
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
               try{routeInfo=await getEffectiveRouteWithSlowNotice(effectivePromptText,currentTurnAttachments,buildRequestHeaders("message",sessionId),clarificationRouteContext,{deadlineAt:intentDeadlineAt}),routeMode=routeInfo.mode}catch(e){throw e}
            }else if(hasQuotedMessage){
               try{routeInfo=await getEffectiveRouteWithSlowNotice(promptText,currentTurnAttachments,buildRequestHeaders("message",sessionId),buildQuotedRouteContext(),{deadlineAt:intentDeadlineAt}),routeMode=routeInfo.mode}catch(e){throw e}
             }else try{routeInfo=await getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,buildRequestHeaders("message",sessionId),null,{deadlineAt:intentDeadlineAt}),routeMode=routeInfo.mode}catch(e){throw e}
            if(routeInfo.needClarification){
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
              const createdPending=pendingMerge?.merged?clarification.normalizePendingClarification?.({...pendingMerge.pending,originalText:effectivePromptText,clarificationText:e,routeInfo,updatedAt:Date.now()}):clarification.createPendingClarification?.({messages:sessionForReply.messages||targetSession.messages||state.messages||[],clarificationText:e,routeInfo,sourceImageContext:imageContext||null,sourceAttachmentContext:attachmentContext||null,sourceQuoteContext:quoteContext||null});
              const clarificationId=!routeInfo.localClarification?String(createdPending?.id||""):"";
              const t={role:"assistant",content:e,rawText:e,responseIndex,...clarificationHtml?{html:clarificationHtml}:{},...clarificationId?{clarificationId}:{}};
              typeof updateMessage==="function"&&assistantNode?.isConnected&&(delete assistantNode.dataset.jobId,updateMessage(assistantNode,displayContent,{html:!!clarificationHtml,rawText:e,responseIndex}));
              assistantNode?.isConnected&&clarificationId&&(assistantNode.dataset.clarificationId=clarificationId);
              liveItem&&(delete liveItem.jobId,clarificationId&&(liveItem.clarificationId=clarificationId),typeof updateSessionDisplayItem==="function"?updateSessionDisplayItem(sessionId,liveItem,"assistant",displayContent,{html:!!clarificationHtml,rawText:e,pending:!1,responseIndex,clarificationId}):(liveItem.content=e,liveItem.rawText=e,liveItem.html=clarificationHtml,liveItem.pending=!1,persistSessionDisplay(sessionId)));
              if(isTargetActive()){state.messages.push(t);sessionForReply.messages=cloneMessageList(state.messages)}else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),t]);
              if(createdPending&&!routeInfo.localClarification){targetSession.pendingClarification=createdPending;sessionForReply&&(sessionForReply.pendingClarification=createdPending)}
              await persistPendingTerminalMessages();emitTaskEvent(sessionId,taskEvents.TASK_COMPLETED_COMMITTED,{submissionId});clearPendingSubmit(sessionId);preparedChatJobId&&typeof clearChatJob==="function"&&clearChatJob(sessionId);preparedChatJobId="";saveSessionsMeta?.();return
            }
            if(submissionCancelled()){clearPendingSubmit(sessionId);return}
            if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0){const e=new Error("路由任务尚未完成资源确认，已停止发送");e.code="ROUTE_NOT_READY";throw e}
            const clarificationReplay=pendingMerge?.merged
              ? clarification.createClarificationReplay?.({pending:storedPending,merge:pendingMerge,routeInfo,clarificationRouteContext})
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
            const quoteScopedChat=!!quotedMessage&&!pendingMerge?.merged&&(!hasRouteMessageRefs||routeMessageProjection?.usesExplicitQuote);
            requestBaseMessages=Array.isArray(resumePendingSubmit?.requestBaseMessages)?resumePendingSubmit.requestBaseMessages:(routeMessageProjection?.messages||(quoteScopedChat?[quotedMessage]:replacement&&isTargetActive()?state.messages.slice(0,replacement.index):null));
            const routeImagePrompt=String(routeInfo.contextualImagePrompt||"").trim();
            const restoreBoundImagePool=async source=>{
              const resources=submitHelpers.routeMediaResources?.(routeInfo,"image",source)||[];
              if(!resources.length)return[];
              if(typeof getPreviousImageAttachments!=="function")throw new Error("无法恢复路由选择的历史图片，已停止发送");
              const ids=[...new Set(resources.map(resource=>String(resource.id||"")).filter(Boolean))];
              const restored=[];
              if(ids.length){
                const byId=await getPreviousImageAttachments(sessionId,null,"",ids);
                restored.push(...byId)
              }
              for(const resource of resources.filter(resource=>!resource.id)){
                const item=await getPreviousImageAttachments(sessionId,[Number(resource.index)],resource.reference_id||"",[]);
                restored.push(...item)
              }
              return restored.map(item=>({...item,routeSource:source}))
            };
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
            const sourcePools={
              current:currentTurnAttachments,
              quoted:quotedResourceAttachments,
              history:[...await restoreBoundImagePool("history"),...historyFiles],
              context:[...await restoreBoundImagePool("context"),...contextFiles],
            };
            const executionPools=submitHelpers.buildExecutionResourcePools(sourcePools,{isImageFile:isImageAttachment});
            const executionMedia=submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools);
            const chatAttachments=await prepareChatImageAttachments([...executionMedia.chatFiles,...executionMedia.chatImages]);
            const comparisonGuide=executionMedia.chatImages.some(item=>["compare_a","compare_b"].includes(item.routeRole))
              ? executionMedia.chatImages.map((item,index)=>`随附图片${index+1} = ${item.routeRole}`).join("\n")
              : "";
            const imagePrompt=("image"===routeMode&&routeImagePrompt?routeImagePrompt:quotedMessage&&!pendingMerge?.merged&&"image"===routeMode?[quotedCleanText,effectivePromptText].filter(Boolean).join("\n\n"):effectivePromptText);
            const chatPrompt=[comparisonGuide,imageAttachmentIndexGuide(chatAttachments),effectivePromptText].filter(Boolean).join("\n\n");
            const editAttachments=executionMedia.imageInputs;
            const executionApi=routeInfo.api||("image"===routeMode?"image_generation":"edit_image"===routeMode?"image_edit":"chat");const dispatchMode=executionApi==="image_generation"?"image":executionApi==="image_edit"?"edit_image":"chat";if(isTargetActive()&&liveItem&&(!assistantNode||!assistantNode.isConnected)&&typeof findMessageNodeByDisplayItem==="function")assistantNode=findMessageNodeByDisplayItem(liveItem)||assistantNode;const replacementResponseIndex=replacement?.responseIndex??(resumePendingSubmit?responseIndex:void 0),completeDurableHandoff=(jobId,jobKind)=>{handoffCommitted=!0;pendingMerge?.merged&&clearStoredPendingClarification();emitTaskEvent(sessionId,taskEvents.HANDOFF_COMMITTED,{submissionId,jobId,jobKind});clearPendingSubmit(sessionId)},completeInterfaceTask=(completion={})=>{const completionSessionId=String(completion.sessionId||""),completionSubmissionId=String(completion.submissionId||""),completionJobId=String(completion.jobId||""),completionJobKind=String(completion.jobKind||"");if(!completionSessionId||!completionSubmissionId||!completionJobId||!completionJobKind)return;if(completionSessionId!==String(sessionId)||completionSubmissionId!==String(submissionId)||completionJobId!==String(activeJobId)||completionJobKind!==String(activeJobKind))return;emitTaskEvent(sessionId,taskEvents.JOB_COMPLETED_COMMITTED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});finishSessionTask(sessionId,{run})};if("chat"===dispatchMode){prepareManagedChatJobForLiveItem("chat");if(!preparedChatJobId)throw new Error("无法创建聊天任务恢复标识，请重试");if(!savePendingSubmit(sessionId,{...loadPendingSubmit(sessionId),jobId:preparedChatJobId,jobKind:"chat",stage:"handoff"}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");activeJobId=preparedChatJobId;activeJobKind="chat";emitTaskEvent(sessionId,taskEvents.HANDOFF_PREPARED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});await sendChat(chatPrompt,chatAttachments,assistantNode,{sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacementResponseIndex,requestBaseMessages,quotedMessage:quoteScopedChat?quotedMessage:null,routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0,clarificationReplay,clientJobId:preparedChatJobId,submissionId,onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind),onInterfaceCompleted:completeInterfaceTask});completeDurableHandoff(activeJobId,activeJobKind);emitTaskEvent(sessionId,taskEvents.JOB_COMPLETED_COMMITTED,{submissionId,jobId:activeJobId,jobKind:activeJobKind})}else{const preparedImageJobId=typeof makeClientImageJobId==="function"?makeClientImageJobId():`imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;if(!savePendingSubmit(sessionId,{...loadPendingSubmit(sessionId),jobId:preparedImageJobId,jobKind:"image",stage:"handoff"}))throw new Error("无法保存任务恢复状态，请清理浏览器存储空间后重试");activeJobId=preparedImageJobId;activeJobKind="image";emitTaskEvent(sessionId,taskEvents.HANDOFF_PREPARED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});preparedChatJobId="";liveItem&&(liveItem.jobId=preparedImageJobId,liveItem.pending="1",persistSessionDisplay(sessionId));assistantNode&&(assistantNode.dataset.jobId=preparedImageJobId,clearPendingFeedback?.(assistantNode),clearReasoning?.(assistantNode));await sendImage(imagePrompt,{loadingNode:assistantNode,routePrompt:imagePrompt,originalPrompt:effectivePromptText,attachments:editAttachments,maskAttachments:executionMedia.masks,executionMedia,taskContract:routeInfo.taskContract,clarificationReplay,sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacementResponseIndex,submissionId,clientJobId:preparedImageJobId,onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind),onInterfaceCompleted:completeInterfaceTask});completeDurableHandoff(activeJobId,activeJobKind);emitTaskEvent(sessionId,taskEvents.JOB_COMPLETED_COMMITTED,{submissionId,jobId:activeJobId,jobKind:activeJobKind})}state.editingIndex=null,state.editingNode=null
          }catch(err){
            const preservePendingSubmit=root?.ChatUIAppJobWorkflow?.shouldPreservePendingSubmitOnError?.(err,state,run)||false;
            if(!preservePendingSubmit){clearPendingSubmit(sessionId);const failureEvent=run.stopped?taskEvents.TASK_STOPPED:handoffCommitted&&activeJobId?(err?.terminalJob?taskEvents.JOB_FAILED:taskEvents.JOB_RECOVERY_STARTED):taskEvents.TASK_FAILED;emitTaskEvent(sessionId,failureEvent,{submissionId,jobId:activeJobId,jobKind:activeJobKind,error:err});failureEvent===taskEvents.JOB_RECOVERY_STARTED&&root.setTimeout?.(()=>deps.resumeSessionJobs?.(sessionId),0)}
            preservePendingSubmit||showRunError(sessionId,err,liveItem,assistantNode)
          }finally{
            run.stopped&&emitTaskEvent(sessionId,taskEvents.TASK_STOPPED,{submissionId,jobId:activeJobId,jobKind:activeJobKind});
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
      INTENT_PIPELINE_DEADLINE_MS,
    });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSubmitWorkflow = api;
  if (root?.window) root.window.ChatUIAppSubmitWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
