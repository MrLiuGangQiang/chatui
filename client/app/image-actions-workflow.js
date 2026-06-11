(function initChatUIAppImageActionsWorkflow(root) {
  'use strict';

  function createImageActionsWorkflow(deps = {}) {
    const { document, window, navigator, ClipboardItem, File, Image, URL, fetch, getImageBlob, toast, resetActionButtonState, markActionButtonBusy, restoreActionButtonSoon, openImagePreview, escapeAttr } = deps;

    function removeGeneratedImageInlineActions(e){e?.querySelectorAll?.(".content img.generated-thumb").forEach(e=>{let t=e.nextElementSibling;for(;t&&(t.matches?.(".image-icon-btn,[data-download-image],[data-copy-image],[data-share-image],.generated-image-actions")||!String(t.textContent||"").trim()&&0===t.children.length);){const e=t.nextElementSibling;t.remove(),t=e}}),e?.querySelectorAll?.(".content .generated-image-actions").forEach(e=>e.remove())}

    function moveImageActionsToMessageActions(e){if(!(e.classList.contains("assistant")&&!!e.querySelector("img.generated-thumb")))return;removeGeneratedImageInlineActions(e);const t=e.querySelector(".msg-actions");if(!t)return;t.querySelector(".copy-btn")?.remove(),t.querySelectorAll("[data-image-action-clone]").forEach(e=>e.remove());const s=t.querySelector(".refresh-btn"),n=document.createElement("button");n.className="image-icon-btn icon-action-btn",n.type="button",n.dataset.downloadAllImages="1",n.dataset.imageActionClone="1",n.title="下载全部图片",n.setAttribute("aria-label","下载全部图片"),n.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',n.addEventListener("click",()=>downloadAllImagesFromMessage(e,n)),s?t.insertBefore(n,s):t.appendChild(n)}

    function downloadImageButtonHtml(e,t){return window.ChatUI.imageActions.downloadImageButtonHtml(e,t,escapeAttr)}

    function shareImageButtonHtml(e,t){return window.ChatUI.imageActions.shareImageButtonHtml(e,t,escapeAttr)}

    function copyImageButtonHtml(e,t){return window.ChatUI.imageActions.copyImageButtonHtml(e,t,escapeAttr)}

    function imageActionButtonsHtml(e,t){return window.ChatUI.imageActions.imageActionButtonsHtml(e,t,escapeAttr)}

    function ensureImageDownloadRow(e){const t=[...e.querySelectorAll("img.generated-thumb[data-persisted-src]")].filter(e=>e.dataset.persistedSrc);if(!t.length)return;let s=e.querySelector(".image-download-row");s||(s=document.createElement("div"),s.className="image-download-row",t[t.length-1].insertAdjacentElement("afterend",s));s.querySelector("[data-download-all-images]")||(s.innerHTML=downloadImageButtonHtml("","generated-images.zip").replace('data-download-image="1"','data-download-all-images="1"').replace("下载图片","下载全部图片"));s.querySelector("[data-download-all-images]")?.addEventListener("click",t=>downloadAllImagesFromMessage(e,t.currentTarget)),s.querySelectorAll("[data-download-image]").forEach(bindImageDownload),s.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),s.querySelectorAll("[data-share-image]").forEach(bindImageShare)}

    async function getImageActionBlob(e){const t=e.dataset.persistedHref||e.getAttribute?.("href")||"";if(t.startsWith("indexeddb://")){const e=await getImageBlob(t.replace("indexeddb://",""));if(!e)throw new Error("图片缓存不存在，请重新生成");return e}if(/^https?:|^data:|^blob:/i.test(t)){const e=await fetch(t);if(e.ok)return e.blob()}throw new Error("图片缓存不存在，请重新生成")}

    async function downloadImageActionElement(e){const t=e.dataset.filename||"generated-image.png";try{const s=await getImageActionBlob(e),n=URL.createObjectURL(s),a=document.createElement("a");a.href=n,a.download=t,a.rel="noreferrer",document.body.appendChild(a),a.click(),a.remove(),setTimeout(()=>URL.revokeObjectURL(n),3e4)}catch(e){toast(e.message||String(e))}}

    function canWriteImageClipboard(){return window.isSecureContext&&!!navigator.clipboard?.write&&"function"==typeof ClipboardItem}

    function imageClipboardUnsupportedMessage(){return window.isSecureContext?"当前浏览器不支持复制图片到剪切板":"复制图片需要 HTTPS 或 localhost，当前局域网 HTTP 地址不支持"}

    async function copyImageActionElement(e){try{if(!canWriteImageClipboard())throw new Error(imageClipboardUnsupportedMessage());const t=await getImageActionBlob(e),s=t.type&&/^image\//i.test(t.type)?t.type:"image/png",n="image/png"===s?t:await new Promise((e,n)=>{const a=new Image,i=URL.createObjectURL(t);a.onload=()=>{try{const t=document.createElement("canvas");t.width=a.naturalWidth||a.width,t.height=a.naturalHeight||a.height,t.getContext("2d").drawImage(a,0,0),t.toBlob(t=>{URL.revokeObjectURL(i),t?e(t):n(new Error("图片转换失败"))},"image/png")}catch(e){URL.revokeObjectURL(i),n(e)}},a.onerror=()=>{URL.revokeObjectURL(i),n(new Error("图片转换失败"))},a.src=i});await navigator.clipboard.write([new ClipboardItem({[n.type||"image/png"]:n})]),toast("图片已复制")}catch(e){toast(e.message||String(e))}}

    async function downloadAllImagesFromMessage(e,t=null){const s=t||e?.querySelector?.("[data-download-all-images],.download-answer-btn");markActionButtonBusy(s);try{const t=[...e?.querySelectorAll?.("img.generated-thumb[data-persisted-src]")||[]].filter(e=>e.dataset.persistedSrc);if(!t.length)return resetActionButtonState(s),void toast("暂无可下载的图片");for(const e of t){const t=document.createElement("button");t.dataset.persistedHref=e.dataset.persistedSrc,t.dataset.filename=e.dataset.filename||"generated-image.png",await downloadImageActionElement(t)}restoreActionButtonSoon(s)}catch(e){resetActionButtonState(s),toast(e.message||String(e))}}

    function bindImageDownload(e){e.dataset.downloadBound||(e.dataset.downloadBound="1",e.addEventListener("click",()=>downloadImageActionElement(e)))}

    function bindImageCopy(e){e.dataset.copyBound||(e.dataset.copyBound="1",e.addEventListener("click",()=>copyImageActionElement(e)))}

    function bindImageShare(e){e.dataset.shareBound||(e.dataset.shareBound="1",e.addEventListener("click",async()=>{const t=e.dataset.filename||"generated-image.png";try{const s=await getImageActionBlob(e),n=new File([s],t,{type:s.type||"image/png"});if(!navigator.share||!navigator.canShare?.({files:[n]}))throw new Error("当前浏览器不支持文件分享");await navigator.share({files:[n],title:t})}catch(e){if("AbortError"===e?.name)return;toast(e.message||String(e))}}))}

    function bindImagePreview(e){
      e.querySelectorAll("[data-download-image]").forEach(bindImageDownload),e.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),e.querySelectorAll("[data-share-image]").forEach(bindImageShare);
      e.querySelectorAll(".content img").forEach(img=>{if("1"!==img.dataset.previewBound){img.dataset.previewBound="1";img.addEventListener("click",()=>openImagePreview(img.dataset.persistedSrc||img.dataset.originalSrc||img.dataset.persistedUrl||img.currentSrc||img.src,img.dataset.filename||img.alt||"image.png"))}});
      e.querySelectorAll(".generated-image-item").forEach(item=>{if("1"!==item.dataset.previewBound){item.dataset.previewBound="1";item.addEventListener("click",event=>{if(event.target?.closest?.("button,a"))return;const img=item.querySelector("img.generated-thumb");img&&openImagePreview(img.dataset.persistedSrc||img.dataset.originalSrc||img.dataset.persistedUrl||img.currentSrc||img.src,img.dataset.filename||img.alt||"image.png")})}})
    }

    return Object.freeze({ removeGeneratedImageInlineActions, moveImageActionsToMessageActions, downloadImageButtonHtml, shareImageButtonHtml, copyImageButtonHtml, imageActionButtonsHtml, ensureImageDownloadRow, getImageActionBlob, downloadImageActionElement, canWriteImageClipboard, imageClipboardUnsupportedMessage, copyImageActionElement, downloadAllImagesFromMessage, bindImageDownload, bindImageCopy, bindImageShare, bindImagePreview });
  }

  const api = Object.freeze({ createImageActionsWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageActionsWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageActionsWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
