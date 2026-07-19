(function initChatUIAppBootstrapWorkflow(root) {
  // Intentionally not strict: this module hosts migrated startup/event-binding glue from legacy app.js.

  function createBootstrapWorkflow(deps = {}) {
    let bootReleaseTimer = null;

    function bindPromptInputGuards() {
      const prompt = deps.$?.('prompt');
      if (!prompt || prompt.dataset.inputGuardBound === '1') return;
      prompt.dataset.inputGuardBound = '1';
      const guards = root?.ChatUICorePreflightGuards || {};
      const showRejected = result => deps.toast?.(result?.message || '消息过长，请改为上传文本文件或分段发送');
      const rejectInsertion = (event, inserted) => {
        if (typeof guards.validateMessageInsertion !== 'function') return false;
        const result = guards.validateMessageInsertion({
          current: prompt.value,
          inserted,
          selectionStart: prompt.selectionStart,
          selectionEnd: prompt.selectionEnd,
        });
        if (result.ok) return false;
        event.preventDefault();
        showRejected(result);
        return true;
      };

      prompt.addEventListener('paste', event => {
        const text = event.clipboardData?.getData?.('text/plain');
        if (text) rejectInsertion(event, text);
      }, { capture: true });
      prompt.addEventListener('drop', event => {
        const text = event.dataTransfer?.getData?.('text/plain');
        if (text) rejectInsertion(event, text);
      }, { capture: true });
      prompt.addEventListener('beforeinput', event => {
        if (String(event.inputType || '').startsWith('delete')) return;
        const inserted = event.data ?? (/insert(LineBreak|Paragraph)/.test(String(event.inputType || '')) ? '\n' : null);
        if (inserted !== null) rejectInsertion(event, inserted);
      });
      prompt.addEventListener('input', () => {
        const result = guards.validateMessageSize?.(prompt.value);
        if (result && !result.ok) {
          prompt.value = guards.truncateMessageToLimit?.(prompt.value) || '';
          prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
          showRejected(result);
        }
        deps.scheduleAutoResize?.();
      });
    }
    async function start() {
      try{clearTimeout(bootReleaseTimer);bootReleaseTimer=setTimeout(()=>document.body.classList.remove("app-booting"),1800)}catch{}
      try{
      with (deps) {
        const bindMessageScrollIntent=()=>{const m=$("messages");if(!m||"1"===m.dataset.manualScrollBound)return;m.dataset.manualScrollBound="1";["scroll","wheel","touchstart","touchmove","pointerdown","mousedown"].forEach(t=>m.addEventListener(t,markManualMessageScroll,{passive:!0}));["wheel","touchstart","touchmove"].forEach(t=>window.addEventListener(t,markManualMessageScroll,{passive:!0,capture:!0}))};bindMessageScrollIntent();
        window.ChatUIHistoryAnchorNav?.init?.({messages:$('messages'),nav:$('historyAnchorNav'),document,markManualScroll:markManualMessageScroll,revealNode:revealNodeAboveComposer,getItems:()=>historyAnchorItemsFromState(),ensureItemNode:item=>ensureHistoryAnchorNode(item)});
        ["baseUrl","apiKey","chatModel","routeModel","imageModel","imageSize"].forEach(e=>{$(e).addEventListener("change",()=>saveConfig(!0))}),$("saveConfigBtn").addEventListener("click",()=>saveConfig(!1)),$("loadModelsBtn").addEventListener("click",loadModels),$("toggleApiKeyVisibility")?.addEventListener("click",toggleApiKeyVisibility),$("copyBaseUrlBtn")?.addEventListener("click",()=>copyConfigField("baseUrl")),$("copyApiKeyBtn")?.addEventListener("click",()=>copyConfigField("apiKey")),$("newSessionBtn")?.addEventListener("click",newSession),$("mobileSessionFloatBtn")?.addEventListener("click",openSessionDrawer),$("railExpandBtn")?.addEventListener("click",()=>setSessionSidebarCollapsed(!1)),$("railChatBtn")?.addEventListener("click",()=>setSessionSidebarCollapsed(!1)),$("railNewSessionBtn")?.addEventListener("click",newSession),$("railConfigBtn")?.addEventListener("click",openConfigModal),$("collapseSessionsBtn")?.addEventListener("click",()=>{if(window.matchMedia("(max-width: 840px)").matches)return closeSessionDrawer(),void openConfigModal();setSessionSidebarCollapsed(!document.body.classList.contains("session-sidebar-collapsed"))}),$("sessionDrawerMask")?.addEventListener("click",closeSessionDrawer),$("attachBtn").addEventListener("click",()=>$("fileInput").click()),$("reasoningToggle")?.addEventListener("click",()=>setReasoningMode(!state.reasoningMode)),$("reasoningMenuBtn")?.addEventListener("click",e=>{e.stopPropagation(),toggleReasoningMenu()}),document.querySelectorAll("[data-reasoning-type]")?.forEach(e=>{e.addEventListener("click",t=>{t.stopPropagation(),setReasoningType(e.dataset.reasoningType),state.reasoningMode&&closeReasoningMenu()})}),document.addEventListener("click",closeReasoningMenu),$("fileInput").addEventListener("change",async e=>{await addFiles([...e.target.files]),e.target.value="",updateSendAvailability?.();const t=$("prompt"),s=$("sendBtn"),n=t&&!t.disabled?t:s,o=()=>n?.focus?.();(window.requestAnimationFrame||window.setTimeout).call(window,o,0),window.setTimeout.call(window,o,80)}),$("composer").addEventListener("paste",async e=>{const t=[...e.clipboardData?.files||[]];t.length&&await addFiles(t)}),$("composer").addEventListener("submit",onSubmit),$("sendBtn").addEventListener("click",async e=>{isSessionBusy(state.activeSessionId)&&(e.preventDefault(),e.stopPropagation(),state.suppressNextSubmitStop=!0,await stopActiveRun(state.activeSessionId))}),bindPromptInputGuards(),$("prompt").addEventListener("wheel",scrollPromptByWheel,{passive:!1}),document.querySelector(".input-stack")?.addEventListener("wheel",scrollPromptByWheel,{passive:!1}),window.visualViewport?.addEventListener("resize",()=>{scheduleAutoResize(),scrollToBottom(!1)}),window.addEventListener("resize",()=>{scheduleAutoResize()}),scheduleAutoResize(),$("resumeStreamBtn")?.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();resumeActiveOutputFocus()}),$("prompt").addEventListener("keydown",e=>{"Enter"!==e.key||e.shiftKey||(e.preventDefault(),$("composer").requestSubmit())}),$("imagePreviewClose").addEventListener("click",closeImagePreview),$("imagePreviewDownload")?.addEventListener("click",e=>downloadImageActionElement(e.currentTarget)),$("imagePreviewCopy")?.addEventListener("click",e=>copyImageActionElement(e.currentTarget)),$("imagePreview").addEventListener("click",e=>{("imagePreview"===e.target.id||e.target.classList.contains("image-preview-mask"))&&closeImagePreview()}),$("sidebarConfigBtn")?.addEventListener("click",openConfigModal),$("clearAllSessionsBtn")?.addEventListener("click",clearAllSessions),$("sessionPromptLoadGlobalBtn")?.addEventListener("click",loadGlobalPromptToSessionInput),$("sessionPromptClearBtn")?.addEventListener("click",clearSessionPromptInput),$("sessionPromptCancelBtn")?.addEventListener("click",closeSessionPromptPanel),$("sessionPromptSaveBtn")?.addEventListener("click",saveSessionPrompt),$("sessionImageStyleLoadGlobalBtn")?.addEventListener("click",loadGlobalImageStyleToSessionInput),$("sessionImageStyleClearBtn")?.addEventListener("click",clearSessionImageStyleInput),$("sessionImageStyleCancelBtn")?.addEventListener("click",closeSessionImageStylePanel),$("sessionImageStyleSaveBtn")?.addEventListener("click",saveSessionImageStyle),$("sessionModelCancelBtn")?.addEventListener("click",closeSessionModelPanel),$("sessionModelSaveBtn")?.addEventListener("click",saveSessionModel),$("sessionPromptBtn")?.addEventListener("click",e=>{e.stopPropagation();const t=$("sessionPromptPanel");t?.classList.contains("show")?closeSessionPromptPanel():openSessionPromptPanel()}),$("sessionImageStyleBtn")?.addEventListener("click",e=>{e.stopPropagation();const t=$("sessionImageStylePanel");t?.classList.contains("show")?closeSessionImageStylePanel():openSessionImageStylePanel()}),$("sessionModelBtn")?.addEventListener("click",e=>{e.stopPropagation();const t=$("sessionModelPanel");t?.classList.contains("show")?closeSessionModelPanel():openSessionModelPanel()}),document.addEventListener("click",e=>{const t=$("sessionPromptPanel"),s=$("sessionModelPanel"),a=$("sessionImageStylePanel"),n=e.target;t?.classList.contains("show")&&!t.contains(n)&&!$("sessionPromptBtn")?.contains(n)&&closeSessionPromptPanel(),a?.classList.contains("show")&&!a.contains(n)&&!$("sessionImageStyleBtn")?.contains(n)&&closeSessionImageStylePanel(),s?.classList.contains("show")&&!s.contains(n)&&!$("sessionModelBtn")?.contains(n)&&!n.closest?.(".custom-select")&&closeSessionModelPanel()}),$("closeConfigBtn").addEventListener("click",closeConfigModal),document.querySelectorAll("[data-close-modal]").forEach(e=>e.addEventListener("click",closeConfigModal)),document.addEventListener("click",e=>{e.target.closest?.(".custom-select")||closeAllCustomSelects()}),document.addEventListener("keydown",e=>{"Escape"===e.key&&(closeAllCustomSelects(),closeConfigModal(),closeImagePreview())}),enhanceConfigSelects(),loadConfig(),loadAppVersion(),await loadSessions(),resumeBackgroundSessionJobs(),loadReasoningPreference(),loadSessionSidebarCollapsed(),loadLastGeneratedImage(),Promise.resolve().then(()=>waitForMarkdownReady()).catch(e=>console.warn("markdown ready failed",e)).finally(()=>{try{renderActiveSession(),updateSendAvailability(),updateModeUi(state.mode,state.autoMode)}catch(e){console.warn("bootstrap render failed",e)}finally{(window.requestAnimationFrame||requestAnimationFrame).call(window,()=>{try{clearTimeout(bootReleaseTimer);bootReleaseTimer=null}catch{}document.body.classList.remove("app-booting")})}window.ChatUIMarkdownReady?.then?.(()=>rerenderVisibleMarkdownMessages()).catch?.(e=>console.warn("markdown rerender failed",e))}),window.addEventListener("beforeunload",persistBeforePageLeave),window.addEventListener("pagehide",persistBeforePageLeave),document.addEventListener("visibilitychange",()=>{"visible"===document.visibilityState?refreshActiveSessionOnReturn():persistBeforePageLeave()}),window.addEventListener("pageshow",refreshActiveSessionOnReturn),window.addEventListener("focus",refreshActiveSessionOnReturn);
      }
      }catch(e){throw e}
    }

    return Object.freeze({ start });
  }

  const api = Object.freeze({ createBootstrapWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppBootstrapWorkflow = api;
  if (root?.window) root.window.ChatUIAppBootstrapWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
