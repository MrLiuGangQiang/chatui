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
      quotedFileCandidatesFromContext, buildRequestHeaders,
      sendChat, dispatchTaskEvent,
      makeClientChatJobId, makeClientImageJobId, resumeSessionJobs,
      getPreviousImageAttachments,
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

      const completePreflight = () => {
        if (handoffCommitted) return false;
        emitTaskEvent(sessionId, taskEvents.TASK_COMPLETED_COMMITTED, details());
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
      turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,turn,{responseIndex:String(turn.assistantIndex),replacing:!0})||turn;const n=turn.assistantIndex,a=state.activeSessionId,i=ensureActiveRun(a),o=e.nextElementSibling&&(e.nextElementSibling.classList?.contains("assistant")||e.nextElementSibling.classList?.contains("error"))?e.nextElementSibling:null,r=e.querySelector(".force-image-btn"),clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{},replay=clarificationApi.normalizeClarificationReplay?.(state.messages?.[s]?.clarificationReplay)||clarificationApi.normalizeClarificationReplay?.(state.messages?.[n]?.clarificationReplay)||null,replayPrompt=replay?.resolvedInput||t;
      resetMessageActionStates(o||e);r&&(r.classList.add("refreshing"),r.disabled=!0);
      const l=prepareRegeneratedResponse(e,o,a,n,"正在处理中 请稍后"),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:a,run:i,readPending:()=>({promptText:replayPrompt,rawPromptText:t,submitMode:"image",messageIndex:s,responseIndex:n,liveItemId:l.liveItem?.id||"",userDisplayItemId:e?.dataset?.displayItemId||e?.__displayItem?.id||"",imageContext:e?.dataset?.imageContext||e?.__displayItem?.imageContext||"",attachmentContext:e?.dataset?.attachmentContext||e?.__displayItem?.attachmentContext||"",requestBaseMessages:state.messages.slice(0,s),regenerate:!0,replaceAssistantIndex:n,startedAt})});
      try{
        task.accept({capture:!0});
        if(i.stopped||i.abortController?.signal?.aborted)return;
        task.captured();task.routing();
        const routeInfo=routeUtils.createExplicitTextToImageRoute?.(replayPrompt);
        if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0){const err=new Error("强制生图任务未能建立有效执行合同，已停止发送");err.code="ROUTE_NOT_READY";throw err}
        if(warnMissingModel(routeInfo.mode,!0)){task.fail(new Error("missing image model"));return void l.node?.remove()}
        const executionPools=submitHelpers.buildExecutionResourcePools({current:[],quoted:[],history:[],context:[]},{isImageFile});
        const executionMedia=submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools);
        const imagePrompt=String(routeInfo.contextualImagePrompt||replayPrompt).trim();
        updateModeUi(routeInfo.mode,state.autoMode);
        const jobId=task.prepareHandoff("image",makeClientImageJobId?.());
        await sendImage(imagePrompt,{loadingNode:l.node,attachments:executionMedia.imageInputs,maskAttachments:executionMedia.masks,executionMedia,taskContract:routeInfo.taskContract,routePrompt:imagePrompt,originalPrompt:replayPrompt,clarificationReplay:replay,sessionId:a,userAlreadyAdded:!0,liveItem:l.liveItem,replaceAssistantIndex:n,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||i.stopped||"AbortError"===t?.name||showRunError(a,t,l.liveItem,l.node)}finally{task.stopped(),resetActionButtonState(r),finishSessionTask(a,{run:i}),updateResumeStreamButton()}
    }

    function replayPendingClarification(node,{sessionId,userText,assistantIndex}={}){
      const clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService;
      const session=state.sessions?.find(item=>item?.id===sessionId);
      const rawPending=session?.pendingClarification;
      const pending=(clarificationApi?.migratePendingClarification||clarificationApi?.normalizePendingClarification)?.(rawPending)||null;
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
        root?.persistSessionDisplay?.(sessionId);
        root?.saveSessionMessages?.(sessionId,session.messages);
        root?.saveSessionsMeta?.()
      }
      return!0
    }

    async function regenerateAssistantMessage(e){
      if(isSessionBusy(state.activeSessionId))return;
      const t=findPreviousUserMessageNode(e),s=(t?.dataset.rawText||"").trim();
      if(!s)return void toast("找不到上一条提示词，无法重新生成");
      let turn=replacementApi.resolveUserMessageTurn?.(state.messages,t?.dataset?.messageIndex,{rawText:s})||null,n=turn?.userIndex;if(!Number.isInteger(n)||n<0)return void toast("找不到这条消息上下文，无法重新生成");turn=replacementApi.ensureAssistantReplacementSlot?.(state.messages,turn,{responseIndex:String(turn.assistantIndex),replacing:!0})||turn;
      const a=turn.assistantIndex,l=state.activeSessionId;
      if(replayPendingClarification(e,{sessionId:l,userText:s,assistantIndex:a}))return;
      const d=ensureActiveRun(l),refreshBtn=e.querySelector(".refresh-btn");
      resetMessageActionStates(e);refreshBtn&&(refreshBtn.classList.add("refreshing"),refreshBtn.disabled=!0);
      const c=prepareRegeneratedResponse(t,e,l,a,"正在执行：路由预检");e=c.node;let m=c.liveItem;
      const userMessage=state.messages[n]||{},u=getUserAttachmentContextFromNode(t),clarificationApi=root?.ChatUIServices?.clarification||root?.ChatUIClarificationService||{},replay=clarificationApi.normalizeClarificationReplay?.(userMessage.clarificationReplay)||clarificationApi.normalizeClarificationReplay?.(state.messages[a]?.clarificationReplay)||null,replayPrompt=replay?.resolvedInput||s;
      const baseRequestMessages=state.messages.slice(0,n),startedAt=Date.now();
      const task=createRegenerateTask({sessionId:l,run:d,readPending:()=>({promptText:replayPrompt,rawPromptText:s,submitMode:"chat",messageIndex:n,responseIndex:a,liveItemId:m?.id||"",userDisplayItemId:t?.dataset?.displayItemId||t?.__displayItem?.id||"",imageContext:t?.dataset?.imageContext||t?.__displayItem?.imageContext||userMessage.imageContext||"",attachmentContext:u||userMessage.attachmentContext||"",quoteContext:t?.dataset?.quoteContext||t?.__displayItem?.quoteContext||userMessage.quoteContext||"",requestBaseMessages:baseRequestMessages,regenerate:!0,replaceAssistantIndex:a,startedAt})});
      const routeUi=createRouteRecognitionUi({sessionId:l,assistantNode:()=>e,liveItem:()=>m,responseIndex:()=>a,getPromptText:()=>replayPrompt,signal:d.abortController?.signal});
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
        const buildQuotedRouteContext=()=>({quoted_message:{index:1,role:quotedMessage?.role||"user",id:quotedMessage?.displayItemId||""},recent_messages:[{index:1,role:quotedMessage?.role||"user",content:quotedRouteContent||"[quoted_message]"}],suggested_contextual_image_prompt:[quotedCleanText,s].filter(Boolean).join("\n\n"),latest_user_image_request:null,latest_assistant_image_result:hasQuotedImage&&quotedImageSource==="previous"?quotedReferenceSummary():null,image_candidates:hasQuotedImage?quotedImageCandidates():[],file_candidates:quotedFileCandidates,last_generated_image:null,latest_uploaded_image:hasQuotedImage&&quotedImageSource==="uploaded"?quotedReferenceSummary():null,latest_image_reference:hasQuotedImage?quotedReferenceSummary():null,recent_image_references:[],recent_uploaded_image_references:[]});
        task.captured();task.routing();
        let p,g;
        try{if(replay?.clarificationRouteContext){p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,buildRequestHeaders("message",l),replay.clarificationRouteContext),g=p.mode}
        else if(quotedMessage){p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,buildRequestHeaders("message",l),buildQuotedRouteContext()),g=p.mode}
        else{p=await routeUi.getEffectiveRouteWithSlowNotice(replayPrompt,h,buildRequestHeaders("message",l),null),g=p.mode}}catch(err){throw err}
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
          const createdPending=!p.localClarification&&clarificationApi?.createPendingClarification?clarificationApi.createPendingClarification({
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
        const restoreBoundImagePool=async source=>{
          const resources=submitHelpers.routeMediaResources?.(p,"image",source)||[];
          if(!resources.length)return[];
          if(typeof restorePreviousImageAttachments!=="function")throw new Error("无法恢复路由选择的历史图片，已停止发送");
          const ids=[...new Set(resources.map(resource=>String(resource.id||"")).filter(Boolean))],restored=[];
          if(ids.length)restored.push(...await restorePreviousImageAttachments(l,null,"",ids));
          for(const resource of resources.filter(resource=>!resource.id))restored.push(...await restorePreviousImageAttachments(l,[Number(resource.index)],resource.reference_id||"",[]));
          return restored.map(item=>({...item,routeSource:source}))
        };
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
        const executionPools=submitHelpers.buildExecutionResourcePools({current:h,quoted:quotedResourceAttachments,history:[...await restoreBoundImagePool("history"),...historyFiles],context:[...await restoreBoundImagePool("context"),...contextFiles]},{isImageFile});
        const executionMedia=submitHelpers.projectRouteExecutionMedia(p,executionPools);
         const q=String(p.contextualImagePrompt||p.editInstruction||replayPrompt).trim(),chatH=[...executionMedia.chatFiles,...executionMedia.chatImages],editH=executionMedia.imageInputs;
         const originalImageIndex=submitHelpers.originalImageIndex;
         const imageAttachmentIndexGuide=submitHelpers.imageAttachmentIndexGuide?.(chatH,{isImageFile,originalIndex:originalImageIndex})||"";
         const comparisonGuide=executionMedia.chatImages.some(item=>["compare_a","compare_b"].includes(item.routeRole))
           ? executionMedia.chatImages.map((item,index)=>`随附图片${index+1} = ${item.routeRole}`).join("\n") : "";
         const chatPrompt=[comparisonGuide,imageAttachmentIndexGuide,replayPrompt].filter(Boolean).join("\n\n");
        const jobKind="chat"===g?"chat":"image",jobId=task.prepareHandoff(jobKind,"chat"===jobKind?makeClientChatJobId?.():makeClientImageJobId?.());
         "chat"===g?await sendChat(chatPrompt,chatH,e,{sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,requestBaseMessages:routeBaseMessages,quotedMessage:quoteScopedChat?quotedMessage:null,routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0,clarificationReplay:replay,deferReplacementClear:!0,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff()}):await sendImage(q,{loadingNode:e,routePrompt:q,originalPrompt:replayPrompt,attachments:editH,maskAttachments:executionMedia.masks,executionMedia,taskContract:p.taskContract,clarificationReplay:replay,sessionId:l,userAlreadyAdded:!0,liveItem:m,replaceAssistantIndex:a,submissionId:task.submissionId,clientJobId:jobId,onDurableHandoff:()=>task.commitHandoff(),onInterfaceCompleted:completion=>task.interfaceCompleted(completion)});
        task.complete()
      }catch(t){const failure=task.fail(t);failure.preserve||d.stopped||"AbortError"===t?.name||showRunError(l,t,m,e)}finally{task.stopped(),resetActionButtonState(refreshBtn),finishSessionTask(l,{run:d,stopSlowNotice:()=>routeUi.stopSlowNotice?.()}),updateResumeStreamButton()}
    }

    return Object.freeze({ forceImageFromUserMessage, regenerateAssistantMessage });
  }

  const api = Object.freeze({ createRegenerateWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.ChatUIApp?.appContext?.registerWorkflowModule?.('regenerate', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
