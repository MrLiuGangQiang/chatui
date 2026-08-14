(function initChatUIAppRegenerateWorkflow(root) {
  'use strict';

  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});
  const dispatchContractModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});

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
      quotedFileCandidatesFromContext,
      sendChat, dispatchTaskEvent,
      makeClientChatJobId, makeClientImageJobId, resumeSessionJobs,
      getPreviousImageAttachments, replaceSessionMessages, updateSessionDisplayItem, updateMessage,
    } = deps;
    const restorePreviousImageAttachments = getPreviousImageAttachments || root?.getPreviousImageAttachments;
    const window = root;
    const taskEvents = deps.taskEvents || root?.ChatUICore?.taskState?.TASK_EVENTS || {};
    const jobLifecycle = deps.jobLifecycle || root?.ChatUIAppJobWorkflow || {};
    const replacementApi = deps.messageReplacement
      || root?.ChatUIAppSessionPersistence
      || (typeof require === 'function' ? require('./session-persistence') : {});
    const emitTaskEvent = (sessionId, type, details = {}) => type
      ? dispatchTaskEvent?.(sessionId, { type, ...details })
      : null;

    function retainedPendingDisplay(session,responseIndex,preserveAssistant=false){
      // A historical regeneration only replaces the selected answer. Keep
      // later display items so the rendered conversation and its durable
      // snapshot stay aligned with state.messages.
      return (session?.display||[]).slice();
    }
    async function truncateRegenerationBranch(sessionId,turn,preserveAssistant=false){
      const removed=replacementApi.truncateConversationForRegeneration?.(state.messages,turn,{preserveAssistant})||(()=>{
        if(!Array.isArray(state.messages)||!Number.isInteger(turn?.userIndex)||turn.userIndex<0||turn.userIndex>=state.messages.length)return null;
        const assistantIndex=Number.isInteger(turn.assistantIndex)&&turn.assistantIndex>turn.userIndex?turn.assistantIndex:turn.userIndex+1;
        const hasAssistant=state.messages[assistantIndex]?.role==="assistant";
        if(hasAssistant&&!preserveAssistant)state.messages.splice(assistantIndex,1);
        state.messages.forEach((message,index)=>{if(message?.role==="user")message.messageIndex=String(index);if(message?.role==="assistant")message.responseIndex=String(index)});
        return {assistantIndex};
      })();
      if(!removed)return null;
      const session=state.sessions?.find(item=>item?.id===sessionId);
      const options={display:retainedPendingDisplay(session,removed.assistantIndex,preserveAssistant),pendingClarification:preserveAssistant?session?.pendingClarification||null:null,lastGeneratedImage:null};
      if(typeof replaceSessionMessages==="function")await replaceSessionMessages(sessionId,state.messages,options);
      else if(typeof root?.replaceSessionMessages==="function")await root.replaceSessionMessages(sessionId,state.messages,options);
      else if(session){session.messages=state.messages.slice();session.display=options.display;session.pendingClarification=options.pendingClarification;session.lastGeneratedImage=null;state.lastGeneratedImage=null}
      return removed;
    }

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
        const routeInfo=routeUtils.createExplicitTextToImageRoute?.(replayPrompt);
        if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0){const err=new Error("强制生图任务未能建立有效执行合同，已停止发送");err.code="ROUTE_NOT_READY";throw err}
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
      if(!await truncateRegenerationBranch(l,turn,replayPending))return void toast("找不到这条消息上下文，无法重新生成");
      if(replayPending){await replayPendingClarification(e,{sessionId:l,userText:s,assistantIndex:a});return}
      turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,{...turn,assistantIndex:a,hasAssistant:!1},{responseIndex:String(a),replacing:!0})||turn;
      const d=ensureActiveRun(l),refreshBtn=e.querySelector(".refresh-btn");
      resetMessageActionStates(e);refreshBtn&&(refreshBtn.classList.add("refreshing"),refreshBtn.disabled=!0);
      const c=prepareRegeneratedResponse(t,e,l,a,executionStatus.routeStageText?.("reading_context")||"正在读取当前对话上下文");e=c.node;let m=c.liveItem;
      const userMessage=state.messages[n]||{},u=getUserAttachmentContextFromNode(t),replay=clarificationApi.normalizeClarificationReplay?.(userMessage.clarificationReplay)||clarificationApi.normalizeClarificationReplay?.(state.messages[a]?.clarificationReplay)||null,replayPrompt=replay?.resolvedInput||s;
      const baseRequestMessages=state.messages.slice(0,n),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:l,run:d,readPending:()=>({promptText:replayPrompt,rawPromptText:s,submitMode:"chat",messageIndex:n,responseIndex:a,liveItemId:m?.id||"",userDisplayItemId:t?.dataset?.displayItemId||t?.__displayItem?.id||"",imageContext:t?.dataset?.imageContext||t?.__displayItem?.imageContext||userMessage.imageContext||"",attachmentContext:u||userMessage.attachmentContext||"",quoteContext:t?.dataset?.quoteContext||t?.__displayItem?.quoteContext||userMessage.quoteContext||"",requestBaseMessages:baseRequestMessages,regenerate:!0,replaceAssistantIndex:a,startedAt})});
      const routeUi=createRouteRecognitionUi({sessionId:l,assistantNode:()=>e,liveItem:()=>m,responseIndex:()=>a,getPromptText:()=>replayPrompt,signal:d.abortController?.signal});
      try{
        task.accept({capture:!0});
        const h=u?await restoreUserAttachmentsFromContext(u):[];if(u&&!h.length)throw new Error("原消息附件当前无法恢复，为避免缺少资源时继续执行，请重新上传附件后再试");
        const quoteRaw=t.dataset.quoteContext||t.__displayItem?.quoteContext||userMessage.quoteContext||"";
        const quotedMessage=quoteRaw?getMessageWorkflow().readQuoteContext(quoteRaw):null;
        const quotedImageContext=quotedMessage?.imageContext?parseImageContext(quotedMessage.imageContext):null;
        let quotedImageAttachments=[];
        if(quotedImageContext?.attachments?.length){if(typeof restoreImageAttachmentsFromContext!=="function")throw new Error("引用图片恢复服务不可用");try{quotedImageAttachments=await restoreImageAttachmentsFromContext(quotedImageContext)}catch(err){console.warn("restore quoted image attachments for regenerate failed",err);throw new Error("引用消息中的图片当前无法恢复，为避免脱离引用内容继续执行，请重新发送或重新上传图片后再试")}if(!Array.isArray(quotedImageAttachments)||quotedImageAttachments.length<quotedImageContext.attachments.length)throw new Error("引用消息中的图片恢复不完整，为避免脱离引用内容继续执行，请重新发送或重新上传图片后再试")}
        const quotedFileCandidates=quotedFileCandidatesFromContext(quotedMessage?.attachmentContext||quotedMessage?.attachment_context||"");
        const quotedRoute=submitHelpers.buildQuotedRouteContext({quotedMessage,quotedImageContext,restoredImageAttachments:quotedImageAttachments,quotedFileCandidates,currentInput:s,cleanQuotedContent:routeUtils.cleanQuotedContent,buildQuotedRouteContent:routeUtils.buildQuotedRouteContent});
        const buildQuotedRouteContext=()=>quotedRoute.context;
        task.captured();task.routing();
        let p,g;
        try{if(replay?.clarificationRouteContext){p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,{},replay.clarificationRouteContext),g=p.mode}
        else if(quotedMessage){p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,{},buildQuotedRouteContext()),g=p.mode}
        else{p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,{},null,{currentTurn:{messageIndex:n+1},submissionId:task.submissionId}),g=p.mode}}catch(err){throw err}
        if(d.stopped||d.abortController?.signal?.aborted)return;
        if(p.needClarification){
          const question=String(p.clarificationQuestion||"请先明确要使用的资源").trim();
          const clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService;
          const presentationApi=root?.ChatUIApp?.appContext?.getWorkflowModule?.("clarificationPresentation");
          const session=state.sessions?.find(item=>item?.id===l);
          const presentation=presentationApi?.buildClarificationPresentation?.({ ...p, clarificationQuestion: question },{
            messages:state.messages||[], lastGeneratedImage:session?.lastGeneratedImage||null,
          })||{html:""};
          const clarificationHtml=String(presentation.html||"");
          if(e?.isConnected){
            if(typeof root?.updateMessage==="function")root.updateMessage(e,clarificationHtml||question,{html:!!clarificationHtml,rawText:question,responseIndex:a});
            else if(e.querySelector?.(".content"))e.querySelector(".content").textContent=question;
          }
          if(m){
            m.content=clarificationHtml||question;m.rawText=question;m.html=clarificationHtml;m.pending=!1;m.responseIndex=a;
            root?.persistSessionDisplay?.(l);
          }
          const createdPending=clarificationApi?.createPendingClarification?clarificationApi.createPendingClarification({
            messages:state.messages.slice(0,n+1),clarificationText:question,routeInfo:p,
            sourceImageContext:userMessage.imageContext||null,sourceAttachmentContext:userMessage.attachmentContext||u||null,sourceQuoteContext:userMessage.quoteContext||null,
          }):null;
          const clarificationId=String(createdPending?.id||"");
          clarificationId&&e?.isConnected&&(e.dataset.clarificationId=clarificationId);
          if(m&&clarificationId){m.clarificationId=clarificationId;root?.persistSessionDisplay?.(l)}
          const assistant={role:"assistant",content:question,rawText:question,responseIndex:a,...clarificationHtml?{html:clarificationHtml}:{},...clarificationId?{clarificationId}:{}};
          if(Array.isArray(state.messages)){
            if("assistant"===state.messages[a]?.role)state.messages[a]=assistant;
            else state.messages.splice(a,0,assistant);
          }
          if(session){
            session.messages=Array.isArray(state.messages)?state.messages.slice():session.messages||[];
            if(createdPending){
              session.pendingClarification=createdPending;
              root?.saveSessionsMeta?.();
            }
            root?.saveSessionMessages?.(l,session.messages);
          }
          task.completePreflight();
          return;
        }
        if(routeUtils.isRouteDispatchable?.(p)!==!0){const err=new Error("路由任务尚未完成资源确认，已停止发送");err.code="ROUTE_NOT_READY";throw err}
        if(updateModeUi(g,state.autoMode),warnMissingModel(g,!0)){task.fail(new Error(`missing ${g} model`));return void e.remove()}
        if(d.stopped||d.abortController?.signal?.aborted)return;
        const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(p,state.messages||[],quotedMessage)||null,hasRouteMessageRefs=Array.isArray(p?.messageRefs)&&p.messageRefs.length>0;
        if(hasRouteMessageRefs&&!routeMessageProjection)throw new Error("路由选择的历史消息已不存在或不再匹配，已停止发送以避免脱离指定上下文回答");
        const quoteScopedChat=!!quotedMessage&&(!hasRouteMessageRefs||routeMessageProjection?.usesExplicitQuote),routeBaseMessages=routeMessageProjection?.messages||(quoteScopedChat?[quotedMessage]:baseRequestMessages);
        const restoreBoundImagePool=source=>submitHelpers.restoreBoundImagePool(p,{source,sessionId:l,getPreviousImageAttachments:restorePreviousImageAttachments});
        const quotedResourceAttachments=[...quotedImageAttachments];
        if(quotedMessage?.attachmentContext&&typeof restoreUserAttachmentsFromContext==="function"){
          const restoredQuote=await restoreUserAttachmentsFromContext(quotedMessage.attachmentContext);
          for(const item of restoredQuote){
            const type=isImageFile(item)?"image":"file",id=submitHelpers.mediaIdentity?.(item,type)||"";
            if(!quotedResourceAttachments.some(existing=>isImageFile(existing)===isImageFile(item)&&id&&submitHelpers.mediaIdentity?.(existing,type)===id))quotedResourceAttachments.push(item)
          }
        }
        const historyFiles=await submitHelpers.restoreHistoricalFilePool(p,{messages:state.messages||[],restoreUserAttachmentsFromContext,isImageFile,source:"history"});
        const contextFiles=await submitHelpers.restoreHistoricalFilePool(p,{messages:state.messages||[],restoreUserAttachmentsFromContext,isImageFile,source:"context"});
        const sourcePools={current:h,quoted:quotedResourceAttachments,history:[...await restoreBoundImagePool("history"),...historyFiles],context:[...await restoreBoundImagePool("context"),...contextFiles]};
        const restrictedSourcePools=submitHelpers.restrictExecutionResourcePools?.(p,sourcePools)||sourcePools;
        const executionPools=submitHelpers.buildExecutionResourcePools(restrictedSourcePools,{isImageFile,messages:routeMessageProjection?.messages||state.messages||[]});
        const executionMedia=submitHelpers.projectRouteExecutionMedia(p,executionPools);
         const quotedCleanText=quotedRoute?.cleanText||"";
         // 最终执行 prompt 必须包含用户原始完整输入（replayPrompt），
         // LLM 概括（contextualImagePrompt/editInstruction）只能作为补充、不能替代。
         const summarizedPrompt=String(p.contextualImagePrompt||p.editInstruction||"").trim();
         const originalReplayText=String(replayPrompt||"").trim();
         const qParts=[quotedMessage&&quotedCleanText?quotedCleanText:null,originalReplayText];
         if(summarizedPrompt&&!(summarizedPrompt.includes(originalReplayText)&&summarizedPrompt.length>originalReplayText.length))qParts.push(summarizedPrompt);
         const q=String(qParts.filter(Boolean).join("\n\n")).trim();
         if("chat"!==g&&q&&p?.dispatchContract&&typeof dispatchContractModule?.withArguments==="function"&&q!==String(p.dispatchContract.arguments?.prompt||"").trim()){p.dispatchContract=dispatchContractModule.withArguments(p.dispatchContract,{prompt:q})}
         const chatH=[...executionMedia.chatFiles,...executionMedia.chatImages],editH=executionMedia.imageInputs;
         const originalImageIndex=submitHelpers.originalImageIndex;
         const mediaMapContext=submitHelpers.buildMediaMapContext?.(executionMedia.chatImages,{isImageFile,originalIndex:originalImageIndex})||"";
         const chatPrompt=replayPrompt;
        if("chat"===g){
          const jobId=task.prepareHandoff("chat",makeClientChatJobId?.());
          await sendChat(chatPrompt,chatH,e,{sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,requestBaseMessages:routeBaseMessages,quotedMessage:quoteScopedChat?quotedMessage:null,systemContext:mediaMapContext?[mediaMapContext]:[],routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0,dispatchContract:p.dispatchContract,executionMedia,clarificationReplay:replay,deferReplacementClear:!0,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff()});
        }else{
          const imageBatchPlan=submitHelpers.executableImageBatch?.(p);
          if(imageBatchPlan){
            const compiledBatch=imageBatchPlan;
            const batchJobId=task.prepareHandoff("image_batch",makeClientBatchJobId?.());
            if(!m?.id){const error=new Error("多图重新生成缺少可恢复的显示记录，已停止发送");error.code="IMAGE_BATCH_DISPLAY_ITEM_MISSING";throw error}
            m.jobId=batchJobId;m.pending="1";root?.persistSessionDisplay?.(l);
            e?.dataset&&(e.dataset.jobId=batchJobId);root?.clearPendingFeedback?.(e);root?.clearReasoning?.(e);
            const batchAggregate={total:compiledBatch.items.length,completed:0,failed:0,statuses:compiledBatch.items.map(()=>"正在准备图片任务"),slotSizes:compiledBatch.items.map(item=>String(item?.dispatchContract?.arguments?.size||"auto").trim()||"auto"),slotSize:"auto",imageContext:null,childImageContexts:Array(compiledBatch.items.length).fill(null)};
            const initialBatchRawText=batchAggregate.statuses.map((status,index)=>`任务 ${index+1}/${batchAggregate.total}：${status}`).join("\n"),initialBatchHtml=typeof deps.renderImageBatchResult==="function"?deps.renderImageBatchResult({}, {total:batchAggregate.total, childContexts:batchAggregate.childImageContexts, statusHtml:deps.pendingFeedbackHtml?.(initialBatchRawText)||"", complete:false}):m.html;updateSessionDisplayItem?.(l,m,"assistant",initialBatchHtml,{html:!0,rawText:initialBatchRawText,pending:!0,responseIndex:m.responseIndex});e?.isConnected&&updateMessage?.(e,initialBatchHtml,{html:!0,rawText:initialBatchRawText,skipSave:!0,preserveLiveMedia:!0});root?.persistSessionDisplay?.(l);await sendImageBatch(l,{items:compiledBatch.items.map(item=>({dispatchContract:item.dispatchContract,executionMedia:submitHelpers.projectRouteExecutionMedia?.(item.route,executionPools)||item.executionResources,prompt:String(item.dispatchContract?.arguments?.prompt||"").trim(),label:String(item.task?.label||"").trim()})),batchJobId,submissionId:task.submissionId,batchParent:m,responseIndex:a,clarificationReplay:replay,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});

          }else{
            const jobId=task.prepareHandoff("image",makeClientImageJobId?.());
            await sendImage(q,{loadingNode:e,routePrompt:q,originalPrompt:replayPrompt,attachments:editH,maskAttachments:executionMedia.masks,executionMedia,dispatchContract:p.dispatchContract,clarificationReplay:replay,sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
          }
        }
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||failure.terminalBeforeError||failure.cancelled||d.stopped||"AbortError"===t?.name||showRunError(l,t,m,e)}finally{task.stopped(),resetActionButtonState(refreshBtn),finishSessionTask(l,{run:d,stopSlowNotice:()=>routeUi.stopSlowNotice?.()}),updateResumeStreamButton()}
    }

    return Object.freeze({ forceImageFromUserMessage, regenerateAssistantMessage });
  }

  const api = Object.freeze({ createRegenerateWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.ChatUIApp?.appContext?.registerWorkflowModule?.('regenerate', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
