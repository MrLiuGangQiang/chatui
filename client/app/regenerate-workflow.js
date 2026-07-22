(function initChatUIAppRegenerateWorkflow(root) {
  'use strict';

  function createRegenerateWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const submitHelpers = root?.ChatUISubmitWorkflowHelpers
      || (typeof require === 'function' ? require('./submit-workflow.helpers') : {});
    const routeUtils = root?.ChatUIRouteService
      || root?.ChatUIServices?.route
      || (typeof require === 'function' ? require('../services/route-service') : {});
    const {
      state, isSessionBusy, findPreviousUserMessageNode, toast, ensureActiveRun,
      resetMessageActionStates, prepareRegeneratedResponse, getUserAttachmentContextFromNode,
      restoreUserAttachmentsFromContext, updateModeUi, warnMissingModel, isImageFile,
      sendImage, showRunError, resetActionButtonState, finishSessionTask,
      updateResumeStreamButton, getSubmitWorkflow, createRouteRecognitionUi,
      getMessageWorkflow, parseImageContext, restoreImageAttachmentsFromContext,
      quotedFileCandidatesFromContext, buildRequestHeaders, hasImageAttachments,
      normalizeRoute, getUploadedImageContext, sendChat, dispatchTaskEvent,
      makeClientChatJobId, makeClientImageJobId, resumeSessionJobs,
    } = deps;
    const window = root;
    const taskEvents = deps.taskEvents || root?.ChatUICore?.taskState?.TASK_EVENTS || {};
    const jobLifecycle = deps.jobLifecycle || root?.ChatUIAppJobWorkflow || {};
    const replacementApi = deps.messageReplacement || root?.ChatUIAppSessionPersistence || {};
    const emitTaskEvent = (sessionId, type, details = {}) => type
      ? dispatchTaskEvent?.(sessionId, { type, ...details })
      : null;

    function createRegenerateTask({ sessionId, run, readPending }) {
      const submissionId = jobLifecycle.makeSubmissionId?.()
        || `submit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      let jobId = '';
      let jobKind = '';
      let handoffCommitted = false;
      const savePending = patch => getSubmitWorkflow().savePendingSubmit?.(sessionId, {
        ...(typeof readPending === 'function' ? readPending() : {}),
        submissionId,
        userCommitted: true,
        ...patch,
      }) !== false;
      const clearPending = () => getSubmitWorkflow().clearPendingSubmit?.(sessionId);
      const details = () => ({ submissionId, jobId, jobKind });
      const commitHandoff = () => {
        if (handoffCommitted) return;
        handoffCommitted = true;
        emitTaskEvent(sessionId, taskEvents.HANDOFF_COMMITTED, details());
        clearPending();
      };

      const complete = (completion = {}) => {
        const completionSessionId = String(completion.sessionId || sessionId);
        const completionSubmissionId = String(completion.submissionId || submissionId);
        const completionJobId = String(completion.jobId || jobId);
        const completionJobKind = String(completion.jobKind || jobKind);
        if (
          completionSessionId !== String(sessionId)
          || completionSubmissionId !== String(submissionId)
          || completionJobId !== String(jobId)
          || completionJobKind !== String(jobKind)
        ) return false;
        commitHandoff();
        emitTaskEvent(sessionId, taskEvents.JOB_COMPLETED_COMMITTED, details());
        finishSessionTask?.(sessionId, { run });
        return true;
      };

      const interfaceCompleted = (completion = {}) => {
        if (!completion?.sessionId || !completion?.submissionId || !completion?.jobId || !completion?.jobKind) return false;
        return complete(completion);
      };

      return Object.freeze({
        submissionId,
        accept({ capture = false } = {}) {
          if (!savePending({ stage: 'accepted' })) throw new Error('无法保存任务恢复状态，请清理浏览器存储空间后重试');
          emitTaskEvent(sessionId, taskEvents.TASK_ACCEPTED, details());
          if (capture) emitTaskEvent(sessionId, taskEvents.ATTACHMENT_CAPTURE_STARTED, details());
        },
        captured() {
          emitTaskEvent(sessionId, taskEvents.ATTACHMENT_CAPTURED, details());
        },
        routing() {
          if (!savePending({ stage: 'routing' })) throw new Error('无法保存任务恢复状态，请清理浏览器存储空间后重试');
          emitTaskEvent(sessionId, taskEvents.ROUTING_STARTED, details());
        },
        prepareHandoff(kind, id) {
          jobKind = kind;
          jobId = String(id || '').trim();
          if (!jobId) throw new Error('无法创建任务恢复标识，请重试');
          if (!savePending({ stage: 'handoff', jobId, jobKind })) throw new Error('无法保存任务恢复状态，请清理浏览器存储空间后重试');
          emitTaskEvent(sessionId, taskEvents.HANDOFF_PREPARED, details());
          return jobId;
        },
        commitHandoff,
        complete,
        interfaceCompleted,
        fail(error) {
          const preserve = jobLifecycle.shouldPreservePendingSubmitOnError?.(error, state, run) || false;
          let failureEvent = null;
          if (!preserve) {
            clearPending();
            failureEvent = run?.stopped
              ? taskEvents.TASK_STOPPED
              : handoffCommitted && jobId
                ? (error?.terminalJob ? taskEvents.JOB_FAILED : taskEvents.JOB_RECOVERY_STARTED)
                : taskEvents.TASK_FAILED;
            emitTaskEvent(sessionId, failureEvent, { ...details(), error });
            if (failureEvent === taskEvents.JOB_RECOVERY_STARTED) root.setTimeout?.(() => resumeSessionJobs?.(sessionId), 0);
          }
          return { preserve, failureEvent };
        },
        stopped() {
          if (run?.stopped) emitTaskEvent(sessionId, taskEvents.TASK_STOPPED, details());
        },
      });
    }

    async function forceImageFromUserMessage(e){
      if(isSessionBusy(state.activeSessionId))return;
      const t=(e?.dataset.rawText||"").trim();
      if(!t)return void toast("找不到这条消息内容，无法强制生图");
      let turn=replacementApi.resolveUserMessageTurn?.(state.messages,e?.dataset?.messageIndex,{rawText:t})||null,s=turn?.userIndex;
      if(!Number.isInteger(s)||s<0)return void toast("找不到这条消息上下文，无法强制生图");
      turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,turn,{responseIndex:String(turn.assistantIndex),replacing:!0})||turn;const n=turn.assistantIndex,a=state.activeSessionId,i=ensureActiveRun(a),o=e.nextElementSibling&&(e.nextElementSibling.classList?.contains("assistant")||e.nextElementSibling.classList?.contains("error"))?e.nextElementSibling:null,r=e.querySelector(".force-image-btn");
      resetMessageActionStates(o||e);r&&(r.classList.add("refreshing"),r.disabled=!0);
      const l=prepareRegeneratedResponse(e,o,a,n,"正在处理中 请稍后"),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:a,run:i,readPending:()=>({promptText:t,rawPromptText:t,submitMode:"image",messageIndex:s,responseIndex:n,liveItemId:l.liveItem?.id||"",userDisplayItemId:e?.dataset?.displayItemId||e?.__displayItem?.id||"",imageContext:e?.dataset?.imageContext||e?.__displayItem?.imageContext||"",attachmentContext:e?.dataset?.attachmentContext||e?.__displayItem?.attachmentContext||"",requestBaseMessages:state.messages.slice(0,s),regenerate:!0,replaceAssistantIndex:n,startedAt})});
      try{
        task.accept({capture:!0});
        if(warnMissingModel("image",!0)){task.fail(new Error("missing image model"));return void l.node?.remove()}
        if(i.stopped||i.abortController?.signal?.aborted)return;
        const d=getUserAttachmentContextFromNode(e),c=d?await restoreUserAttachmentsFromContext(d):[];
        task.captured();task.routing();
        updateModeUi("image",state.autoMode);
        const jobId=task.prepareHandoff("image",makeClientImageJobId?.());
        await sendImage(t,{loadingNode:l.node,attachments:c.filter(item=>!isImageFile(item)),routePrompt:t,originalPrompt:t,sessionId:a,userAlreadyAdded:!0,liveItem:l.liveItem,replaceAssistantIndex:n,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||i.stopped||"AbortError"===t?.name||showRunError(a,t,l.liveItem,l.node)}finally{task.stopped(),resetActionButtonState(r),finishSessionTask(a,{run:i}),updateResumeStreamButton()}
    }

    async function regenerateAssistantMessage(e){
      if(isSessionBusy(state.activeSessionId))return;
      const t=findPreviousUserMessageNode(e),s=(t?.dataset.rawText||"").trim();
      if(!s)return void toast("找不到上一条提示词，无法重新生成");
      let turn=replacementApi.resolveUserMessageTurn?.(state.messages,t?.dataset?.messageIndex,{rawText:s})||null,n=turn?.userIndex;if(!Number.isInteger(n)||n<0)return void toast("???????????????????");turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,turn,{responseIndex:String(turn.assistantIndex),replacing:!0})||turn;
      const a=turn.assistantIndex,l=state.activeSessionId,d=ensureActiveRun(l),refreshBtn=e.querySelector(".refresh-btn");
      resetMessageActionStates(e);refreshBtn&&(refreshBtn.classList.add("refreshing"),refreshBtn.disabled=!0);
      const c=prepareRegeneratedResponse(t,e,l,a,"正在执行：路由预检");e=c.node;let m=c.liveItem;
      const userMessage=state.messages[n]||{},u=getUserAttachmentContextFromNode(t);
      const baseRequestMessages=state.messages.slice(0,n),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:l,run:d,readPending:()=>({promptText:s,rawPromptText:s,submitMode:"chat",messageIndex:n,responseIndex:a,liveItemId:m?.id||"",userDisplayItemId:t?.dataset?.displayItemId||t?.__displayItem?.id||"",imageContext:t?.dataset?.imageContext||t?.__displayItem?.imageContext||userMessage.imageContext||"",attachmentContext:u||userMessage.attachmentContext||"",quoteContext:t?.dataset?.quoteContext||t?.__displayItem?.quoteContext||userMessage.quoteContext||"",requestBaseMessages:baseRequestMessages,regenerate:!0,replaceAssistantIndex:a,startedAt})});
      const routeUi=createRouteRecognitionUi({sessionId:l,assistantNode:()=>e,liveItem:()=>m,responseIndex:()=>a,getPromptText:()=>s,signal:d.abortController?.signal});
      try{
        task.accept({capture:!0});
        const h=u?await restoreUserAttachmentsFromContext(u):[];
        const quoteRaw=t.dataset.quoteContext||t.__displayItem?.quoteContext||userMessage.quoteContext||"";
        const quotedMessage=quoteRaw?getMessageWorkflow().readQuoteContext(quoteRaw):null;
        const cleanQuotedContent=routeUtils.cleanQuotedContent;
        const buildQuotedRouteContent=routeUtils.buildQuotedRouteContent;
        const quotedImageContext=quotedMessage?.imageContext?parseImageContext(quotedMessage.imageContext):null;
        let quotedImageAttachments=[];
        if(quotedImageContext?.attachments?.length)try{quotedImageAttachments=await restoreImageAttachmentsFromContext(quotedImageContext)}catch(err){console.warn("restore quoted image attachments for regenerate failed",err),quotedImageAttachments=[]}
        const hasQuotedImage=quotedImageAttachments.length>0,quotedImageSource=(quotedImageContext?.target==="uploaded"||quotedImageContext?.mode==="edit_image")?"uploaded":"previous",quotedReferenceId=quotedImageContext?.referenceId||quotedImageContext?.reference_id||quotedImageContext?.selectedReferenceId||"";
        const quotedFileCandidates=quotedFileCandidatesFromContext(quotedMessage?.attachmentContext||quotedMessage?.attachment_context||""),quotedCleanText=cleanQuotedContent(quotedMessage?.content||quotedImageContext?.prompt||quotedImageContext?.userPrompt||quotedImageContext?.originalPrompt||""),quotedRouteContent=buildQuotedRouteContent({text:quotedCleanText||quotedMessage?.content||"",images:quotedImageAttachments});
        const quotedReferenceSummary=()=>({reference_id:quotedReferenceId||"imgref_quote",source:"quoted",target:quotedImageSource,count:quotedImageAttachments.length});
        const quotedImageCandidates=()=>quotedImageAttachments.map((item,index)=>({index:index+1,image_id:item.imageId||item.image_id||"",reference_id:quotedReferenceId||"imgref_quote",target:quotedImageSource,source:"quoted",filename:item.name||"",prompt:quotedCleanText||""}));
        const buildQuotedRouteContext=()=>({recent_messages:[{index:1,role:quotedMessage?.role||"user",content:quotedRouteContent||"[quoted_message]"}],suggested_contextual_image_prompt:[quotedCleanText,s].filter(Boolean).join("\n\n"),latest_user_image_request:null,latest_assistant_image_result:hasQuotedImage&&quotedImageSource==="previous"?quotedReferenceSummary():null,image_candidates:hasQuotedImage?quotedImageCandidates():[],file_candidates:quotedFileCandidates,last_generated_image:null,latest_uploaded_image:hasQuotedImage&&quotedImageSource==="uploaded"?quotedReferenceSummary():null,latest_image_reference:hasQuotedImage?quotedReferenceSummary():null,recent_image_references:[],recent_uploaded_image_references:[]});
        task.captured();task.routing();
        let p,g;
        try{if(quotedMessage){p=await routeUi.getEffectiveRouteWithSlowNotice(s,[],buildRequestHeaders("message",l),buildQuotedRouteContext()),g=p.mode}
        else{p=h.length&&!hasImageAttachments(h)?normalizeRoute({mode:"chat",target:"none",usePreviousImage:!1,confidence:1,evidence:"附件不包含图片，直接走聊天模型"},"chat"):await routeUi.getEffectiveRouteWithSlowNotice(s,h,buildRequestHeaders("message",l),null),g=p.mode}}catch(err){throw err}
        if(updateModeUi(g,state.autoMode),warnMissingModel(g,!0)){task.fail(new Error(`missing ${g} model`));return void e.remove()}
        if(d.stopped||d.abortController?.signal?.aborted)return;
        const routeAttachmentSelectors=submitHelpers.createRouteAttachmentSelectors(p,{isImageFile,isImageUnderstandingChat:()=>submitHelpers.isImageUnderstandingChat(s),isFileUnderstandingChat:()=>submitHelpers.isFileUnderstandingChat(s),currentTurnAttachments:h});
        const selectedChatAttachments=routeAttachmentSelectors.selectChatAttachments,selectedQuotedEditAttachments=()=>routeAttachmentSelectors.selectQuotedEditAttachments(quotedImageAttachments,h),selectedEditAttachments=routeAttachmentSelectors.selectEditAttachments;
        const q=String(p.contextualImagePrompt||s).trim(),chatH=quotedMessage?selectedChatAttachments(quotedImageAttachments):selectedChatAttachments(h),editH=quotedMessage&&"edit_image"===g?selectedQuotedEditAttachments():"edit_image"===g?selectedEditAttachments(h):h;
        const canResolveExistingEditImage="edit_image"===g&&(!!p.usePreviousImage||p.target==="previous"||p.target==="latest"||p.target==="last_generated"||(p.target==="uploaded"&&!!getUploadedImageContext(l,p.selectedReferenceId)));
        if("edit_image"===g&&!editH.length&&!canResolveExistingEditImage)throw new Error((h||[]).filter(item=>isImageFile(item)).length>1?"请明确要修改哪一张或哪几张图片。":"没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改。");
        const jobKind="chat"===g?"chat":"image",jobId=task.prepareHandoff(jobKind,"chat"===jobKind?makeClientChatJobId?.():makeClientImageJobId?.());
        "chat"===g?await sendChat(s,chatH,e,{sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,requestBaseMessages:quotedMessage?[quotedMessage]:baseRequestMessages,quotedMessage:!!quotedMessage,deferReplacementClear:!0,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff()}):await sendImage(q,{loadingNode:e,editMode:"edit_image"===g,editTarget:p.target,usePreviousImage:p.usePreviousImage,selectedIndexes:p.selectedIndexes,selectedReferenceId:p.selectedReferenceId,selectedImageIds:p.selectedImageIds,routePrompt:q,originalPrompt:s,attachments:editH,imageContext:quotedImageContext||("uploaded"===p.target?getUploadedImageContext(l,p.selectedReferenceId):null),sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||d.stopped||"AbortError"===t?.name||showRunError(l,t,m,e)}finally{task.stopped(),resetActionButtonState(refreshBtn),finishSessionTask(l,{run:d,stopSlowNotice:()=>routeUi.stopSlowNotice?.()}),updateResumeStreamButton()}
    }

    return Object.freeze({ forceImageFromUserMessage, regenerateAssistantMessage });
  }

  const api = Object.freeze({ createRegenerateWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.ChatUIApp?.appContext?.registerWorkflowModule?.('regenerate', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
