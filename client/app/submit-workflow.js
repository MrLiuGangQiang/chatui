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
          const sessionId=state.activeSessionId,run=ensureActiveRun(sessionId);let attachments=[...state.attachments];const targetSession=state.sessions?.find?.(e=>e.id===sessionId)||getActiveSession(),submitMode=state.mode;
          const isTargetActive=()=>sessionId===state.activeSessionId;
          const persistTargetMessages=()=>{isTargetActive()?saveChatHistory():"function"==typeof saveSessionMessages&&saveSessionMessages(sessionId,targetSession.messages||[])};
          let messageIndex="chat"===submitMode?(Array.isArray(targetSession?.messages)&&targetSession.messages.length?targetSession.messages.length:state.messages.length):null;
          const quotedMessage="chat"===submitMode&&!state.editingIndex?getQuotedMessage?.():null,quoteContext=quotedMessage?JSON.stringify(quotedMessage):"";
          const parseContextValue=value=>{if(!value)return null;if(typeof value==="string")try{return JSON.parse(value)}catch{return null}return typeof value==="object"?value:null};
          let quotedImageContext=parseContextValue(quotedMessage?.imageContext),quotedImageAttachments=[];
          let replacement=null,assistantNode=null,liveItem=null,routeMode=submitMode,routeInfo=normalizeRoute({mode:submitMode,target:"image"===submitMode?"new":"none",confidence:1},submitMode),userNode=null,userDisplayItem=null,requestBaseMessages=null;
          try{
            if(null!==state.editingIndex&&state.editingNode&&"chat"===submitMode&&isTargetActive())replacement=applyPendingEdit(promptText);
            if(!replacement){
              const userHtml=renderUserMessageWithAttachments(promptText||"已发送附件",attachments),rawText=buildUserMessageContent(promptText,attachments),apiContent=buildUserApiContent(promptText,attachments),message={role:"user",content:apiContent,html:userHtml,rawText,messageIndex};
              quoteContext&&(message.quoteContext=quoteContext);
              userNode=isTargetActive()?addMessage("user",userHtml,{html:!0,rawText,messageIndex,quoteContext}):null;
              userDisplayItem=appendSessionDisplayMessage(sessionId,"user",userHtml,{html:!0,rawText,messageIndex,quoteContext});
              persistSessionDisplay(sessionId);
              if(userNode){userNode.__displayItem=userDisplayItem;userDisplayItem?.id&&(userNode.dataset.displayItemId=userDisplayItem.id)}
              if(isTargetActive()){state.messages.push(message);getActiveSession().messages=cloneMessageList(state.messages)}
              else targetSession.messages=cloneMessageList([...(targetSession.messages||[]),message]);
              persistTargetMessages()
            }
            $("prompt").value="",state.promptDrafts.set(sessionId,""),clearAttachments(),clearQuotedMessage?.(),scheduleAutoResize(),setSessionBusy(sessionId,!0);
            const sessionForReply=isTargetActive()?getActiveSession():targetSession,responseIndex=Array.isArray(sessionForReply?.messages)&&sessionForReply.messages.length?sessionForReply.messages.length:state.messages.length;
            if(replacement){const prepared=prepareReplacementResponse(replacement,sessionId);assistantNode=prepared.node;liveItem=prepared.liveItem}
            else {
              assistantNode=isTargetActive()?addMessage("assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",skipSave:!0}):null;
              if(sessionForReply){liveItem=appendSessionDisplayMessage(sessionId,"assistant",pendingFeedbackHtml("已收到，马上处理"),{html:!0,rawText:"已收到，马上处理",pending:!0,responseIndex});assistantNode&&(assistantNode.__displayItem=liveItem)}
            }
            await prepareUserAttachmentPreviews(attachments);
            if(quotedImageContext?.attachments?.length&&typeof restoreImageAttachmentsFromContext==="function"){
              try{quotedImageAttachments=await restoreImageAttachmentsFromContext(quotedImageContext)}catch(e){console.warn("restore quoted image attachments failed",e),quotedImageAttachments=[]}
            }
            const requestAttachments=quotedImageAttachments.length?[...quotedImageAttachments,...attachments]:attachments;
            const routeUtils=root?.ChatUIServices?.route||root?.ChatUIRouteService||{},buildQuotedRouteContent=routeUtils.buildQuotedRouteContent||(({text="",images=[]}={})=>[String(text||"").replace(/\[base64 image\]/gi,"").replace(/耗时：[^\n]+/g,"").trim(),(images||[]).map((e,i)=>`[quoted_image index=${i+1} id=${e.imageId||e.image_id||""} name=${e.name||""}]`).join("\n")].filter(Boolean).join("\n")||"[quoted_message]"),cleanQuotedContent=routeUtils.cleanQuotedContent||(value=>String(value||"").replace(/\[base64 image\]/gi,"").replace(/耗时：[^\n]+/g,"").trim());
            const hasQuotedMessage=!!quotedMessage,hasQuotedImage=quotedImageAttachments.length>0,quotedReferenceId=quotedImageContext?.referenceId||quotedImageContext?.reference_id||quotedImageContext?.selectedReferenceId||quotedImageContext?.selected_reference_id||"",quotedSelectedIds=quotedImageAttachments.map(e=>e.imageId||e.image_id).filter(Boolean),quotedIndexes=Array.from({length:quotedImageAttachments.length},(_,i)=>i+1),quotedImageSource=(quotedImageContext?.target==="uploaded"||quotedImageContext?.mode==="edit_image")?"uploaded":"previous",quotedFileCandidates=typeof deps?.quotedFileCandidatesFromContext==="function"?deps.quotedFileCandidatesFromContext(quotedMessage?.attachmentContext||quotedMessage?.attachment_context||""):[],quotedTextFromMessage=cleanQuotedContent(quotedMessage?.content||""),quotedPromptFromContext=cleanQuotedContent(quotedImageContext?.prompt||quotedImageContext?.userPrompt||quotedImageContext?.originalPrompt||""),quotedCleanText=quotedTextFromMessage||quotedPromptFromContext,quotedRouteContent=buildQuotedRouteContent({text:quotedCleanText||quotedMessage?.content||"",images:quotedImageAttachments});
            const quotedReferenceSummary=()=>({reference_id:quotedReferenceId||"imgref_quote",source:"quoted",target:quotedImageSource,count:quotedImageAttachments.length});
            const quotedImageCandidates=()=>quotedImageAttachments.map((e,i)=>({index:i+1,image_id:e.imageId||e.image_id||"",reference_id:quotedReferenceId||"imgref_quote",target:quotedImageSource,source:"quoted",filename:e.name||"",prompt:quotedCleanText||""}));
            const buildQuotedRouteContext=()=>({recent_messages:[{index:1,role:quotedMessage?.role||"user",content:quotedRouteContent||"[quoted_message]"}],suggested_contextual_image_prompt:[quotedCleanText,promptText].filter(Boolean).join("\n\n"),latest_user_image_request:null,latest_assistant_image_result:hasQuotedImage&&quotedImageSource==="previous"?quotedReferenceSummary():null,image_candidates:hasQuotedImage?quotedImageCandidates():[],file_candidates:quotedFileCandidates,last_generated_image:null,latest_uploaded_image:hasQuotedImage&&quotedImageSource==="uploaded"?quotedReferenceSummary():null,latest_image_reference:hasQuotedImage?quotedReferenceSummary():null,recent_image_references:[],recent_uploaded_image_references:[]});
            const selectedQuotedEditAttachments=()=>{if(!hasQuotedImage)return requestAttachments;const ids=new Set(routeInfo.selectedImageIds||[]),indexes=new Set(routeInfo.selectedIndexes||[]);return quotedImageAttachments.filter((item,index)=>ids.has(item.imageId||item.image_id)||indexes.has(index+1));};
            const selectedEditAttachments=(sourceAttachments=requestAttachments)=>{const source=(sourceAttachments||[]).filter(item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/"));const ids=new Set(routeInfo.selectedImageIds||[]),indexes=new Set(routeInfo.selectedIndexes||[]);if(!ids.size&&!indexes.size)return source.length===1?source:[];return source.filter((item,index)=>ids.has(item.imageId||item.image_id)||ids.has(item.id)||indexes.has(index+1))};
            const isImageUnderstandingChat=()=>/(图里|图片里|画面|这张图|这张图片|这些图|这些图片|哪张|看图|识别|描述|分析|评价|适合|像什么|是什么|有什么|对比|比较|提取文字|提取.*文字|识别文字|文字识别|读文字|读取文字|ocr|OCR|image|picture|photo|describe|analy[sz]e|what.*(in|on).*image)/i.test(String(promptText||""));
            const isFileUnderstandingChat=()=>/(附件|文件|文档|PDF|pdf|表格|Excel|excel|Word|word|TXT|txt|CSV|csv|内容|里面|其中|多少|几个|几条|统计|数量|列举|列出来|邮箱|邮件|地址|包含|有没有|总结|摘要|提取|分析|翻译|解释|改写|整理|读取|读一下|看一下|这个文件|这个文档|这个附件|这是什么|这个是什么|看看这个|看下这个|说说这个|attachment|file|document|summari[sz]e|extract|analy[sz]e|translate)/i.test(String(promptText||""));
            const selectedChatAttachments=(sourceAttachments=requestAttachments)=>{const source=sourceAttachments||[],images=source.filter(item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/")),files=source.filter(item=>!(typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/")));const picked=[];if(isFileUnderstandingChat())picked.push(...files);if(isImageUnderstandingChat()){const ids=new Set(routeInfo.selectedImageIds||[]),indexes=new Set(routeInfo.selectedIndexes||[]);if(!ids.size&&!indexes.size){if(images.length===1)picked.push(images[0])}else picked.push(...images.filter((item,index)=>ids.has(item.imageId||item.image_id)||ids.has(item.id)||indexes.has(index+1)))}return picked};
            if(!replacement&&((typeof hasImageAttachments==="function"&&hasImageAttachments(attachments))||attachments.some(e=>String(e?.type||e?.file?.type||"").startsWith("image/")))){
              const refreshedUserHtml=renderUserMessageWithAttachments(promptText||"已发送附件",attachments),refreshedRawText=buildUserMessageContent(promptText,attachments),messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message){message.html=refreshedUserHtml;message.rawText=refreshedRawText;quoteContext&&(message.quoteContext=quoteContext)}
              if(userDisplayItem){userDisplayItem.html=refreshedUserHtml;userDisplayItem.rawText=refreshedRawText;quoteContext&&(userDisplayItem.quoteContext=quoteContext);persistSessionDisplay(sessionId)}
              if(userNode?.isConnected){
                if(updateMessage)updateMessage(userNode,refreshedUserHtml,{html:!0,rawText:refreshedRawText,messageIndex,quoteContext,skipSave:!0,noScroll:!0});
                else{const e=userNode.querySelector?.(".content");e&&(e.innerHTML=refreshedUserHtml);quoteContext&&(userNode.dataset.quoteContext=quoteContext)}
              }
              persistTargetMessages()
            }
            if(!replacement){
              const uploadedContext=await buildUploadedImageContext(promptText,attachments),imageContext=uploadedContext?JSON.stringify(uploadedContext):"",attachmentContextValue=await buildUserAttachmentContext(promptText,attachments),attachmentContext=attachmentContextValue?JSON.stringify(attachmentContextValue):"";
              if(userDisplayItem){userDisplayItem.imageContext=imageContext;userDisplayItem.attachmentContext=attachmentContext;persistSessionDisplay(sessionId)}
              const messages=isTargetActive()?state.messages:targetSession.messages||[],message=messages.find(e=>"user"===e?.role&&String(e.messageIndex)===String(messageIndex))||[...messages].reverse().find(e=>"user"===e?.role);
              if(message){imageContext&&(message.imageContext=imageContext);if(attachmentContext){message.attachmentContext=attachmentContext;try{const parsed=JSON.parse(attachmentContext);message.content=parsed.content||buildUserApiContent(promptText,attachments)}catch{message.content=buildUserApiContent(promptText,attachments)}}quoteContext&&(message.quoteContext=quoteContext)}
              if(userNode){imageContext&&(userNode.dataset.imageContext=imageContext);attachmentContext&&(userNode.dataset.attachmentContext=attachmentContext);quoteContext&&(userNode.dataset.quoteContext=quoteContext)}
              persistTargetMessages()
            }
            if(hasQuotedMessage){
              try{routeInfo=await getEffectiveRoute(promptText,[],sessionId,buildRequestHeaders("message",sessionId),buildQuotedRouteContext()),routeMode=routeInfo.mode}catch(e){routeMode="chat",routeInfo=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0,evidence:"引用专用意图识别失败，默认走聊天"},"chat"),console.warn("quoted route failed, fallback to chat:",e)}
              if(hasQuotedImage&&"edit_image"===routeMode){
                if(!(routeInfo.selectedImageIds?.length||routeInfo.selectedIndexes?.length)){routeInfo=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,need_clarification:!0,clarification_question:"请明确要修改引用消息中的哪一张或哪几张图片。",intent:"image_edit",edit_instruction:routeInfo.editInstruction||promptText,confidence:routeInfo.confidence||.6,evidence:"引用图片编辑未能识别具体图片索引"},"chat"),routeMode="chat"}
                else routeInfo=normalizeRoute({...routeInfo,mode:"edit_image",target:quotedImageSource,selected_reference_id:quotedReferenceId||routeInfo.selectedReferenceId,use_previous_image:!1,confidence:routeInfo.confidence||1,evidence:routeInfo.evidence||"引用图片为准，按引用图片执行编辑"},"edit_image"),routeMode="edit_image"
              }else if(!hasQuotedImage&&"edit_image"===routeMode){routeInfo=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:1,evidence:"引用内容不含可编辑图片，改为聊天"},"chat"),routeMode="chat"}
            }else try{routeInfo=await getEffectiveRoute(promptText,requestAttachments,sessionId,buildRequestHeaders("message",sessionId)),routeMode=routeInfo.mode}catch(e){routeMode="chat",routeInfo=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0}),console.warn("route failed, fallback to chat:",e)}
            if(routeInfo.needClarification){const e=routeInfo.clarificationQuestion||"请问你要编辑哪一张图？可以说第一张、第二张，或选择全部。",t={role:"assistant",content:e,rawText:e,responseIndex};typeof updateMessage==="function"&&assistantNode?.isConnected&&updateMessage(assistantNode,e,{rawText:e});liveItem&&(typeof updateSessionDisplayItem==="function"?updateSessionDisplayItem(sessionId,liveItem,"assistant",e,{rawText:e,pending:!1,responseIndex}):(liveItem.content=e,liveItem.rawText=e,liveItem.pending=!1,persistSessionDisplay(sessionId)));isTargetActive()?(state.messages.push(t),sessionForReply.messages=cloneMessageList(state.messages),saveChatHistory()):(targetSession.messages=cloneMessageList([...(targetSession.messages||[]),t]),saveSessionMessages(sessionId,targetSession.messages));return}
            if(run.stopped||run.abortController?.signal?.aborted)return;
            if(isTargetActive()&&updateModeUi(routeMode,state.autoMode),isTargetActive()&&warnMissingModel(routeMode,!0)){
              const message="chat"===routeMode?"请先在设置里选择聊天模型":"请先在设置里选择生图模型";
              return assistantNode?.isConnected?(assistantNode.classList.remove("assistant"),assistantNode.classList.add("error"),(()=>{const e=assistantNode.querySelector(".avatar");e&&(e.textContent="!")})(),updateMessage(assistantNode,message,{rawText:message})):showRunError(sessionId,new Error(message),liveItem,assistantNode),void(liveItem&&updateSessionDisplayItem(sessionId,liveItem,"error",message,{rawText:message,pending:!1}))
            }
            requestBaseMessages=quotedMessage?[quotedMessage]:replacement&&isTargetActive()?state.messages.slice(0,replacement.index):null;
            const routeImagePrompt=String(routeInfo.contextualImagePrompt||"").trim();
            const routeSelectedQuotedImages=()=>selectedChatAttachments(quotedImageAttachments);
            const imagePrompt="image"===routeMode&&routeImagePrompt?routeImagePrompt:quotedMessage&&"image"===routeMode?[quotedCleanText,promptText].filter(Boolean).join("\n\n"):promptText,chatAttachments=quotedMessage?routeSelectedQuotedImages():selectedChatAttachments(requestAttachments),editAttachments=quotedMessage&&"edit_image"===routeMode?selectedQuotedEditAttachments():"edit_image"===routeMode?selectedEditAttachments(requestAttachments):quotedMessage&&"image"===routeMode?[]:requestAttachments;
            if("edit_image"===routeMode&&!editAttachments.length){const e=requestAttachments.filter(item=>typeof isImageFile==="function"?isImageFile(item):String(item?.type||item?.file?.type||"").startsWith("image/")).length>1?"请明确要修改哪一张或哪几张图片。":"没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改。",t={role:"assistant",content:e,rawText:e,responseIndex};typeof updateMessage==="function"&&assistantNode?.isConnected&&updateMessage(assistantNode,e,{rawText:e});liveItem&&(typeof updateSessionDisplayItem==="function"?updateSessionDisplayItem(sessionId,liveItem,"assistant",e,{rawText:e,pending:!1,responseIndex}):(liveItem.content=e,liveItem.rawText=e,liveItem.pending=!1,persistSessionDisplay(sessionId)));isTargetActive()?(state.messages.push(t),sessionForReply.messages=cloneMessageList(state.messages),saveChatHistory()):(targetSession.messages=cloneMessageList([...(targetSession.messages||[]),t]),saveSessionMessages(sessionId,targetSession.messages));return}
            "chat"===routeMode?await sendChat(promptText,chatAttachments,assistantNode,{sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacement?.responseIndex,requestBaseMessages,quotedMessage}):await sendImage(imagePrompt,{loadingNode:assistantNode,editMode:"edit_image"===routeMode,editTarget:routeInfo.target,usePreviousImage:routeInfo.usePreviousImage,selectedIndexes:routeInfo.selectedIndexes,selectedReferenceId:routeInfo.selectedReferenceId,selectedImageIds:routeInfo.selectedImageIds,imageIntent:routeInfo.intent,editInstruction:routeInfo.editInstruction,attachments:editAttachments,imageContext:quotedImageContext||("uploaded"===routeInfo.target?(deps.getUploadedImageContext?deps.getUploadedImageContext(sessionId,routeInfo.selectedReferenceId):getLatestUploadedImageContext(sessionId)):null),routePrompt:imagePrompt,originalPrompt:promptText,sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacement?.responseIndex}),state.editingIndex=null,state.editingNode=null
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
