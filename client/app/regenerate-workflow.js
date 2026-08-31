(function initChatUIAppRegenerateWorkflow(root) {
  'use strict';

  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});

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
      updateResumeStreamButton, getSubmitWorkflow,
      dispatchTaskEvent, makeClientImageJobId, resumeSessionJobs,
      replaceSessionMessages, updateMessage,
    } = deps;
    const window = root;
    const taskEvents = deps.taskEvents || root?.ChatUICore?.taskState?.TASK_EVENTS || {};
    const jobLifecycle = deps.jobLifecycle || root?.ChatUIAppJobWorkflow || {};
    const replacementApi = deps.messageReplacement
      || root?.ChatUIAppSessionPersistence
      || (typeof require === 'function' ? require('./session-persistence') : {});
    const emitTaskEvent = (sessionId, type, details = {}) => type
      ? dispatchTaskEvent?.(sessionId, { type, ...details })
      : null;

    function createRegenerateTask({ sessionId, run, readPending }) {
      const submissionId = jobLifecycle.makeSubmissionId?.()
        || `submit-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
      let jobId = '';
      let jobKind = '';
      let handoffCommitted = false;
      let terminalCommitted = false;
      const savePending = patch => getSubmitWorkflow().savePendingSubmit?.(sessionId, {
        ...(typeof readPending === 'function' ? readPending() : {}),
        submissionId,
        userCommitted: true,
        ...patch,
      }) !== false;
      const clearPending = () => getSubmitWorkflow().clearPendingSubmit?.(sessionId);
      const details = () => ({ submissionId, jobId, jobKind });
      const cancelled = () => run?.stopped === true || run?.abortController?.signal?.aborted === true;
      const commitTerminal = (type, payload = details()) => {
        if (!type || terminalCommitted) return false;
        terminalCommitted = true;
        emitTaskEvent(sessionId, type, payload);
        return true;
      };
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
        if (terminalCommitted) return false;
        commitHandoff();
        if (!commitTerminal(taskEvents.JOB_COMPLETED_COMMITTED, details())) return false;
        finishSessionTask?.(sessionId, { run });
        return true;
      };

      const completePreflight = () => {
        if (handoffCommitted || !commitTerminal(taskEvents.TASK_COMPLETED_COMMITTED, details())) return false;
        clearPending();
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
        completePreflight,
        interfaceCompleted,
        fail(error) {
          const preserve = jobLifecycle.shouldPreservePendingSubmitOnError?.(error, state, run) || false;
          const terminalBeforeError = terminalCommitted;
          const cancelledBeforeError = cancelled();
          let failureEvent = null;
          if (!preserve && !terminalBeforeError) {
            clearPending();
            if (!cancelledBeforeError) {
              failureEvent = handoffCommitted && jobId
                ? (error?.terminalJob ? taskEvents.JOB_FAILED : taskEvents.JOB_RECOVERY_STARTED)
                : taskEvents.TASK_FAILED;
              if (failureEvent === taskEvents.JOB_RECOVERY_STARTED) {
                emitTaskEvent(sessionId, failureEvent, { ...details(), error });
                root.setTimeout?.(() => resumeSessionJobs?.(sessionId), 0);
              } else {
                commitTerminal(failureEvent, { ...details(), error });
              }
            }
          }
          return { preserve, failureEvent, terminalBeforeError, cancelled: cancelledBeforeError };
        },
        stopped() {
          if (cancelled()) commitTerminal(taskEvents.TASK_STOPPED, details());
        },
      });
    }

    async function forceImageFromUserMessage(e){
      if(isSessionBusy(state.activeSessionId))return;
      const t=(e?.dataset.rawText||"").trim();
      if(!t)return void toast("找不到这条消息内容，无法强制生图");
      let turn=replacementApi.resolveUserMessageTurn?.(state.messages,e?.dataset?.messageIndex,{rawText:t})||null,s=turn?.userIndex;
      if(!Number.isInteger(s)||s<0)return void toast("找不到这条消息上下文，无法强制生图");
      turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,turn,{responseIndex:String(turn.assistantIndex),replacing:!0})||turn;const n=turn.assistantIndex,a=state.activeSessionId,i=ensureActiveRun(a),o=e.nextElementSibling&&(e.nextElementSibling.classList?.contains("assistant")||e.nextElementSibling.classList?.contains("error"))?e.nextElementSibling:null,r=e.querySelector(".force-image-btn"),clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{},replay=clarificationApi.normalizeClarificationReplay?.(state.messages?.[s]?.clarificationReplay)||clarificationApi.normalizeClarificationReplay?.(state.messages?.[n]?.clarificationReplay)||null,replayPrompt=replay?.resolvedInput||t;
      resetMessageActionStates(o||e);r&&(r.classList.add("refreshing"),r.disabled=!0);
      const l=prepareRegeneratedResponse(e,o,a,n,executionStatus.operationStatusText?.("text_to_image","prepare")||"正在准备图片生成参数"),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:a,run:i,readPending:()=>({promptText:replayPrompt,rawPromptText:t,submitMode:"image",messageIndex:s,responseIndex:n,liveItemId:l.liveItem?.id||"",userDisplayItemId:e?.dataset?.displayItemId||e?.__displayItem?.id||"",imageContext:e?.dataset?.imageContext||e?.__displayItem?.imageContext||"",attachmentContext:e?.dataset?.attachmentContext||e?.__displayItem?.attachmentContext||"",requestBaseMessages:state.messages.slice(0,s),regenerate:!0,replaceAssistantIndex:n,startedAt})});
      try{
        task.accept({capture:!0});
        if(i.stopped||i.abortController?.signal?.aborted)return;
        task.captured();task.routing();
        // 强制生图是显式用户覆盖：不做意图识别/路由判断，直接把当前内容作为
        // text_to_image 提示词构造可执行路由。
        const forcedImageRoute=typeof routeUtils.createExplicitTextToImageRoute==='function'
          ? routeUtils.createExplicitTextToImageRoute(replayPrompt)
          : null;
        const routeInfo=forcedImageRoute;
        if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0
            || routeInfo?.dispatchContract?.operation!=='text_to_image'){
          const err=new Error("强制生图失败，请重试；如果仍失败，请重新描述图片内容。");
          err.code="FORCED_IMAGE_ROUTE_NOT_READY";
          throw err;
        }
        if(warnMissingModel(routeInfo.mode,!0)){task.fail(new Error("missing image model"));return void l.node?.remove()}
        const executionPools=submitHelpers.buildExecutionResourcePools({current:[],quoted:[],history:[],context:[]},{isImageFile,messages:state.messages||[]});
        const executionMedia=submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools);
        const imagePrompt=String(routeInfo.contextualImagePrompt||replayPrompt).trim();
        updateModeUi(routeInfo.mode,state.autoMode);
        const jobId=task.prepareHandoff("image",makeClientImageJobId?.());
        await sendImage(imagePrompt,{loadingNode:l.node,attachments:executionMedia.imageInputs,maskAttachments:executionMedia.masks,executionMedia,dispatchContract:routeInfo.dispatchContract,routePrompt:imagePrompt,originalPrompt:replayPrompt,clarificationReplay:replay,sessionId:a,userAlreadyAdded:!0,liveItem:l.liveItem,replaceAssistantIndex:n,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||failure.terminalBeforeError||failure.cancelled||i.stopped||"AbortError"===t?.name||showRunError(a,t,l.liveItem,l.node)}finally{task.stopped(),resetActionButtonState(r),finishSessionTask(a,{run:i}),updateResumeStreamButton()}
    }

    function replayPendingClarification(node,{sessionId,userText,assistantIndex}={}){
      const clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService;
      const session=state.sessions?.find(item=>item?.id===sessionId);
      const rawPending=session?.pendingClarification;
      const pending=clarificationApi?.normalizePendingClarification?.(rawPending)||null;
      if(session&&pending&&String(rawPending?.id||"")!==String(pending.id||"")){session.pendingClarification=pending;root?.saveSessionsMeta?.()}
      const assistantMessage=Array.isArray(state.messages)?state.messages[assistantIndex]:null;
      if(!clarificationApi?.matchesPendingClarificationMessage?.(pending,{message:assistantMessage,userText}))return!1;
      const routeInfo=clarificationApi.pendingClarificationRouteInfo?.(pending);
      if(!routeInfo)return!1;
      const presentationApi=root?.ChatUIApp?.appContext?.getWorkflowModule?.("clarificationPresentation");
      let quotedImageContext=null;
      try{
        const quote="string"===typeof pending.sourceQuoteContext?JSON.parse(pending.sourceQuoteContext):pending.sourceQuoteContext;
        quotedImageContext=quote?.imageContext||quote?.image_context||null
      }catch{}
      const question=String(routeInfo.clarificationQuestion||pending.clarificationText||"请补充完成当前任务所需的信息后继续。").trim();
      const presentation=presentationApi?.buildClarificationPresentation?.(routeInfo,{
        messages:state.messages||[],lastGeneratedImage:session?.lastGeneratedImage||null,
        currentImageContext:pending.sourceImageContext||null,quotedImageContext,
      })||{html:""};
      const clarificationHtml=String(presentation.html||""),displayContent=clarificationHtml||question,clarificationId=String(pending.id||"");
      resetMessageActionStates(node);
      if(node?.isConnected){
        if(typeof root?.updateMessage==="function")root.updateMessage(node,displayContent,{html:!!clarificationHtml,rawText:question,responseIndex:assistantIndex});
        else if(node.querySelector?.(".content"))node.querySelector(".content").textContent=question;
        clarificationId&&(node.dataset.clarificationId=clarificationId)
      }
      const assistant={...assistantMessage,role:"assistant",content:question,rawText:question,responseIndex:assistantIndex,...clarificationHtml?{html:clarificationHtml}:{},...clarificationId?{clarificationId}:{}};
      if(Array.isArray(state.messages))state.messages[assistantIndex]=assistant;
      if(session){
        session.pendingClarification=pending;
        session.messages=Array.isArray(state.messages)?state.messages.slice():session.messages||[];
        const liveItem=node?.__displayItem||((session.display||[]).find(item=>item?.id&&item.id===node?.dataset?.displayItemId)||null);
        if(liveItem){liveItem.role="assistant";liveItem.content=displayContent;liveItem.rawText=question;liveItem.html=clarificationHtml;liveItem.pending=!1;liveItem.responseIndex=String(assistantIndex);clarificationId&&(liveItem.clarificationId=clarificationId)}
        if(typeof replaceSessionMessages==="function")replaceSessionMessages(sessionId,session.messages,{display:session.display||[],pendingClarification:pending,lastGeneratedImage:session.lastGeneratedImage||null});
        else {root?.persistSessionDisplay?.(sessionId);root?.saveSessionMessages?.(sessionId,session.messages)}
        root?.saveSessionsMeta?.()
      }
      return!0
    }

    async function regenerateAssistantMessage(e){
      if(isSessionBusy(state.activeSessionId))return;
      const t=findPreviousUserMessageNode(e),s=(t?.dataset.rawText||"").trim();
      if(!s)return void toast("找不到上一条提示词，无法重新生成");
      let turn=replacementApi.resolveUserMessageTurn?.(state.messages,t?.dataset?.messageIndex,{rawText:s})||null,n=turn?.userIndex;if(!Number.isInteger(n)||n<0)return void toast("找不到这条消息上下文，无法重新生成");
      const a=turn.assistantIndex,l=state.activeSessionId,session=state.sessions?.find(item=>item?.id===l),clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{};
      const replayPending=!!clarificationApi.matchesPendingClarificationMessage?.(clarificationApi.normalizePendingClarification?.(session?.pendingClarification)||null,{message:state.messages?.[a],userText:s});
      if(replayPending){
        const replayStatus=executionStatus.routeStageText?.("reading_context")||"正在读取当前对话上下文",replayHtml=typeof deps.pendingFeedbackHtml==="function"?deps.pendingFeedbackHtml(replayStatus):replayStatus;
        resetMessageActionStates(e);
        if(e?.dataset){delete e.dataset.imageContext;delete e.dataset.attachmentContext;delete e.dataset.jobId}
        updateMessage?.(e,replayHtml,{html:!0,rawText:replayStatus,skipSave:!0,noScroll:!0,responseIndex:a,preserveLiveMedia:!1});
        await replayPendingClarification(e,{sessionId:l,userText:s,assistantIndex:a});return
      }
      const submitWorkflow=getSubmitWorkflow();
      if(typeof submitWorkflow?.onSubmit!=="function"){
        const failure=new Error("统一提交工作流不可用，请刷新页面后重试");
        failure.code="REGENERATE_SUBMIT_WORKFLOW_UNAVAILABLE";
        throw failure
      }
      // Regeneration is the edit/resend pipeline with the original text. Prepare the
      // same editing state editUserMessage prepares, then let submitWorkflow.runSubmit
      // own preflight, routing, resource pools, dispatch, replacement, and task lifecycle.
      state.editingNode?.classList.remove("editing");
      state.editingIndex=n;
      state.editingNode=t;
      state.editingQuoteContext=String(t?.dataset?.quoteContext||t?.__displayItem?.quoteContext||state.messages[n]?.quoteContext||"");
      t.classList.add("editing");
      try{
        const originalAttachmentContext=getUserAttachmentContextFromNode(t);
        state.attachments=originalAttachmentContext?await restoreUserAttachmentsFromContext(originalAttachmentContext):[];
      }catch(err){
        console.warn("restore regeneration attachments failed",err);
        state.attachments=[]
      }
      resetMessageActionStates(e);
      await submitWorkflow.onSubmit({preventDefault(){}},{promptOverride:s})
    }
    return Object.freeze({ forceImageFromUserMessage, regenerateAssistantMessage });
  }

  const api = Object.freeze({ createRegenerateWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.ChatUIApp?.appContext?.registerWorkflowModule?.('regenerate', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
