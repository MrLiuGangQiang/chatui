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
          const t=$("prompt").value.trim();
          if(!t&&!state.attachments.length)return;
          unlockDoneSound(),saveConfig(!0);
          const s=state.activeSessionId,n=ensureActiveRun(s),a=[...state.attachments];
          let i="chat"===state.mode?state.messages.length:null,o=null,r=null,l=null,d=null,c=state.mode,m=normalizeRoute({mode:state.mode,target:"image"===state.mode?"new":"none",confidence:1},state.mode);
          try{
            await prepareUserAttachmentPreviews(a);
            if(null!==state.editingIndex&&state.editingNode&&"chat"===state.mode&&(o=applyPendingEdit(t)),!o){
              const e=renderUserMessageWithAttachments(t||"已发送附件",a),n=buildUserMessageContent(t,a),o=buildUserApiContent(t,a),r=await buildUploadedImageContext(t,a),l=r?JSON.stringify(r):"",d=await buildUserAttachmentContext(t,a),c=d?JSON.stringify(d):"",m=addMessage("user",e,{html:!0,rawText:n,messageIndex:i,imageContext:l,attachmentContext:c}),h=appendSessionDisplayMessage(s,"user",e,{html:!0,rawText:n,messageIndex:i,imageContext:l,attachmentContext:c});
              persistSessionDisplay(s),m.__displayItem=h,h?.id&&(m.dataset.displayItemId=h.id),state.messages.push({role:"user",content:o,html:e,rawText:n,messageIndex:i,...l?{imageContext:l}:{},...c?{attachmentContext:c}:{}}),getActiveSession().messages=cloneMessageList(state.messages)
            }
            saveChatHistory(),$("prompt").value="",state.promptDrafts.set(s,""),clearAttachments(),scheduleAutoResize(),setSessionBusy(s,!0);
            const e=getActiveSession();
            if(o){const t=prepareReplacementResponse(o,s);r=t.node,d=t.liveItem}else r=addMessage("assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",skipSave:!0}),e&&(d=appendSessionDisplayMessage(s,"assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",pending:!0,responseIndex:state.messages.length}),r.__displayItem=d);
            try{m=await getEffectiveRoute(t,a,s,buildRequestHeaders("message",s)),c=m.mode}catch(e){c="chat",m=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0}),console.warn("route failed, fallback to chat:",e)}
            if(n.stopped||n.abortController?.signal?.aborted)return;
            const routePrompt=String(m.contextualImagePrompt||t).trim();
            if(s===state.activeSessionId&&updateModeUi(c,state.autoMode),s===state.activeSessionId&&warnMissingModel(c,!0)){
              const e="chat"===c?"请先在设置里选择聊天模型":"请先在设置里选择生图模型";
              return r?.isConnected?(r.classList.remove("assistant"),r.classList.add("error"),(()=>{const e=r.querySelector(".avatar");e&&(e.textContent="!")})(),updateMessage(r,e,{rawText:e})):showRunError(s,new Error(e),d,r),void(d&&updateSessionDisplayItem(s,d,"error",e,{rawText:e,pending:!1}))
            }
            "chat"===c?await sendChat(t,a,r,{sessionId:s,userAlreadyAdded:!0,liveItem:d,replaceAssistantIndex:o?.responseIndex,requestBaseMessages:o?state.messages.slice(0,o.index):null}):await sendImage(routePrompt,{loadingNode:r,editMode:"edit_image"===c,editTarget:m.target,usePreviousImage:m.usePreviousImage,selectedIndexes:m.selectedIndexes,selectedReferenceId:m.selectedReferenceId,selectedImageIds:m.selectedImageIds,routePrompt:routePrompt,originalPrompt:t,attachments:a,imageContext:"uploaded"===m.target?getLatestUploadedImageContext(s):null,sessionId:s,userAlreadyAdded:!0,liveItem:d,replaceAssistantIndex:o?.responseIndex}),state.editingIndex=null,state.editingNode=null
          }catch(e){
            n.stopped||"AbortError"===e?.name||showRunError(s,e,d,r)
          }finally{
            setSessionBusy(s,!1),clearActiveRun(s,n),$("prompt").focus()
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
