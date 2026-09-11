(function initChatUIAppImageActionsWorkflow(root) {
  'use strict';

  function createImageActionsWorkflow(deps = {}) {
    const { document, window, navigator, ClipboardItem, File, Image, URL, fetch, getImageBlob, toast, resetActionButtonState, markActionButtonBusy, restoreActionButtonSoon, openImagePreview, escapeAttr, getImageEditor, applyImageEdit } = deps;
    const fileNames = window?.ChatUIFileNames || root?.ChatUIFileNames;
    function downloadFilename(filename, fallbackStem = 'generated-image', fallbackExt = 'png') {
      return fileNames?.timestampExistingFilename ? fileNames.timestampExistingFilename(filename, { fallbackStem, fallbackExt }) : (filename || `${fallbackStem}.${fallbackExt}`);
    }

    function removeGeneratedImageInlineActions(e){e?.querySelectorAll?.(".content img.generated-thumb").forEach(e=>{let t=e.nextElementSibling;for(;t&&(t.matches?.(".image-icon-btn,[data-download-image],[data-copy-image],[data-share-image],.generated-image-actions")||!String(t.textContent||"").trim()&&0===t.children.length);){const e=t.nextElementSibling;t.remove(),t=e}}),e?.querySelectorAll?.(".content .generated-image-actions").forEach(e=>e.remove())}

    // A single render callback is not enough: messages can appear through
    // lazy rendering, history restore, or attribute updates. Observe the
    // transcript so every generated thumbnail gets its edit toolbar.
    let imageEditToolbarObserver = null;
    function startImageEditToolbarObserver() {
      if (imageEditToolbarObserver || typeof MutationObserver !== 'function') return;
      const host = document.getElementById?.('messages') || document.querySelector?.('#messages');
      if (!host) return;
      const handleNode = node => {
        if (!node || node.nodeType !== 1) return;
        const message = node.classList?.contains('message') ? node : node.closest?.('.message');
        if (message) ensureImageEditToolbar(message);
        if (node.matches?.('img.generated-thumb')) {
          const parentMessage = node.closest?.('.message');
          if (parentMessage) ensureImageEditToolbar(parentMessage);
        }
        node.querySelectorAll?.('.message').forEach(child => ensureImageEditToolbar(child));
      };
      imageEditToolbarObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') { handleNode(mutation.target); continue; }
          mutation.addedNodes?.forEach(handleNode);
        }
      });
      imageEditToolbarObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-persisted-src', 'src'],
      });
    }

    function moveImageActionsToMessageActions(e){startImageEditToolbarObserver();if(!(e.classList.contains("assistant")&&!!e.querySelector("img.generated-thumb")))return;removeGeneratedImageInlineActions(e);const t=e.querySelector(".msg-actions");if(!t)return;t.querySelector(".copy-btn")?.remove(),t.querySelectorAll("[data-image-action-clone]").forEach(e=>e.remove());const s=t.querySelector(".refresh-btn"),n=document.createElement("button");n.className="image-icon-btn icon-action-btn",n.type="button",n.dataset.downloadAllImages="1",n.dataset.imageActionClone="1",n.title="下载全部图片",n.setAttribute("aria-label","下载全部图片"),n.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',n.addEventListener("click",()=>downloadAllImagesFromMessage(e,n)),s?t.insertBefore(n,s):t.appendChild(n),ensureImageEditToolbar(e)}

﻿    const IMAGE_EDIT_TOOLBAR_STYLE_ID = 'chatui-image-edit-toolbar-style';

    const IMAGE_EDIT_TOOLBAR_CSS = '.image-edit-toolbar{display:flex;flex-wrap:nowrap;justify-content:center;gap:2px;margin:0 auto 8px;padding:4px;border-radius:999px;background:rgba(255,255,255,.94);border:1px solid rgba(15,23,42,.08);box-shadow:0 2px 10px rgba(15,23,42,.08);width:max-content;max-width:100%;overflow-x:auto;scrollbar-width:none}'
      + '.image-edit-toolbar::-webkit-scrollbar{display:none}'
      + '.image-edit-toolbar button{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;border:none;background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:5px 8px;border-radius:999px;cursor:pointer}'
      + '.image-edit-toolbar button:hover{background:rgba(15,23,42,.07)}'
      + '.image-edit-toolbar button svg{width:14px;height:14px;flex:none}';

    const IMAGE_EDIT_TOOL_BUTTONS = [
      {
        tool: 'annotate',
        label: '\u6807\u6ce8',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      },
      {
        tool: 'comment',
        label: '\u8bc4\u8bba',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V6a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/></svg>',
      },
      {
        tool: 'remove_background',
        label: '\u79fb\u9664\u80cc\u666f',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m4 4 16 16"/></svg>',
      },
      {
        tool: 'erase',
        label: '\u64e6\u9664',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4-4a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-8 8"/><path d="M13 13 7 7"/></svg>',
      },
      {
        tool: 'resize',
        label: '\u8c03\u6574\u5c3a\u5bf8',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3 14 10"/><path d="M3 21l7-7"/></svg>',
      },
    ];

    function ensureImageEditToolbarStyle() {
      if (!document?.head || document.getElementById?.(IMAGE_EDIT_TOOLBAR_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = IMAGE_EDIT_TOOLBAR_STYLE_ID;
      style.textContent = IMAGE_EDIT_TOOLBAR_CSS;
      document.head.appendChild(style);
    }

    // ChatGPT keeps the edit affordances on the image itself: one compact
    // toolbar above the picture instead of a hidden editor entry. Direct tools
    // (remove background) dispatch immediately; canvas tools open the editor
    // with that tool preselected.
    // Rendered thumbnails lose data-persisted-src whenever the source is still
    // a blob/data URL (stripTransientBlobUrlsFromHtml removes those attributes),
    // so the toolbar must match every generated thumbnail and resolve the blob
    // source lazily when a tool is used.
    function imageSourceForEdit(image) {
      const api = window?.ChatUI?.imageActions || window?.ChatUIImageActions || {};
      if (typeof api.imageEditSource === 'function') return api.imageEditSource(image);
      return String(
        image?.dataset?.persistedSrc
        || image?.dataset?.originalSrc
        || image?.dataset?.persistedUrl
        || image?.dataset?.objectUrl
        || image?.currentSrc
        || image?.src
        || '',
      ).trim();
    }

    function ensureImageEditToolbar(message) {
      if (typeof getImageEditor !== 'function' || typeof applyImageEdit !== 'function') return;
      if (message.querySelector('[data-image-edit-toolbar]')) return;
      const content = message.querySelector('.content');
      const image = content?.querySelector('img.generated-thumb');
      if (!content || !image) return;
      ensureImageEditToolbarStyle();
      const toolbar = document.createElement('div');
      toolbar.className = 'image-edit-toolbar';
      toolbar.dataset.imageEditToolbar = '1';
      for (const entry of IMAGE_EDIT_TOOL_BUTTONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.editTool = entry.tool;
        button.title = entry.label;
        button.setAttribute('aria-label', entry.label);
        button.innerHTML = entry.icon + '<span>' + entry.label + '</span>';
        button.addEventListener('click', () => startImageEditTool(message, button, entry.tool));
        toolbar.appendChild(button);
      }
      const imageActionsApi = window?.ChatUI?.imageActions || window?.ChatUIImageActions || {};
      if (typeof imageActionsApi.insertImageEditToolbar === 'function') {
        imageActionsApi.insertImageEditToolbar(content, toolbar);
      } else if (content.firstChild) {
        content.insertBefore(toolbar, content.firstChild);
      } else {
        content.appendChild(toolbar);
      }
    }

    async function startImageEditTool(message, button, tool) {
      if (tool !== 'remove_background') {
        await openEditorForMessage(message, button, tool);
        return;
      }
      const image = message.querySelector('img.generated-thumb');
      if (!image) {
        toast('\u8fd9\u5f20\u56fe\u7247\u6682\u65f6\u65e0\u6cd5\u7f16\u8f91\uff0c\u8bf7\u91cd\u65b0\u751f\u6210\u540e\u518d\u8bd5');
        return;
      }
      markActionButtonBusy(button);
      try {
        const imageSource = imageSourceForEdit(image);
        if (!imageSource) throw new Error('\u56fe\u7247\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
        const blob = await getImageActionBlob({ dataset: { persistedHref: imageSource }, getAttribute: () => '' });
        await applyImageEdit({
          imageBlob: blob,
          filename: image.dataset.filename || image.alt || 'image.png',
          edit: {
            mode: 'remove_background',
            background: 'transparent',
            output_format: 'png',
            prompt: 'Remove the background and keep the subject cleanly cut out.',
          },
        });
      } catch (error) {
        toast(error?.message || '\u56fe\u7247\u7f16\u8f91\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');
      } finally {
        resetActionButtonState(button);
      }
    }

    async function openEditorForMessage(message, button, tool = '') {
      const image = [...message.querySelectorAll('img.generated-thumb')].pop();
      if (!image) {
        toast('\u8fd9\u5f20\u56fe\u7247\u6682\u65f6\u65e0\u6cd5\u7f16\u8f91\uff0c\u8bf7\u91cd\u65b0\u751f\u6210\u540e\u518d\u8bd5');
        return;
      }
      const editor = getImageEditor();
      if (!editor?.open) {
        toast('\u56fe\u7247\u7f16\u8f91\u5668\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
        return;
      }
      markActionButtonBusy(button);
      try {
        const imageSource = imageSourceForEdit(image);
        if (!imageSource) throw new Error('\u56fe\u7247\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
        const blob = await getImageActionBlob({ dataset: { persistedHref: imageSource }, getAttribute: () => '' });
        const edit = await editor.open(blob, { filename: image.dataset.filename || image.alt || 'image.png', tool });
        if (edit) await applyImageEdit({ imageBlob: blob, filename: image.dataset.filename || image.alt || 'image.png', edit });
      } catch (error) {
        toast(error?.message || '\u56fe\u7247\u7f16\u8f91\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');
      } finally {
        resetActionButtonState(button);
      }
    }

    function downloadImageButtonHtml(e,t){return window.ChatUI.imageActions.downloadImageButtonHtml(e,t,escapeAttr)}

    function shareImageButtonHtml(e,t){return window.ChatUI.imageActions.shareImageButtonHtml(e,t,escapeAttr)}

    function copyImageButtonHtml(e,t){return window.ChatUI.imageActions.copyImageButtonHtml(e,t,escapeAttr)}

    function imageActionButtonsHtml(e,t){return window.ChatUI.imageActions.imageActionButtonsHtml(e,t,escapeAttr)}

    function ensureImageDownloadRow(e){const t=[...e.querySelectorAll("img.generated-thumb[data-persisted-src]")].filter(e=>e.dataset.persistedSrc);if(!t.length)return;let s=e.querySelector(".image-download-row");s||(s=document.createElement("div"),s.className="image-download-row",t[t.length-1].insertAdjacentElement("afterend",s));s.querySelector("[data-download-all-images]")||(s.innerHTML=downloadImageButtonHtml("","generated-images.zip").replace('data-download-image="1"','data-download-all-images="1"').replace("下载图片","下载全部图片"));s.querySelector("[data-download-all-images]")?.addEventListener("click",t=>downloadAllImagesFromMessage(e,t.currentTarget)),s.querySelectorAll("[data-download-image]").forEach(bindImageDownload),s.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),s.querySelectorAll("[data-share-image]").forEach(bindImageShare)}

    async function getImageActionBlob(e){const t=e.dataset.persistedHref||e.getAttribute?.("href")||"";if(t.startsWith("indexeddb://")){const e=await getImageBlob(t.replace("indexeddb://",""));if(!e)throw new Error("图片缓存不存在，请重新生成");return e}if(/^https?:|^data:|^blob:/i.test(t)){const e=await fetch(t);if(e.ok)return e.blob()}throw new Error("图片缓存不存在，请重新生成")}

    async function downloadImageActionElement(e){const t=downloadFilename(e.dataset.filename,"generated-image","png");try{const s=await getImageActionBlob(e),n=URL.createObjectURL(s),a=document.createElement("a");a.href=n,a.download=t,a.rel="noreferrer",document.body.appendChild(a),a.click(),a.remove(),setTimeout(()=>URL.revokeObjectURL(n),3e4)}catch(e){toast(e.message||String(e))}}

    const IMAGE_CLIPBOARD_TYPE="image/png";

    function normalizedImageMimeType(e){return String(e||"").split(";",1)[0].trim().toLowerCase()}

    function clipboardItemSupports(e){try{return typeof ClipboardItem?.supports!=="function"||ClipboardItem.supports(e)}catch{return!1}}

    function canWriteImageClipboard(){return!!window?.isSecureContext&&"function"==typeof navigator?.clipboard?.write&&"function"==typeof ClipboardItem&&clipboardItemSupports(IMAGE_CLIPBOARD_TYPE)}

    function imageClipboardUnsupportedMessage(){return window?.isSecureContext?"当前浏览器不支持复制图片到剪切板":"复制图片需要 HTTPS 或 localhost，当前局域网 HTTP 地址不支持"}

    function imageBlobToClipboardPng(e){if(!e)throw new Error("图片缓存不存在，请重新生成");if(IMAGE_CLIPBOARD_TYPE===normalizedImageMimeType(e.type))return e;return new Promise((t,s)=>{if(typeof Image!=="function"||typeof URL?.createObjectURL!=="function")return s(new Error("图片转换失败"));const n=new Image,a=URL.createObjectURL(e);let i=!1;const o=()=>{a&&URL.revokeObjectURL(a)},r=e=>{if(i)return;i=!0,o(),s(e)},c=e=>{if(i)return;i=!0,o(),t(e)};n.onload=()=>{try{const e=n.naturalWidth||n.width,s=n.naturalHeight||n.height;if(!(e>0&&s>0))throw new Error("图片转换失败");const l=document.createElement("canvas");l.width=e,l.height=s;const a=l.getContext("2d");if(!a)throw new Error("图片转换失败");a.drawImage(n,0,0,e,s),l.toBlob(e=>{e?c(e):r(new Error("图片转换失败"))},IMAGE_CLIPBOARD_TYPE)}catch(e){r(e)}};n.onerror=()=>r(new Error("图片转换失败"));try{n.src=a}catch(e){r(e)}})}

    async function copyImageActionElement(e){try{if(!canWriteImageClipboard())throw new Error(imageClipboardUnsupportedMessage());const t=getImageActionBlob(e).then(imageBlobToClipboardPng),s=new ClipboardItem({[IMAGE_CLIPBOARD_TYPE]:t});await navigator.clipboard.write([s]),toast("图片已复制")}catch(e){toast(e.message||String(e))}}

    async function downloadAllImagesFromMessage(e,t=null){const s=t||e?.querySelector?.("[data-download-all-images],.download-answer-btn");markActionButtonBusy(s);try{const t=[...e?.querySelectorAll?.("img.generated-thumb[data-persisted-src]")||[]].filter(e=>e.dataset.persistedSrc);if(!t.length)return resetActionButtonState(s),void toast("暂无可下载的图片");for(const e of t){const t=document.createElement("button");t.dataset.persistedHref=e.dataset.persistedSrc,t.dataset.filename=downloadFilename(e.dataset.filename,"generated-image","png"),await downloadImageActionElement(t)}restoreActionButtonSoon(s)}catch(e){resetActionButtonState(s),toast(e.message||String(e))}}

    function bindImageDownload(e){e.dataset.downloadBound||(e.dataset.downloadBound="1",e.addEventListener("click",()=>downloadImageActionElement(e)))}

    function bindImageCopy(e){e.dataset.copyBound||(e.dataset.copyBound="1",e.addEventListener("click",()=>copyImageActionElement(e)))}

    function bindImageShare(e){e.dataset.shareBound||(e.dataset.shareBound="1",e.addEventListener("click",async()=>{const t=downloadFilename(e.dataset.filename,"generated-image","png");try{const s=await getImageActionBlob(e),n=new File([s],t,{type:s.type||"image/png"});if(!navigator.share||!navigator.canShare?.({files:[n]}))throw new Error("当前浏览器不支持文件分享");await navigator.share({files:[n],title:t})}catch(e){if("AbortError"===e?.name)return;toast(e.message||String(e))}}))}

    function previewItemFromImage(image) {
      return {
        source: image?.dataset?.persistedSrc || image?.dataset?.originalSrc || image?.dataset?.persistedUrl || image?.currentSrc || image?.src || '',
        filename: image?.dataset?.filename || image?.alt || 'image.png',
      };
    }

    function previewItemsFromConversation(message) {
      const messages = document?.getElementById?.('messages') || message?.closest?.('#messages') || message;
      return [...messages.querySelectorAll('.message .content img, .content img')]
        .filter(image => !image.classList?.contains?.('clarification-choice-image'))
        .map(previewItemFromImage)
        .filter(item => item.source);
    }

    function openMessageImagePreview(message, image) {
      const items = previewItemsFromConversation(message);
      const selected = previewItemFromImage(image);
      const index = Math.max(0, items.findIndex(item => item.source === selected.source));
      return openImagePreview(selected.source, selected.filename, { items, index });
    }

    function bindImagePreview(e){
      e.querySelectorAll("[data-download-image]").forEach(bindImageDownload),e.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),e.querySelectorAll("[data-share-image]").forEach(bindImageShare);
      e.querySelectorAll(".content img").forEach(img=>{if(img.classList?.contains?.("clarification-choice-image")||"1"===img.dataset.previewBound)return;img.dataset.previewBound="1";img.addEventListener("click",event=>{event.stopPropagation();openMessageImagePreview(e,img)})});
      e.querySelectorAll(".generated-image-item").forEach(item=>{if("1"!==item.dataset.previewBound){item.dataset.previewBound="1";item.addEventListener("click",event=>{if(event.target?.closest?.("button,a"))return;const img=item.querySelector("img.generated-thumb");img&&openMessageImagePreview(e,img)})}})
    }

    return Object.freeze({ removeGeneratedImageInlineActions, moveImageActionsToMessageActions, downloadImageButtonHtml, shareImageButtonHtml, copyImageButtonHtml, imageActionButtonsHtml, ensureImageDownloadRow, getImageActionBlob, downloadImageActionElement, canWriteImageClipboard, imageClipboardUnsupportedMessage, copyImageActionElement, downloadAllImagesFromMessage, bindImageDownload, bindImageCopy, bindImageShare, bindImagePreview });
  }

  const api = Object.freeze({ createImageActionsWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageActionsWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageActionsWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
