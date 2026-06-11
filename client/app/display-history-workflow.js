(function initChatUIAppDisplayHistoryWorkflow(root) {
  // Intentionally not strict: display/history bodies are migrated from app.js and resolved through a deps scope.

  function createDisplayHistoryWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function decodeQuoteAttr(value = '') {
      return String(value || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    }

    function extractQuoteContextFromHtml(html = '') {
      const source = String(html || '');
      if (!source.includes('sent-quote-preview')) return '';
      try {
        const doc = deps.document || root?.document;
        if (doc?.createElement) {
          const tpl = doc.createElement('template');
          tpl.innerHTML = source;
          const value = tpl.content.querySelector('.sent-quote-preview')?.dataset?.quoteContext || '';
          if (value) return value;
        }
      } catch {}
      const match = source.match(/class=["'][^"']*sent-quote-preview[^"']*["'][\s\S]*?data-quote-context=(["'])([\s\S]*?)\1/i)
        || source.match(/data-quote-context=(["'])([\s\S]*?)\1[\s\S]*?class=["'][^"']*sent-quote-preview/i);
      return match ? decodeQuoteAttr(match[2]) : '';
    }

    function saveDisplayHistory(e = {}) {
      with (deps) {
        const t=!0===e.includeTransient,s=[...$("messages").querySelectorAll(".message")].filter(e=>t||"0"!==e.dataset.persist).map(e=>{const t=e.querySelector(".content")?.cloneNode(!0);t?.querySelectorAll(".reasoning-panel").forEach(e=>e.remove()),t?.querySelectorAll("[data-image-action-clone]").forEach(e=>e.remove()),t?.querySelectorAll("[data-preview-bound]").forEach(e=>e.removeAttribute("data-preview-bound")),t?.querySelectorAll("[data-download-bound]").forEach(e=>e.removeAttribute("data-download-bound")),t?.querySelectorAll("[data-copy-bound],[data-mermaid-toggle-bound],[data-quote-jump-bound]").forEach(e=>{e.removeAttribute("data-copy-bound"),e.removeAttribute("data-mermaid-toggle-bound"),e.removeAttribute("data-quote-jump-bound")}),t?.querySelectorAll("img[data-persisted-src]").forEach(e=>{e.dataset.originalSrc=e.dataset.persistedSrc,e.removeAttribute("src"),e.classList.remove("image-missing"),e.classList.add("image-restoring"),e.removeAttribute("data-object-url")}),t?.querySelectorAll("a[data-persisted-href]").forEach(e=>{e.setAttribute("href",e.dataset.persistedHref),e.removeAttribute("data-object-url")}),t?.querySelectorAll("button[data-persisted-href]").forEach(e=>{e.removeAttribute("data-object-url")});if("0"===e.dataset.persist&&e.__displayItem)return e.__displayItem;const s=state.reasoningMode&&"1"===e.dataset.keepReasoning&&e.dataset.reasoningText||"",n={id:e.dataset.displayItemId||e.__displayItem?.id||makeDisplayItemId(),role:e.classList.contains("user")?"user":e.classList.contains("error")?"error":"assistant",rawText:e.dataset.rawText||"",html:t?.innerHTML||"",reasoningText:s,keepReasoning:state.reasoningMode&&"1"===e.dataset.keepReasoning,messageIndex:e.dataset.messageIndex||"",responseIndex:e.dataset.responseIndex||e.__displayItem?.responseIndex||"",jobId:e.dataset.jobId||e.__displayItem?.jobId||"",imageContext:e.dataset.imageContext||e.__displayItem?.imageContext||"",attachmentContext:e.dataset.attachmentContext||e.__displayItem?.attachmentContext||"",quoteContext:e.dataset.quoteContext||t?.querySelector?.(".sent-quote-preview")?.dataset?.quoteContext||e.__displayItem?.quoteContext||"",metaText:readMessageMetaText(e),pending:"0"===e.dataset.persist||"1"===e.__displayItem?.pending?"1":""};return e.__displayItem&&!n.pending?(Object.assign(e.__displayItem,n),e.__displayItem):n}).slice(-80),n=getActiveSession();n.display=compactDisplayItems(s.map(sanitizeStoredDisplayItem)).slice(-80),n.updatedAt=Date.now();try{n.display=safeSetJsonStorage(sessionStorageKey(UI_KEY),n.display,80)||[],saveSessionsMeta()}catch(e){console.warn("save display history failed",e)}
      }
    }

    function restorePendingDisplayItems(e, t = []) {
      with (deps) {
        if(!e||!t.length)return;const s=new Set([loadImageJob(e.id)?.id,loadLatestChatJob(e.id)?.id].filter(Boolean)),a=!!(isSessionBusy(e.id)||getActiveRun(e.id)),i=Array.isArray(e.messages)?e.messages.filter(e=>"user"===e?.role).length:0,o=Array.isArray(e.messages)?e.messages.filter(e=>"assistant"===e?.role&&!isChatStatusText(e.content||e.rawText||"")).length:0,r=i>0&&o>=i;r&&clearChatJob(e.id);const d=t=>{if(!isImagePendingDisplayItem(t))return!1;const s=String(t.jobId||""),n=String(t.id||""),a=String(t.responseIndex||"");return(e.messages||[]).some(e=>"assistant"===e?.role&&/^\[图片(生成|编辑|修改)完成\]/.test(String(e.content||""))&&(s&&String(e.imageJobId||"")===s||n&&String(e.displayItemId||"")===n||a&&String(e.responseIndex||"")===a))},c=t=>!isImagePendingDisplayItem(t)&&sessionHasCompletedAssistantForResponse(e,t.responseIndex),m=t=>!!String(t.rawText||"").trim()&&!isChatStatusText(t.rawText||""),l=t=>isImagePendingDisplayItem(t)?!d(t)&&t.jobId&&s.has(t.jobId):!c(t)&&((t.jobId&&s.has(t.jobId))||(!t.jobId&&a)||m(t)),n=t.filter(e=>"1"===e?.pending&&l(e));if(e.display?.length){const t=e.display.length;e.display=e.display.filter(e=>!("1"===e?.pending&&!l(e))),e.display.length!==t&&persistSessionDisplay(e.id)}if(n.length){e.display||=[];for(const t of n){t.id||(t.id=makeDisplayItemId());let s=e.display.find(e=>e.id===t.id);s?Object.assign(s,t):e.display.push(t);if(e.id===state.activeSessionId){let s=null;const n=[...$("messages").querySelectorAll(".message")];t.id&&(s=n.find(e=>e.dataset.displayItemId===t.id)||null),!s&&t.jobId&&(s=n.find(e=>e.dataset.jobId===t.jobId)||null);const a=Number(t.responseIndex);if(!s||Number.isFinite(a)&&a>=0&&s.classList.contains("assistant")&&s.dataset.responseIndex===String(a)&&s.dataset.displayItemId!==t.id){Number.isFinite(a)&&a>=0&&n.find(e=>e.classList.contains("assistant")&&e.dataset.responseIndex===String(a))?.remove(),s=addDisplayItemNode(t),t.jobId&&(s.dataset.jobId=t.jobId);if(Number.isFinite(a)&&a>=0){const e=[...$("messages").querySelectorAll(".message")].find(e=>e!==s&&Number(e.classList.contains("user")?e.dataset.messageIndex:e.dataset.responseIndex)>a);e&&e.parentNode&&e.parentNode.insertBefore(s,e)}}}}e.display=compactDisplayItems(e.display).slice(-80),persistSessionDisplay(e.id)}
      }
    }

    function renderMessageFromCanonical(e, t, s) {
      with (deps) {
        let n=findUserAttachmentDisplayItemForMessage(e,s,t)||findImageDisplayItemForMessage(e,s,t)||findDisplayItemForMessage(e,s,t);n&&t?.metaText&&!n.metaText&&(n={...n,metaText:t.metaText});const q=t?.quoteContext||n?.quoteContext||extractQuoteContextFromHtml(t?.html)||extractQuoteContextFromHtml(n?.html)||"",a=t?.html&&displayItemHasRichMedia(t),o="user"===t.role?t.rawText||t.content:t.content;if(t?.html&&a){const e=addMessage("assistant"===t.role?"assistant":"error"===t.role?"error":"user",t.html,{html:!0,rawText:t.rawText||t.content,metaText:t.metaText||n?.metaText||"",quoteContext:q,messageIndex:"user"===t.role?void 0!==t.messageIndex?t.messageIndex:s:null,responseIndex:"assistant"===t.role?void 0!==t.responseIndex?t.responseIndex:s:null,deferSave:!0,noScroll:!0,deferEnhance:!0});return e.dataset.rawText=t.rawText||t.content,"user"===t.role&&(e.dataset.messageIndex=String(void 0!==t.messageIndex?t.messageIndex:s)),void 0!==t.responseIndex&&""!==t.responseIndex&&(e.dataset.responseIndex=String(t.responseIndex)),(t.displayItemId||n?.id)&&(e.dataset.displayItemId=String(t.displayItemId||n.id)),(t.imageJobId||n?.jobId)&&(e.dataset.imageJobId=String(t.imageJobId||n.jobId)),t.imageContext&&(e.dataset.imageContext=t.imageContext),t.attachmentContext&&(e.dataset.attachmentContext=t.attachmentContext),q&&(e.dataset.quoteContext=q),e}const i=n?addDisplayItemNode({...n,pending:"",quoteContext:q}):addMessage("assistant"===t.role?"assistant":"user",o,{rawText:o,metaText:t.metaText||"",quoteContext:q,messageIndex:"user"===t.role?void 0!==t.messageIndex?t.messageIndex:s:null,responseIndex:"assistant"===t.role?void 0!==t.responseIndex?t.responseIndex:s:null,deferSave:!0,noScroll:!0,lazy:!1,deferEnhance:!1});state.reasoningMode&&t?.reasoning_content&&"assistant"===t.role&&updateReasoning(i,t.reasoning_content,{done:!0,keepReasoning:!0});return i.dataset.rawText=o,"user"===t.role&&(i.dataset.messageIndex=String(void 0!==t.messageIndex?t.messageIndex:s)),"assistant"===t.role&&(i.dataset.responseIndex=String(void 0!==n?.responseIndex&&""!==n.responseIndex?n.responseIndex:void 0!==t.responseIndex?t.responseIndex:s)),q&&(i.dataset.quoteContext=q),i
      }
    }

    return Object.freeze({ saveDisplayHistory, restorePendingDisplayItems, renderMessageFromCanonical });
  }

  const api = Object.freeze({ createDisplayHistoryWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppDisplayHistoryWorkflow = api;
  if (root?.window) root.window.ChatUIAppDisplayHistoryWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
