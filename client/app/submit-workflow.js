(function initChatUIAppSubmitWorkflow(root) {
  // Intentionally not strict: submit body is migrated from app.js and resolved through a deps scope.

  function createSubmitWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    async function onSubmit(e) {
      with (deps) {

          e.preventDefault();
          if(isSessionBusy(state.activeSessionId)){
            const t=e?.submitter,s=t?.id==="sendBtn"||t?.closest?.("#sendBtn");
            if(state.suppressNextSubmitStop)return void(state.suppressNextSubmitStop=!1);
            return void(s?await stopActiveRun(state.activeSessionId):toast("当前正在处理，点击停止按钮可中断"))
          }
          if(hasPendingUploads())return updateSendAvailability(),void toast("文件还在处理中，请等待完成后再发送");
          state.suppressNextSubmitStop=!1;
          const promptText=$("prompt").value.trim();
          if(!promptText&&!state.attachments.length)return;
          unlockDoneSound(),saveConfig(!0);
          const sessionId=state.activeSessionId,run=ensureActiveRun(sessionId),attachments=[...state.attachments],targetSession=state.sessions?.find?.(e=>e.id===sessionId)||getActiveSession(),submitMode=state.mode;
          const isTargetActive=()=>sessionId===state.activeSessionId;
          const persistTargetMessages=()=>{isTargetActive()?saveChatHistory():"function"==typeof saveSessionMessages&&saveSessionMessages(sessionId,targetSession.messages||[])};
          let messageIndex="chat"===submitMode?(Array.isArray(targetSession?.messages)&&targetSession.messages.length?targetSession.messages.length:state.messages.length):null;
          let replacement=null,assistantNode=null,liveItem=null,routeMode=submitMode,routeInfo=normalizeRoute({mode:submitMode,target:"image"===submitMode?"new":"none",confidence:1},submitMode),userNode=null,userDisplayItem=null,requestBaseMessages=null;
          try{
            if(null!==state.editingIndex&&state.editingNode&&"chat"===submitMode&&isTargetActive())replacement=applyPendingEdit(promptText);
            if(!replacement){
              const userHtml=renderUserMessageWithAttachments(promptText||"已发送附件",attachments),rawText=buildUserMessageContent(promptText,attachments),apiContent=buildUserApiContent(promptText,attachments),message={role:"user",content:apiContent,html:userHtml,rawText,messageIndex};
              userNode=isTargetActive()?addMessage("user",userHtml,{html:!0,rawText,messageIndex}):null;
              userDisplayItem=appendSessionDisplayMessage(sessionId,"user",userHtml,{html:!0,rawText,messageIndex});
              persistSessionDisplay(sessionId);
              if(userNode){userNode.__displayItem=userDisplayItem;userDisplayItem?.id&&(userNode.dataset.displayItemId=userDisplayItem.id)}
              if(isTargetActive()){state.messages.push(message);getActiveSession().messages=cloneMessageList(state.messages)}
              else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),message]);
              persistTargetMessages()
            }
            $("prompt").value="",state.promptDrafts.set(sessionId,""),clearAttachments(),scheduleAutoResize(),setSessionBusy(sessionId,!0);
            const sessionForReply=isTargetActive()?getActiveSession():targetSession,responseIndex=Array.isArray(sessionForReply?.messages)&&sessionForReply.messages.length?sessionForReply.messages.length:state.messages.length;
            if(replacement){const prepared=prepareReplacementResponse(replacement,sessionId);assistantNode=prepared.node;liveItem=prepared.liveItem}
            else {
              assistantNode=isTargetActive()?addMessage("assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",skipSave:!0}):null;
              if(sessionForReply){liveItem=appendSessionDisplayMessage(sessionId,"assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",pending:!0,responseIndex});assistantNode&&(assistantNode.__displayItem=liveItem)}
            }
            await prepareUserAttachmentPreviews(attachments);
            if(!replacement){
              const uploadedContext=await buildUploadedImageContext(promptText,attachments),imageContext=uploadedContext?JSON.stringify(uploadedContext):"",attachmentContextValue=await buildUserAttachmentContext(promptText,attachments),attachmentContext=attachmentContextValue?JSON.stringify(attachmentContextValue):"";
              if(userDisplayItem){userDisplayItem.imageContext=imageContext;userDisplayItem.attachmentContext=attachmentContext;persistSessionDisplay(sessionId)}
              const messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message){imageContext&&(message.imageContext=imageContext);attachmentContext&&(message.attachmentContext=attachmentContext)}
              if(userNode){imageContext&&(userNode.dataset.imageContext=imageContext);attachmentContext&&(userNode.dataset.attachmentContext=attachmentContext)}
              persistTargetMessages()
            }
            try{routeInfo=await getEffectiveRoute(promptText,attachments,sessionId,buildRequestHeaders("message",sessionId)),routeMode=routeInfo.mode}catch(e){routeMode="chat",routeInfo=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0}),console.warn("route failed, fallback to chat:",e)}
            if(run.stopped||run.abortController?.signal?.aborted)return;
            const routePrompt=String(routeInfo.contextualImagePrompt||promptText).trim();
            if(isTargetActive()&&updateModeUi(routeMode,state.autoMode),isTargetActive()&&warnMissingModel(routeMode,!0)){
              const message="chat"===routeMode?"请先在设置里选择聊天模型":"请先在设置里选择生图模型";
              return assistantNode?.isConnected?(assistantNode.classList.remove("assistant"),assistantNode.classList.add("error"),(()=>{const e=assistantNode.querySelector(".avatar");e&&(e.textContent="!")})(),updateMessage(assistantNode,message,{rawText:message})):showRunError(sessionId,new Error(message),liveItem,assistantNode),void(liveItem&&updateSessionDisplayItem(sessionId,liveItem,"error",message,{rawText:message,pending:!1}))
            }
            requestBaseMessages=replacement&&isTargetActive()?state.messages.slice(0,replacement.index):null;
            "chat"===routeMode?await sendChat(promptText,attachments,assistantNode,{sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacement?.responseIndex,requestBaseMessages}):await sendImage(routePrompt,{loadingNode:assistantNode,editMode:"edit_image"===routeMode,editTarget:routeInfo.target,usePreviousImage:routeInfo.usePreviousImage,selectedIndexes:routeInfo.selectedIndexes,selectedReferenceId:routeInfo.selectedReferenceId,selectedImageIds:routeInfo.selectedImageIds,routePrompt,originalPrompt:promptText,attachments,imageContext:"uploaded"===routeInfo.target?getLatestUploadedImageContext(sessionId):null,sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacement?.responseIndex}),state.editingIndex=null,state.editingNode=null
          }catch(err){
            run.stopped||"AbortError"===err?.name||showRunError(sessionId,err,liveItem,assistantNode)
          }finally{
            setSessionBusy(sessionId,!1),clearActiveRun(sessionId,run),$("prompt").focus()
          }

      }
    }

    return Object.freeze({ onSubmit });
  }

  const api = Object.freeze({ createSubmitWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSubmitWorkflow = api;
  if (root?.window) root.window.ChatUIAppSubmitWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
